/**
 * 第 1.3 层：Superpowers 动笔闸（2026-10-18 人类批示；2026-10-27 从 pipeline.mjs 抽出，纯搬运）。
 *
 * 规则：模糊开发任务（非闲聊）在**未加载方法论技能**前，不许动笔。
 * 为什么拦「动笔」而不是「首轮输出」：DSH 没有 beforeSubmit 缝；而 `agent/pre-step`
 * 直接 reject 整轮会把回合打死（DCR 就这么死过，同日卸载）。动笔闸是同一意图的可执行版。
 * 判定三件套：开发动词 + 模糊标记 + 无验收词。缺一不判，宁可漏也不误伤闲聊。
 */
import { existsSync } from 'node:fs'
import { MUTATOR_HEAD_RE } from '../../core/redlines.mjs'
import { statePath as guardStateFile, loadState, saveState } from '../../core/state.mjs'
import { auditDeny } from '../audit.mjs'
import { sessionIdOf } from './tooling.mjs'

const SP_SKILLS = /^(?:brainstorming|writing-plans)$/i
const SP_MUTATORS = /^(?:write|edit|multiedit|str_replace_editor|apply_patch)$/i
const SP_DEV_VERB = /(实现|开发|重构|优化|修复|改造|迁移|重写|升级|接入|搭建|新增|加个|加上|补上|改一下|改改)/
const SP_VAGUE = /(一下|顺手|更好|顺便|提升|优化|性能|体验|好看|清理|整理|完善)/
const SP_ACCEPT = /(验收|测试|命令|报错|复现|接口|字段|路径|行号|截图|日志|表结构|阈值|标准|N\s*=)/

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
export async function superpowersStage(ctx) {
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
      if (/^skill$/i.test(spTool) && SP_SKILLS.test(String(spArgs.name || spArgs.skill || ''))) {
        spState.spLoadedFor = stamp
        saveState(spFile, spState)
        return ctx.next()
      }
      if (spState.spLoadedFor === stamp) return ctx.next()
      const mutating = SP_MUTATORS.test(spTool) || (cmd && MUTATOR_HEAD_RE.test(cmd))
      if (mutating && spState.spDeniedFor !== stamp) {
        spState.spDeniedFor = stamp
        saveState(spFile, spState)
        warn('Superpowers 动笔闸：', `模糊开发任务未加载方法论即动笔（${spTool || 'shell'}）`)
        auditDeny(exec, `动笔前置：${spTool || 'shell'}`, { trigger: 'superpowers:writing-gate' })
        return {
          kind: 'deny',
          reason:
            'focus-guard-native: [Superpowers] 这是模糊开发任务，先别动笔。' +
            '请先调用 brainstorming 或 writing-plans 工具（skill 工具，name 为其中之一），' +
            '确认需求并给出计划后再改代码。本次只拒一次，重试即放行。',
        }
      }
    }
  } catch (error) {
    warn('Superpowers 动笔闸异常，fail-open 放行：', (error && error.message) || error)
  }
  return null
}
