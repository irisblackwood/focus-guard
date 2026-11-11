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
import { projDirOf } from './shared.mjs'

export function systemPromptRulesListener({ warn } = {}) {
  return async (assembly, context, next) => {
    let downstream
    try {
      downstream = await next()
      return withRulesSection(downstream, patternsNotice(context))
    } catch (error) {
      if (typeof warn === 'function') warn('常驻规则注入异常（不阻塞）:', (error && error.message) || error)
      return downstream
    }
  }
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

/** 下游是预期 assembly 形状时追加独立 section；否则原样透传（不强行改写）。 */
function withRulesSection(downstream, extra) {
  if (downstream && typeof downstream === 'object' && Array.isArray(downstream.sections)) {
    const sections = [...downstream.sections, { name: 'focus-guard-rules', text: SESSION_RULES }]
    if (extra) sections.push({ name: 'focus-guard-patterns', text: extra })
    return { ...downstream, sections }
  }
  return downstream
}
