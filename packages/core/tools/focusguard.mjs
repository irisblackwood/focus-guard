#!/usr/bin/env node
/**
 * focusguard CLI（2026-10-18，B 方案审批闸）
 *
 *   node tools/focusguard.mjs pending            查看当前待批请求
 *   node tools/focusguard.mjs approve <id>       批准该请求（人类在终端敲）
 *   node tools/focusguard.mjs list               列出已批准未消费的请求
 *   node tools/focusguard.mjs status             审计/引擎状态摘要
 *
 * 退出码：0 成功 / 1 失败（id 不匹配等）/ 2 用法错误
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { readApprovalRequest, approveRequest, listApprovals } = await import('../src/core/approvals.mjs')

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const cmd = args[0] || 'pending'

function fmtRequest(r) {
  if (!r) return '（无待批请求）'
  return [
    `id      : ${r.id}`,
    `时间    : ${r.ts}`,
    `会话    : ${r.session}`,
    `工具    : ${r.tool}`,
    `命令    : ${r.command}`,
    `门槛    : ${r.gateId}`,
    `状态    : ${r.state}`,
    `理由    : ${r.reason}`,
  ].join('\n')
}

if (cmd === 'pending') {
  console.log(fmtRequest(readApprovalRequest()))
  process.exit(0)
}

if (cmd === 'approve') {
  const id = args[1]
  if (!id) {
    console.error('用法：focusguard approve <id>（用 focusguard pending 查看 id）')
    process.exit(2)
  }
  const r = approveRequest(id)
  if (!r.ok) {
    console.error(`批准失败：${r.reason}`)
    process.exit(1)
  }
  console.log(`已批准 ${r.id}：${r.record.tool} — ${r.record.command}`)
  console.log('模型下一轮会自动感知并放行一次（ttl=turn，一次性）。')
  process.exit(0)
}

if (cmd === 'list') {
  const ids = listApprovals()
  console.log(ids.length ? ids.join('\n') : '（无已批准未消费的请求）')
  process.exit(0)
}

if (cmd === 'status') {
  const { readFileSync } = await import('node:fs')
  const audit = process.env.FG_AUDIT_FILE || join(here, '..', '..', '..', '.focus-guard', 'AUDIT.log')
  let lines = 0
  try {
    lines = readFileSync(audit, 'utf8').split('\n').filter(Boolean).length
  } catch {
    lines = 0
  }
  const pending = readApprovalRequest()
  console.log(`审计文件 : ${audit}`)
  console.log(`审计行数 : ${lines}`)
  console.log(`待批请求 : ${pending ? `${pending.id}（${pending.tool}）` : '无'}`)
  console.log(`已批准   : ${listApprovals().length}`)
  process.exit(0)
}

console.error(`未知子命令：${cmd}（可用：pending / approve <id> / list / status）`)
process.exit(2)
