/**
 * focus-guard 原生 Cordis 插件 · 薄装配层（3.0.5）
 *
 * 职责只余 name + apply：把 pipeline.mjs 的三缝监听注册到宿主 ctx。
 *   判定流水线 → ./pipeline.mjs（pre-execute 拦截 / system-prompt 成本提示 / post-execute 台账）
 *   卷宗写入   → ./audit.mjs（AUDIT.log 留痕 / CASE_FILE 成本台账）
 *   价目与峰谷 → ../peak-cost.mjs（官方 2026-09-10 价目，核对底稿见 docs/deepseek-pricing-audit.md）
 *
 * fail-open 纪律：任一缝注册失败只降级该缝，绝不阻塞 DSH 主流程；
 * 拆薄前的单文件实现备份于 .ai/backup/index.js.bak-20261007-peakcost。
 */

import { postExecuteListener, preExecuteListener, systemPromptListener } from './pipeline.mjs'
import { preStepListener, sessionStartListener, systemPromptRulesListener, turnStoppingListener } from './seams.mjs'
import { postProgressListener } from './postProgress.mjs'
import { stopGuardListener } from './stopGuard.mjs'

export const name = 'focus-guard'

export function apply(ctx) {
  const warn = (...parts) => {
    console.warn('[focus-guard-native]', ...parts)
    if (ctx && typeof ctx.logger?.warn === 'function') ctx.logger.warn(...parts)
  }
  const register = (event, factory, label) => {
    try {
      ctx.on(event, factory({ warn }))
    } catch (error) {
      warn(label + ' 注册失败（不影响其他缝）：', (error && error.message) || error)
    }
  }

  register('tools/pre-execute', preExecuteListener, 'tools/pre-execute')
  register('system-prompt/assemble', systemPromptListener, 'system-prompt/assemble')
  // 3.0.8 移植批 4：常驻规则注入（guard.mjs 的 SESSION_RULES，原文走 stdout，原生改走注入缝）
  register('system-prompt/assemble', systemPromptRulesListener, 'system-prompt/assemble(rules)')
  register('tools/post-execute', postExecuteListener, 'tools/post-execute')
  // 3.0.8 移植批 3：进度检测 / 三预算池 / 污染检测 / 委派 KPI / 抽查（与上条同事件并列监听）
  register('tools/post-execute', postProgressListener, 'tools/post-execute(progress)')
  // 3.0.8：补上 guard.mjs 六缝中 DSH 侧缺失的三条。映射照官方桥
  //（@deepseek-ai/dsh-hooks-claude-code）的实测代码，不是猜测。
  register('agent/created', sessionStartListener, 'agent/created')
  register('agent/pre-step', preStepListener, 'agent/pre-step')
  register('agent/turn-stopping', turnStoppingListener, 'agent/turn-stopping')
  // 3.0.8 移植批 4：收尾核验（授权识别 / 熔断声明 / 无锚点）——与上条 KPI 结算并列监听
  register('agent/turn-stopping', stopGuardListener, 'agent/turn-stopping(guard)')
}
