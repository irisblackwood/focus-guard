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
 * 三条纪律：
 *   ① 批准文件与请求文件的 id 必须一致，且绑定**命令原文哈希**（改一个字符即失效）
 *   ② 一次性：消费即删除，不允许一条批准放行多次
 *   ③ 所有状态变化落审计（approval-requested / approval-granted / approval-consumed）
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
  // 复用同一 id 的 pending，但**换会话要刷新**（避免上一个会话的申请在另一个会话被批准）
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

/**
 * 尝试消费一条批准（一次性）。命中即删批准文件，并清 pending。
 * @returns {{consumed: boolean, id?: string}}
 */
export function consumeApproval(tool, command) {
  const dir = approvalDir()
  const id = approvalId(tool, command)
  const file = join(dir, `approved-${id}.json`)
  if (!existsSync(file)) return { consumed: false }
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))
    if (record && record.id === id) {
      rmSync(file, { force: true })
      const pendingFile = join(dir, 'pending_request.json')
      if (existsSync(pendingFile)) {
        try {
          const p = JSON.parse(readFileSync(pendingFile, 'utf8'))
          if (p && p.id === id) rmSync(pendingFile, { force: true })
        } catch {
          /* ignore */
        }
      }
      return { consumed: true, id }
    }
  } catch {
    /* 损坏视同未批准 */
  }
  return { consumed: false }
}

/** 列出目录里残留的批准（诊断用）。 */
export function listApprovals() {
  const dir = approvalDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.startsWith('approved-'))
    .map((n) => n.replace(/^approved-|\.json$/g, ''))
}
