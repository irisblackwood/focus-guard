/**
 * 母版层 · 文件审批闸（2026-10-18，B 方案）
 *
 * 背景：DSH 没有原生审批弹窗，`fg_apply` 的 needApproval 只能靠模型转述给人类，
 * 等于"建议"而不是"闸门"。本模块把审批做成**可物理验证的文件状态机**：
 *
 *   拦截 → 写 approvals/pending_request.json（带唯一 id）
 *   人类 → `node tools/focusguard.mjs approve <id>` → 写 approvals/approved-<id>.json
 *   模型下一轮 → consumeApproval() 读到批准 → 授予该工具一次 ttl=turn → 删批准文件（一次性）
 *
 * 五条纪律：
 *   ① 批准文件与请求文件的 id 必须一致，且绑定**命令原文哈希**（改一个字符即失效）
 *   ② 一次性：消费即删除，不允许一条批准放行多次
 *   ③ 所有状态变化落审计（approval-requested / approval-granted / approval-consumed）
 *   ④ **绑会话**（2026-10-29）：批准只在发起申请的会话里可消费。此前只有写入侧"换会话刷新 pending"，
 *      消费侧根本不看会话——注释承诺的防线不存在：A 会话批的 `rm -rf /data` 没重试，
 *      几小时后 B 会话跑同一条命令照样消费。现在消费侧校验，两侧都认得出身份且不一致即拒绝。
 *   ⑤ **有时效**（2026-10-29）：批准不是永久通行证。默认 30 分钟内有效
 *      （`FG_APPROVAL_TTL_MS` 可调）；过期批准文件当场清掉，并留 `approval-expired` 审计。
 *      过期判定与"一次性"同源：批准是对**这一次意图**的授权，不是对这条命令的长期豁免。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 默认目录：<仓库根>/.focus-guard/approvals；FG_APPROVAL_DIR 可覆盖（测试必须覆盖）。 */
function approvalDir() {
  return process.env.FG_APPROVAL_DIR || fileURLToPath(new URL('../../../../.focus-guard/approvals', import.meta.url))
}

/** 同一工具+命令永远是同一个 id（重复申请复用，不刷屏）。 */
export function approvalId(tool, command) {
  return createHash('sha256')
    .update(`${String(tool ?? '')}\n${String(command ?? '')}`)
    .digest('hex')
    .slice(0, 12)
}

