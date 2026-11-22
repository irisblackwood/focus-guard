/**
 * 第 1.3 层：动笔闸（2026-10-18 人类批示；2026-10-27 从 pipeline.mjs 抽出，纯搬运）。
 *
 * 规则：模糊开发任务（非闲聊）在**未加载方法论技能**前，不许动笔。
 * 为什么拦「动笔」而不是「首轮输出」：DSH 没有 beforeSubmit 缝；而 `agent/pre-step`
 * 直接 reject 整轮会把回合打死（DCR 就这么死过，同日卸载）。动笔闸是同一意图的可执行版。
 * 判定三件套：开发动词 + 模糊标记 + 无验收词。缺一不判，宁可漏也不误伤闲聊。
 *
 * **自带方法论（2026-11-20 改）**：此前本层只认 `brainstorming` / `writing-plans`，
 * 而这两个**不在 FG 包里**——来自宿主的 `customSkillDirs`。没装的用户只能「拒一次再放行」，
 * 闸门于是降级成一条噪音。现在 FG 自带 `skills/focus-plan`，闸门认它，依赖消失。
 *
 * 为什么不把 superpowers 那两份内置进来：它们不是能力，是两份 markdown 提示词，
 * 但 `writing-plans` 里写着 `superpowers:executing-plans` / `subagent-driven-development`，
 * 内置等于内置一条断头链路（下游四个技能我们都不带）；且宿主技能按 name 索引，
 * 内置的 `brainstorming` 会和已装的那份撞名，上游一改还得我们跟。
 * 自研只回答 FG 需要的那一件事：动笔前把模糊任务拆成带验收判据的步骤。
 *
 * 兼容面：白名单之外，任何名字里带 plan / brainstorm / design / spec 的技能也算——
 * 用户装的可能是别家的方法论技能。只认自己的名字，等于把依赖又写回判据里。
 */
import { existsSync } from 'node:fs'
import { MUTATOR_HEAD_RE } from '../../core/redlines.mjs'
import { statePath as guardStateFile, loadState, saveState } from '../../core/state.mjs'
import { auditDeny } from '../audit.mjs'
import { sessionIdOf } from './tooling.mjs'

/** FG 自带 + 已装 superpowers 的两份。名字本身是方法论技能的，走下面的形态识别。 */
const METHODOLOGY_SKILLS = /^(?:focus-plan|brainstorming|writing-plans)$/i
const METHODOLOGY_WORDS = new Set([
  'plan',
  'plans',
  'planning',
  'brainstorm',
  'brainstorming',
  'design',
  'spec',
  'specs',
  'blueprint',
])
const SP_MUTATORS = /^(?:write|edit|multiedit|str_replace_editor|apply_patch)$/i
const SP_DEV_VERB = /(实现|开发|重构|优化|修复|改造|迁移|重写|升级|接入|搭建|新增|加个|加上|补上|改一下|改改)/
const SP_VAGUE = /(一下|顺手|更好|顺便|提升|优化|性能|体验|好看|清理|整理|完善)/
// 验收词 = "这条请求已经说清了怎么算完成"。2026-11-20 补量化指标一类：
// 原先只认「验收/测试/行号/阈值」这类**词**，于是「优化一下性能，p95 要低于 20ms」被判成模糊任务——
// 用户已经给了硬指标却被拦，是误伤。补 pXX 与带单位的数字，让"说了怎么验"的请求直接过。
const SP_ACCEPT =
  /(验收|测试|命令|报错|复现|接口|字段|路径|行号|截图|日志|表结构|阈值|标准|N\s*=|p\d{2}|\d+\s*(?:ms|s|%|MB|KB)|\d+\s*(?:条|行|个|倍))/

/** 本层开关：`FG_WRITING_GATE=off` 关闭（2026-11-20）。默认开——模糊任务拒一次是设计意图，不是 bug。 */
export function writingGateEnabled() {
  return String(process.env.FG_WRITING_GATE || '').trim().toLowerCase() !== 'off'
}

/**
 * 这个名字算不算「方法论技能」。
 * 按 token 切分再比对，不用子串匹配——`/spec/` 会把 `inspect` 也算进去。
 */
export function isMethodologySkill(name) {
  const s = String(name || '').trim().toLowerCase()
  if (!s) return false
  if (METHODOLOGY_SKILLS.test(s)) return true
  return s.split(/[-_\s/:.]+/).some((w) => METHODOLOGY_WORDS.has(w))
}

export function isVagueDevTask(prompt) {
  const text = String(prompt || '').trim()
  if (text.length < 6) return false
  return SP_DEV_VERB.test(text) && SP_VAGUE.test(text) && !SP_ACCEPT.test(text)
}

/** 本轮提示的稳定戳：只存长度+前缀，不把整段 prompt 写进状态文件。 */
export function promptStamp(prompt) {
  const text = String(prompt || '')
  return `${text.length}:${text.slice(0, 48)}`
}

/** pre-execute 阶段：模糊开发任务未加载方法论即动笔 → 拒一次；异常 fail-open 继续。 */
export async function writingGateStage(ctx) {
  if (!writingGateEnabled()) return null
  const { exec, warn, cmd } = ctx
  try {
    const spFile = guardStateFile(sessionIdOf(exec))
    const spState = existsSync(spFile) ? loadState(spFile) : null
    const spPrompt = String((spState && (spState.turnPromptFull || spState.turnPrompt)) || '')
    if (spState && isVagueDevTask(spPrompt)) {
      const stamp = promptStamp(spPrompt)
      const spTool = String((exec && exec.name) || '')
      const spArgs = (exec && exec.arguments) || {}
      // 模型已加载方法论 → 本轮放行并记住
      if (/^skill$/i.test(spTool) && isMethodologySkill(spArgs.name || spArgs.skill)) {
        spState.spLoadedFor = stamp
        saveState(spFile, spState)
        return ctx.next()
      }
      if (spState.spLoadedFor === stamp) return ctx.next()
      const mutating = SP_MUTATORS.test(spTool) || (cmd && MUTATOR_HEAD_RE.test(cmd))
      if (mutating && spState.spDeniedFor !== stamp) {
        spState.spDeniedFor = stamp
        saveState(spFile, spState)
        warn('动笔闸：', `模糊开发任务未加载方法论即动笔（${spTool || 'shell'}）`)
        auditDeny(exec, `动笔前置：${spTool || 'shell'}`, { trigger: 'writing-gate:deny' })
        return {
          kind: 'deny',
          reason:
            'focus-guard-native: [动笔闸] 这是模糊开发任务，先别动笔。' +
            '先加载 focus-plan 技能（skill 工具，name=focus-plan）把目的/边界/验收问清并拆步，再重试；' +
            '装了 superpowers 的可用 brainstorming / writing-plans；' +
            '任务其实已说清怎么验收 → 直接重试即放行（本层只拒一次），或 FG_WRITING_GATE=off 永久关闭本层。',
        }
      }
    }
  } catch (error) {
    warn('动笔闸异常，fail-open 放行：', (error && error.message) || error)
  }
  return null
}
