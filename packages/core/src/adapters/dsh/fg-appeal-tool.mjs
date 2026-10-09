/**
 * focus-guard 适配层 · fg_appeal 工具注册（3.0.7 · 误伤申辩）
 *
 * 契约与 fg-apply-tool.mjs 相同：defineTool({ name, description, parameters, execute })。
 * 执行体只在**人类批准申辩后**才运行——ask 由 pipeline 在 pre-execute 最先发起
 * （原因是申辩参数携带被拦命令原文，若走后续闸会被同一规则再拦一次）。
 * 所以 execute 的职责就是"授予"：开通该工具一次授权 + 豁免本次命中的红线。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FG_APPEAL_TOOL_SPEC, grantFromAppeal } from './eligibility-gate.mjs'

export const name = 'focus-guard-fg-appeal'
/** 依赖注入：注册到 ctx.tools 即可。 */
export const inject = ['tools']

/** 从 exec 取会话标识，口径与 audit.mjs 的 auditDeny 一致。 */
function sessionOf(exec) {
  return (exec && (exec.sessionId || (exec.agent && (exec.agent.sessionId || exec.agent.id)))) || 'dsh-native'
}

/** 生成 fg_appeal 的工具定义。 */
export function buildFgAppealTool() {
  return defineTool({
    name: FG_APPEAL_TOOL_SPEC.name,
    description: FG_APPEAL_TOOL_SPEC.description,
    parameters: FG_APPEAL_TOOL_SPEC.parameters,
    async execute(args, exec) {
      const { entry, redline } = await grantFromAppeal({
        session: sessionOf(exec),
        tool: args.tool,
        command: args.command ?? '',
      })
      return {
        text:
          `[申辩获批] ${args.tool} 已开通一次授权（ttl=${entry.ttl}）` +
          (redline ? `，并豁免红线「${redline}」。` : '。') +
          `\n现在可以执行原被拦命令；如需更多次数请重新申请。`,
      }
    },
  })
}

/** Cordis 插件入口：把 fg_appeal 注册进 ctx.tools。 */
export function apply(ctx, config) {
  void config
  ctx.tools.register(buildFgAppealTool())
}
