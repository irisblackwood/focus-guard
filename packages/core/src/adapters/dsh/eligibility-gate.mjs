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
