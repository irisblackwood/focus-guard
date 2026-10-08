/**
 * focus-guard 适配层 · fg_apply 工具注册（3.0.5 第二步·入口一）
 *
 * 契约来源：装机 dsh-tools 的 defineTool —— 字段为
 *   defineTool({ name, description, parameters, output?, execute(args, exec), render?, presentCall? })
 * 见 @deepseek-ai/dsh-tool-todo/lib/index.js:170 `execute(args, exec)`。
 *
 * 本文件只做薄壳：参数 → applyEligibility → 渲染文案。判定逻辑全在母版 checkEligibility，
 * 授权表在 eligibility-gate 的 grantsFor（FG 自己的状态，不进 guard.mjs 的 state）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyEligibility, FG_APPLY_TOOL_SPEC, auditEligibility } from './eligibility-gate.mjs'
import { ABSOLUTE_REDLINES } from '../dsh/pipeline.mjs'

export const name = 'focus-guard-fg-apply'
/** 依赖注入：注册到 ctx.tools 即可，无需其它服务。 */
export const inject = ['tools']

/** 从 exec 取会话标识，口径与 audit.mjs 的 auditDeny 一致。 */
function sessionOf(exec) {
  return (
    (exec && (exec.sessionId || (exec.agent && (exec.agent.sessionId || exec.agent.id)))) || 'dsh-native'
  )
}

/** 把审核结论渲染成模型可读文案。 */
export function renderDecision(result, spec) {
  const layers = result.trace.map((s) => `L${s.layer}:${s.decision}`).join(' → ')
  if (result.decision === 'allow') {
    return `[资格审核·通过] ${spec.tool} 已获授权（ttl=${spec.ttl ?? 'turn'}）。理由：${result.reason}\n层序：${layers}\n现在可以执行：${String(spec.command ?? '').slice(0, 120)}`
  }
  if (result.decision === 'needApproval') {
    return `[资格审核·需人类审批] ${result.reason}\n层序：${layers}\n请向人类说明目的与影响范围后再执行；未经批准不得执行。`
  }
  return `[资格审核·拒绝] ${result.reason}\n层序：${layers}\n不得执行该命令；如需继续，先修正申请（目的/影响范围）或改用合规替代方案。`
}

/**
 * 生成 fg_apply 的工具定义。redlines 注入而非内部 import，保持"母版/适配层不反向依赖"的可测性。
 */
export function buildFgApplyTool({ redlines = ABSOLUTE_REDLINES } = {}) {
  return defineTool({
    name: FG_APPLY_TOOL_SPEC.name,
    description: FG_APPLY_TOOL_SPEC.description,
    parameters: FG_APPLY_TOOL_SPEC.parameters,
    async execute(args, exec) {
      const session = sessionOf(exec)
      const spec = {
        tool: args.tool,
        command: args.command ?? '',
        purpose: args.purpose,
        scope: args.scope,
        ttl: args.ttl ?? 'turn',
        target: args.target,
      }
      const result = await applyEligibility({ session, ...spec, redlines, model: null })
      return { text: renderDecision(result, spec) }
    },
  })
}

/** Cordis 插件入口：把 fg_apply 注册进 ctx.tools。 */
export function apply(ctx, config) {
  void config
  ctx.tools.register(buildFgApplyTool())
}

export { auditEligibility }
