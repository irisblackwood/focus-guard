/**
 * focus-guard 适配层 · 资格审核闸（3.0.5 第二步）
 *
 * 双入口闭环：
 *   入口一 fg_apply（applyEligibility + FG_APPLY_TOOL_SPEC）：AI 提交目的/影响范围 → 审核 → 通过则按 session 授权
 *   入口二 gateToolCall（pre-execute 调用）：高危工具无授权 → deny，理由指向 fg_apply
 *
 * 分层纪律：本文件属适配层，向母版注入 redlines / audit / model；母版不反向依赖本层。
 * grants 是 FG 自己的状态（按 session 分表，内存版；第五步持久化到 FG 状态文件），不进 guard.mjs 的 state。
 * 审计默认写 .focus-guard/AUDIT.log；FG_AUDIT_FILE 可重定向——自检**只写 tmpdir()**，绝不碰真实工作区。
 */
import { appendFileSync } from 'node:fs'
import { checkEligibility, HIGH_RISK_TOOLS, SYSTEM_PATH_RE } from '../../core/checkEligibility.mjs'
import { createGrantTable } from '../../core/grants.mjs'
import { AUDIT_FILE } from '../../dsh/audit.mjs'

/** 对系统路径的写入类工具：与命令型高危同属"必须先申请"的门槛清单（显式成文）。 */
export const GATED_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

/**
 * 判定本次调用是否属"必须先申请"的类别。
 * @returns {string|null} 命中的门槛 id（rm-rf / format-volume / … / write-system-path），不属门槛则 null
 */
export function gatedReasonOf(tool, command = '') {
  const cmd = String(command ?? '')
  const hit = HIGH_RISK_TOOLS.find((r) => r.re.test(cmd))
  if (hit) return hit.id
  const name = String(tool ?? '').toLowerCase()
  if (GATED_WRITE_TOOLS.some((t) => t.toLowerCase() === name) && SYSTEM_PATH_RE.test(cmd)) return 'write-system-path'
  return null
}

// —— FG 自己的授权状态：按 session 分表（内存；第五步持久化）——
const TABLES = new Map()

/** 该会话的授权表（不存在则建）。 */
export function grantsFor(session) {
  const key = String(session || 'dsh-native')
  let table = TABLES.get(key)
  if (!table) {
    table = createGrantTable()
    TABLES.set(key, table)
  }
  return table
}

/** 回收整张表（回合/任务结束；第五步由 ttl 计时自动调用）。 */
export function resetGrants(session) {
  return TABLES.delete(String(session || 'dsh-native'))
}

