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

export function systemPromptRulesListener({ warn } = {}) {
  return async (assembly, context, next) => {
    let downstream
    try {
      downstream = await next()
      return withRulesSection(downstream)
    } catch (error) {
      if (typeof warn === 'function') warn('常驻规则注入异常（不阻塞）:', (error && error.message) || error)
      return downstream
    }
  }
}

/** 下游是预期 assembly 形状时追加独立 section；否则原样透传（不强行改写）。 */
function withRulesSection(downstream) {
  if (downstream && typeof downstream === 'object' && Array.isArray(downstream.sections)) {
    return { ...downstream, sections: [...downstream.sections, { name: 'focus-guard-rules', text: SESSION_RULES }] }
  }
  return downstream
}
