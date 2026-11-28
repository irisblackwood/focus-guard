/**
 * ② `system-prompt/assemble` → 常驻规则注入（与 pipeline 的成本提示行并列）。
 *
 * 这是 guard.mjs 的 `SESSION_RULES` 在 DSH 原生插件里的落点——原文经 stdout 的
 * `hookSpecificOutput.additionalContext` 输出，原生插件无此契约，故改走注入缝。
 * 追加为独立 section，不改动下游既有 section。
 *
 * 2026-10-27 拆分：从 `seams.mjs` 原样搬出（嵌套 6 层），把 section 追加抽成
 * `withRulesSection`，**判定与透传语义一字未改**。
 */
import { SESSION_RULES } from '../../core/constants.mjs'
import { pendingPatternStubs } from '../../core/patterns.mjs'
import { probeShells } from '../../core/env.mjs'
import { projDirOf } from './shared.mjs'

export function systemPromptRulesListener({ warn } = {}) {
  return async (assembly, context, next) => {
    let downstream
    try {
      downstream = await next()
      // 顺序有意：常量段（执行体）在前，可变段（经验库）垫尾。
      // section 是按序拼接的，把「会消失的那段」放最后，它消失时前缀不跟着变。
      return withRulesSection(downstream, [
        ['focus-guard-env', execNotice()],
        ['focus-guard-patterns', patternsNotice(context)],
      ])
    } catch (error) {
      if (typeof warn === 'function') warn('常驻规则注入异常（不阻塞）:', (error && error.message) || error)
      return downstream
    }
  }
}

/**
 * 执行体约束（2026-11-28）。
 *
 * 病根：`platform-deny` 拦得对，但**只拦不前置**。实测 19 天审计日志：
 * bash 里敲 `Select-Object` 被拦 11 次（跨 8 个回合、跨 2 天），pwsh 里用 `&&`
 * 被拦 8 次（跨 6 个回合）。不是同一回合试错——是跨回合遗忘。
 * 拦下只改当次调用，改不了下一回合的默认写法，于是同一条命令被拦第二遍。
 *
 * 为什么独立 section 而不写进 `SESSION_RULES`：那段是逐字镜像，222 字基准被
 * `RULES.md` 第四部分与 `BENCH.md` 同时锁着，改它要动三处口径；而且它对所有平台
 * 都成立，塞进平台专用文本会让非 Windows 用户白付这段字。
 *
 * 为什么按「本机有没有这个 shell」生成、不按会话：`shellIdForTool` 已经确立了
 * 「执行体按工具判」——同一会话 bash / PowerShell 可以并存（本机就是）。所以这段
 * 描述的是**闸门会怎么判**，不是「你这个会话是什么」。两者混着写，迟早对不上。
 *
 * 字节稳定：模块级 lazy 常量，本进程只算一次；非 Windows 返回空串，零注入成本。
 */
let execNoticeCache
function execNotice() {
  if (execNoticeCache !== undefined) return execNoticeCache
  execNoticeCache = ''
  try {
    if (process.platform !== 'win32') return execNoticeCache
    const shells = probeShells()
    const parts = []
    if (shells.includes('bash')) {
      parts.push('bash 工具跑 bash：Select-Object / Get-ChildItem 等 PowerShell cmdlet 不存在，改用 cat / grep / sed / tee')
    }
    if (shells.includes('powershell') || shells.includes('pwsh7')) {
      parts.push('PowerShell 工具禁 &&（用 ; 分隔）与 bash 管道')
    }
    if (parts.length) execNoticeCache = `【执行体】${parts.join('；')}。拦下≠环境故障。`
  } catch {
    execNoticeCache = ''
  }
  return execNoticeCache
}

/**
 * 经验库「教训」待补提醒（2026-11-08）。
 *
 * 病根：`appendPatternStub` 在熔断时写下骨架，`- 教训：<待补…>` 那一行**没有任何机制促使回填**。
 * 建库 27 天零条是第一层（写不进去），补上写入之后是第二层（写进去也永远空着）——
 * 骨架不是经验，而模型看不见"还欠几笔"。
 *
 * 只在**真有未回填**时才追加一段：干净时零成本，清完自动消失；不写进 `SESSION_RULES`
 * 常驻文本（那会变成每步都付的固定开销）。判断仍归模型，引擎只报数。
 */
function patternsNotice(context) {
  try {
    const n = pendingPatternStubs(projDirOf(context && context.agent))
    if (!n) return ''
    return (
      `【经验库】.ai/PATTERNS.md 有 ${n} 条「教训」未回填。` +
      '收尾前把它写成「以后遇到 X 必须先做 Y」——骨架不算经验，未清不算结项。'
    )
  } catch {
    return ''
  }
}

/**
 * 下游是预期 assembly 形状时追加独立 section；否则原样透传（不强行改写）。
 *
 * `extras` 是 `[段名, 文本]` 对：文本为空即跳过，所以「本机不适用」的段一个字节都不占。
 */
function withRulesSection(downstream, extras = []) {
  if (downstream && typeof downstream === 'object' && Array.isArray(downstream.sections)) {
    const sections = [...downstream.sections, { name: 'focus-guard-rules', text: SESSION_RULES }]
    for (const [name, text] of extras) if (text) sections.push({ name, text })
    return { ...downstream, sections }
  }
  return downstream
}