/** 资格审核审计（规格 §七 字段口径）。写失败只 warn，绝不阻断审核结论。 */
export function auditEligibility(row) {
  try {
    appendFileSync(process.env.FG_AUDIT_FILE || AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n')
  } catch (error) {
    console.warn('[focus-guard-native] 资格审核审计写入失败（不阻断）:', (error && error.message) || error)
  }
}

/**
 * 入口一的核心：申请 → 审核 → 授权。
 *
 * 关键语义：fg_apply 本身是**申请通道**，所以审核期间先把该工具视为"已有授权"，让母版第 3 层
 * 聚焦于"可否授予"（状态/红线/前置/语义），而不是被"无授权即需审批"挡在自己的入口上。
 * 审核未通过时立即收回这一临时授权——被拒就绝不能放行。
 *
 * @returns {Promise<{decision:"allow"|"deny"|"needApproval", layer:string, reason:string, modelSignal:object|null, trace:Array}>}
 */
export async function applyEligibility({
  session,
  tool,
  command = '',
  purpose,
  scope,
  ttl = 'turn',
  target,
  state = {},
  redlines = [],
  model = null,
}) {
  const grants = grantsFor(session)
  const preGranted = grants.has(tool)
  if (!preGranted) grants.grant(tool, { ttl, reason: 'fg_apply 审核中（临时）' })
  const result = await checkEligibility({
    tool,
    command,
    purpose,
    scope,
    ttl,
    target,
    state,
    redlines,
    model,
    grants,
    audit: (row) => auditEligibility({ session, ...row }),
  })
  if (result.decision !== 'allow' && !preGranted) grants.revoke(tool)
  return result
}

/**
 * 入口二：pre-execute 的 grants 校验。
 * @returns {{kind:"pass", granted?: boolean}} 不属门槛清单、或已有授权 → 交回原有判定链
 *          {{kind:"deny", reason: string}} 属门槛且无授权 → 拦截
 */
export function gateToolCall({ session, tool, command = '', state } = {}) {
  const reason = gatedReasonOf(tool, command)
  if (!reason) return { kind: 'pass' }
  const grants = grantsFor(session)
  if (grants.has(tool)) return { kind: 'pass', granted: true }
  const detail = `该工具需先调 fg_apply 申请授权（命中 ${reason}）`
  auditEligibility({
    session,
    action: 'deny',
    tool,
    command: String(command ?? '').slice(0, 120),
    layer: 'gate',
    decision: 'deny',
    modelSignal: null,
    evidence: detail,
  })
  return { kind: 'deny', reason: detail }
}

/**
 * fg_apply 的工具注册规格。接线时套用装机 dsh-tools 的 defineTool 契约（name/description/parameters +
 * 执行体），执行体只需 await applyEligibility(args) 并按 decision 渲染文案，无额外逻辑。
 */
export const FG_APPLY_TOOL_SPEC = {
  name: 'fg_apply',
  description:
    '向 FocusGuard 申请高危工具的临时执行资格。执行高危命令（rm -rf / 格式化 / git push -f / 发布 / 全局安装 / 系统路径写入）之前必须先申请；purpose 与 scope 必填。通过后本会话内按 ttl 放行，被拒则不得执行。',
  parameters: {
    tool: { type: 'string', required: true, description: '目标工具名，如 Bash / Write / Edit' },
    command: { type: 'string', required: true, description: '命令或操作描述' },
    purpose: { type: 'string', required: true, description: '真实目的（必填，不得空白）' },
    scope: { type: 'string', required: true, description: '影响范围（必填，不得空白）' },
    ttl: { type: 'string', required: false, enum: ['turn', 'task', 'persist'], description: '授权有效期，默认 turn' },
    target: { type: 'string', required: false, description: '目标路径（改动类可选，供第 4 层取证比对）' },
  },
}

// ═══════════ 3.0.7 · 误伤申辩（司法救济通道）═══════════
// 缺口背景（外部审计指出、并经逐字复核成立）：原体系只有"立法救济"（事后改规则），
// 没有"司法救济"（个案当场申辩）。HANDOFF §八 的红线误伤即实证——被拦后AI无程序可走，
// 只能绕过（[char]47 拼接）或等修法（3.0.6 上下文豁免），成本差两个数量级。
// 本机制复用既有审批骨架：申辩 → {kind:"ask"} → 人类一次性裁决 → 留痕。
// 注意：第八十三条(三) 原写"拦截申诉…仍走第十二章"，而第十二章是【反规避与纪律审查】（处罚章），
// 属条文错配——本机制即为该错配补上的实体程序。

/** 红线豁免凭据的授权键前缀：申辩获批后按 `redline:<名称>` 记账，供 pipeline 红线层查询。 */
export const REDLINE_GRANT_PREFIX = 'redline:'

/** 取会话标识（与 audit.mjs 的 auditDeny 口径一致）。 */
function sessionOf(exec) {
  return (exec && (exec.sessionId || (exec.agent && (exec.agent.sessionId || exec.agent.id)))) || 'dsh-native'
}

/**
 * 查该红线是否已有"申辩获批"凭据（3.0.7）。
 * pipeline 红线层在上下文豁免判据之外追加查这一道。
 * @returns {Promise<boolean>}
 */
export async function hasRedlineGrant(exec, redlineName) {
  if (!redlineName) return false
  return grantsFor(sessionOf(exec)).has(`${REDLINE_GRANT_PREFIX}${redlineName}`)
}

/**
 * 申辩入口（3.0.7）：把 fg_appeal 的这次调用转成 `{kind:"ask"}`，交 DSH approval seam 由人类裁决。
 * 由 pipeline 在**所有闸之前**调用——申辩参数携带被拦命令原文，走后续闸会被同一规则再拦一次。
 * @returns {Promise<{kind:"ask", reason:string}|{kind:"deny", reason:string}|null>}
 */
export async function appealAsk(exec, warn) {
  const args = (exec && exec.arguments) || {}
  const target = String(args.tool ?? '').trim()
  const blocked = String(args.command ?? '')
  const counterExample = String(args.counterExample ?? '').trim()
  const reason = String(args.reason ?? '').trim()
  const session = sessionOf(exec)

  if (!target || !reason) {
    const msg = '申辩表单不完整：tool 与 reason 必填；建议附 counterExample 反例锚点（文件:行号 或原文引用）'
    auditEligibility({
      session,
      action: 'appeal-denied',
      tool: target || '(missing)',
      command: blocked.slice(0, 120),
      layer: 'appeal',
      decision: 'deny',
      modelSignal: null,
      evidence: msg,
    })
    if (typeof warn === 'function') warn('申辩表单不完整：', msg)
    return { kind: 'deny', reason: `focus-guard-native: ${msg}` }
  }

  auditEligibility({
    session,
    action: 'appeal-filed',
    tool: target,
    command: blocked.slice(0, 120),
    layer: 'appeal',
    decision: 'needApproval',
    modelSignal: null,
    evidence: `反例锚点：${counterExample.slice(0, 200) || '(未提供)'} | 理由：${reason.slice(0, 200)}`,
  })
  if (typeof warn === 'function') warn('申辩已提交人类裁决：', `${target} ${blocked.slice(0, 80)}`)

  return {
    kind: 'ask',
    reason:
      `focus-guard-native:【误判申辩】\n` +
      `工具：${target}\n` +
      `被拦命令：${blocked.slice(0, 200) || '(未提供)'}\n` +
      `反例锚点：${counterExample.slice(0, 300) || '(未提供)'}\n` +
      `理由：${reason.slice(0, 300)}\n\n` +
      `批准 → 为该工具开通一次授权（ttl=turn），并豁免本次命中的红线；拒绝 → 维持拦截。`,
  }
}

/**
 * 申辩获批后的授予（3.0.7）：由 fg_appeal 的执行体调用（人类批准后才轮到 execute 运行）。
 * 同时记"工具授权"与"红线凭据"，使原被拦命令的下次调用能过红线层与资格闸。
 */
export async function grantFromAppeal({ session, tool, command = '' } = {}) {
  const grants = grantsFor(session)
  const entry = grants.grant(String(tool), {
    ttl: 'turn',
    reason: `申辩获批：${String(command).slice(0, 80)}`,
  })
  let redline = null
  try {
    // 路径相对本文件（src/adapters/dsh/）：上溯两级到 src/，再进 dsh/
    const { ABSOLUTE_REDLINES } = await import('../../dsh/pipeline.mjs')
    const hit = (ABSOLUTE_REDLINES || []).find((r) => r && r.re && r.re.test(String(command)))
    if (hit) {
      grants.grant(`${REDLINE_GRANT_PREFIX}${hit.name}`, { ttl: 'turn', reason: '申辩获批红线豁免' })
      redline = hit.name
    }
  } catch (error) {
    // 不静默：红线凭据拿不到时工具授权仍生效，但必须留痕（对齐 2.5.1「假留痕防线」）
    console.warn(
      '[focus-guard-native] 申辩红线凭据授予失败（工具授权仍生效）:',
      (error && error.message) || error,
    )
    redline = null
  }
  auditEligibility({
    session,
    action: 'appeal-granted',
    tool,
    command: String(command).slice(0, 120),
    layer: 'appeal',
    decision: 'allow',
    modelSignal: null,
    evidence: `获批授权 ttl=${entry.ttl}${redline ? `；红线豁免：${redline}` : ''}`,
  })
  return { entry, redline }
}

/** fg_appeal 的工具注册规格（与 fg_apply 同构；执行体只在人类批准后运行）。 */
export const FG_APPEAL_TOOL_SPEC = {
  name: 'fg_appeal',
  description:
    '对被 FocusGuard 拦截的命令提出【误判申辩】。仅当认为拦截属误伤时使用（例如被引用的危险命令字符串被当成了要执行的命令）。须给出 reason，并尽量附 counterExample 反例锚点（文件:行号 或原文引用）。提交后由人类一次性裁决：批准则开通该工具一次授权并豁免对应红线，拒绝则维持拦截。',
  parameters: {
    tool: { type: 'string', required: true, description: '被拦的工具名，如 Bash / Write' },
    command: { type: 'string', required: true, description: '被拦的命令或操作原文' },
    reason: { type: 'string', required: true, description: '申辩理由（必填，不得空白）' },
    counterExample: {
      type: 'string',
      required: false,
      description: '反例锚点：证明该片段只是数据的证据，如 文件:行号 或原文引用',
    },
  },
}
