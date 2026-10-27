/**
 * 第 1 层·绝对红线（2026-10-27 从 pipeline.mjs 抽出，纯搬运）。
 *
 * 红线表本体在 src/core/redlines.mjs（适配层资格闸也要用，而适配层不能反向依赖宿主缝），
 * 此处只保留 re-export 与"命中哪条"的查找，以及 pre-execute 里的红线阶段。
 */
import { auditDeny, auditRedlineExempt } from '../audit.mjs'
import { redlineExempt, ABSOLUTE_REDLINES } from '../../core/redlines.mjs'

/** rm 后跟单簇旗标且同时含 r 与 f（任意顺序）：rm -rf / rm -fr / rm -Rdf …（第 1 层·普通档，模糊命令） */
export const RM_RF = /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*(?:r\w*f|f\w*r)\w*\b/

export { ABSOLUTE_REDLINES }

/** 命中哪条绝对红线；未命中返回 null */
export function redlineOf(cmd) {
  if (!cmd) return null
  return ABSOLUTE_REDLINES.find((r) => r.re.test(cmd)) || null
}

/**
 * pre-execute 阶段：红线判定 + 豁免/申辩凭据。
 *
 * 3.0.6 P0：上下文豁免——命中片段是被引用的命令字符串（数据）而非要执行的命令。
 * 3.0.7 追加：申辩获批凭据——人类就该红线的某次申辩批准后，本会话内放行该红线。
 */
export async function redlineStage(ctx) {
  const { exec, warn, cmd } = ctx
  if (!cmd) return null
  try {
    const redline = redlineOf(cmd)
    if (!redline) return null
    const exempt = redlineExempt(cmd, redline)
    let granted = null
    if (!exempt) {
      try {
        const { hasRedlineGrant } = await import('../../adapters/dsh/eligibility-gate.mjs')
        granted = await hasRedlineGrant(exec, redline.name)
      } catch {
        granted = null
      }
    }
    if (exempt || granted) {
      const basis = exempt ? exempt.basis : 'appeal-granted'
      const detail = exempt ? exempt.detail : `申辩获批凭据（红线 ${redline.name}）`
      warn(`红线放行（${basis}）：`, `${redline.name} — ${detail}`)
      auditRedlineExempt(exec, cmd, { redline: redline.name, basis, detail })
      return null
    }
    warn(`已拦截绝对红线（${redline.name}）：`, cmd.slice(0, 120))
    auditDeny(exec, cmd, { trigger: `redline:${redline.name}`, level: 3 })
    return {
      kind: 'deny',
      reason:
        `focus-guard-native: 命中绝对红线「${redline.name}」，直接拒绝（不弹审批）。` +
        `如认为误判（例如危险片段只是被引用的数据），调用 fg_appeal 提交反例锚点（文件:行号或原文引用），由人类一次性裁决。`,
    }
  } catch (error) {
    warn('红线判定异常，fail-open 放行：', (error && error.message) || error)
    return ctx.next()
  }
}