/** 批准有效期（默认 30 分钟）。`FG_APPROVAL_TTL_MS` 可覆盖，非法值回落默认。 */
export const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1000
export function approvalTtlMs() {
  const raw = Number(process.env.FG_APPROVAL_TTL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APPROVAL_TTL_MS
}

/**
 * 会话身份是否可判定。
 * 母版不认宿主：`unknown` 是母版中性值，`dsh-native` 是适配层取不到真实 id 时的兜底值，
 * 空值同理。**这三类都不是身份，只是"我不知道你是谁"**——拿它当身份去比会误杀合法批准。
 */
const PLACEHOLDER_SESSIONS = new Set(['', 'unknown', 'native', 'dsh-native'])
function identityKnown(session) {
  return !PLACEHOLDER_SESSIONS.has(String(session ?? '').trim().toLowerCase())
}

/**
 * 会话绑定判定。
 * - 两侧都认得出身份且不一致 → 不通过（跨会话盗用）
 * - 任一侧是占位值 → 通过，但标记 `loose`（身份不可判定，只做时效兜底）
 *
 * 为什么允许 loose：真实 id 与兜底值可能只在一侧出现（写入时宿主未就绪、消费时已就绪），
 * 严格相等会把合法批准误杀。这条残余口子比"完全不校验"小得多，且会落到审计里。
 */
function sessionMatches(recordSession, session) {
  const a = String(recordSession ?? '')
  const b = String(session ?? '')
  if (!identityKnown(a) || !identityKnown(b)) return { ok: true, loose: true }
  return { ok: a === b, loose: false }
}

/** 批准时效判定：从 `approvedAt` 起算，缺失则回落到请求 `ts`；都不可解析视为过期（fail closed）。 */
export function approvalAge(record, now = Date.now()) {
  const stamp = record?.approvedAt || record?.ts
  const at = Date.parse(String(stamp ?? ''))
  if (!Number.isFinite(at)) return { expired: true, ageMs: Infinity, limitMs: approvalTtlMs(), unparsable: true }
  const ageMs = now - at
  const limitMs = approvalTtlMs()
  return { expired: ageMs > limitMs, ageMs, limitMs }
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 生成/复用一条审批请求。
 * @returns {{id: string, file: string, created: boolean, request: object}}
 */
export function createApprovalRequest({ session, tool, command = '', gateId, reason = '' }) {
  const dir = ensureDir(approvalDir())
  const id = approvalId(tool, command)
  const file = join(dir, 'pending_request.json')
  const request = {
    id,
    ts: new Date().toISOString(),
    // 母版不认宿主：缺省用中性值，真实 session 由适配层传入。
    // （2026-10-22 层序审查：原缺省值硬编码 'dsh-native'，等于母版层替 DSH 代言。）
    session: String(session || 'unknown'),
    tool: String(tool ?? ''),
    command: String(command ?? '').slice(0, 400),
    gateId: String(gateId || ''),
    reason: String(reason || '').slice(0, 300),
    state: 'pending',
  }
  let created = false
  // 复用同一 id 的 pending，但**换会话要刷新**：避免上一个会话留下的待批请求被本会话误当成自己的。
  // 注意这只是写入侧的一半——真正的会话绑定在 `consumeApproval()` 的消费侧做（见纪律④）。
  if (existsSync(file)) {
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'))
      if (prev && prev.id === id && prev.session === request.session && prev.state === 'pending') {
        return { id, file, created, request: prev }
      }
    } catch {
      /* 损坏则覆盖 */
    }
  }
  writeFileSync(file, JSON.stringify(request, null, 2) + '\n')
  created = true
  return { id, file, created, request }
}

/** 读当前 pending（无则 null）。 */
export function readApprovalRequest() {
  const file = join(approvalDir(), 'pending_request.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 批准某条请求（CLI 调用）；返回是否成功（id 不匹配则失败，防批错）。 */
export function approveRequest(id) {
  const dir = ensureDir(approvalDir())
  const pending = readApprovalRequest()
  if (!pending || pending.id !== String(id)) {
    return { ok: false, reason: `没有待批请求 ${String(id)}（当前：${pending ? pending.id : '无'}）` }
  }
  const record = { ...pending, state: 'approved', approvedAt: new Date().toISOString() }
  writeFileSync(join(dir, `approved-${pending.id}.json`), JSON.stringify(record, null, 2) + '\n')
  writeFileSync(join(dir, 'pending_request.json'), JSON.stringify({ ...record }, null, 2) + '\n')
  return { ok: true, id: pending.id, record }
}

/** 清掉与某 id 关联的 pending（仅当它确实是这条）。 */
function clearPendingIfMatches(dir, id) {
  const pendingFile = join(dir, 'pending_request.json')
  if (!existsSync(pendingFile)) return
  try {
    const p = JSON.parse(readFileSync(pendingFile, 'utf8'))
    if (p && p.id === id) rmSync(pendingFile, { force: true })
  } catch {
    /* 损坏则不管 */
  }
}

/**
 * 尝试消费一条批准（一次性 + 绑会话 + 有时效）。命中即删批准文件，并清 pending。
 *
 * @param {string} tool
 * @param {string} command
 * @param {string} [session] 消费方会话 id。省略/null 视为"身份不可判定"，只做时效校验。
 * @returns {{consumed: boolean, id?: string, expired?: boolean, wrongSession?: boolean,
 *            loose?: boolean, ageMs?: number, limitMs?: number}}
 */
export function consumeApproval(tool, command, session = null) {
  const dir = approvalDir()
  const id = approvalId(tool, command)
  const file = join(dir, `approved-${id}.json`)
  if (!existsSync(file)) return { consumed: false }
  let record
  try {
    record = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { consumed: false } // 损坏视同未批准
  }
  if (!record || record.id !== id) return { consumed: false }

  // ⑤ 时效：过期即失效，并当场清掉（连同 pending），免得死批准在目录里越积越多
  const age = approvalAge(record)
  if (age.expired) {
    rmSync(file, { force: true })
    clearPendingIfMatches(dir, id)
    return { consumed: false, expired: true, id, ageMs: age.ageMs, limitMs: age.limitMs }
  }

  // ④ 会话绑定：两侧都认得出身份且不一致 → 拒绝，但**保留文件**，让本会话自己还能用
  const match = sessionMatches(record.session, session)
  if (!match.ok) return { consumed: false, wrongSession: true, id }

  rmSync(file, { force: true })
  clearPendingIfMatches(dir, id)
  return { consumed: true, id, loose: match.loose, ageMs: age.ageMs, limitMs: age.limitMs }
}

/** 列出目录里残留的批准（诊断用）。 */
export function listApprovals() {
  const dir = approvalDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.startsWith('approved-'))
    .map((n) => n.replace(/^approved-|\.json$/g, ''))
}
