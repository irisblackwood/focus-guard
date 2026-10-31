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

const { readApprovalRequest, approveRequest, listApprovals, approvalTtlMs } = await import('../src/core/approvals.mjs')

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
  // 批准不是永久通行证：只对**这个会话的这一次意图**有效（一次性 + 时效）。
  const mins = Math.round(approvalTtlMs() / 60000)
  console.log(`有效窗口 ${mins} 分钟，且仅限会话 ${r.record.session}；消费一次即失效（FG_APPROVAL_TTL_MS 可调）。`)
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

if (cmd === 'case') {
  // 卷宗人工维护（2026-10-30）：只读打分 + 人工删改，**不做自动淘汰**。
  const { loadCase, entriesOf, scoreEntry, dropEntry, tagEntry, parseTag, stripTag, CASE_TAGS, auditCase } = await import('./lib/case-tool.mjs')
  const { record, file, error } = loadCase()
  if (error) {
    console.error(`卷宗读不了：${error}`)
    process.exit(1)
  }
  if (!record) {
    console.log(`本目录没有卷宗（${file}）。卷宗在首次回合结束时自动生成。`)
    process.exit(0)
  }
  const rest = args.slice(1)
  const val = (flag) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : null)

  if (rest.includes('--drop')) {
    const r = dropEntry(record, val('--drop'))
    if (!r.ok) {
      console.error(`删除失败：${r.reason}`)
      process.exit(1)
    }
    console.log(`已删除：${r.removed}`)
    console.log(`原卷宗已备份：${r.backup}`)
    process.exit(0)
  }

  if (rest.includes('--tag')) {
    const loc = val('--tag')
    const tag = rest[rest.indexOf('--tag') + 2] || null
    const r = tagEntry(record, loc, tag)
    if (!r.ok) {
      console.error(`打标签失败：${r.reason}（可用标签：${CASE_TAGS.join(' / ')}，不传则清除）`)
      process.exit(1)
    }
    console.log(`已改：${r.before}\n  → ${r.after || '(无标签)'}`)
    process.exit(0)
  }

  const withScore = rest.includes('--score')
  const all = entriesOf(record)
  if (!all.length) {
    console.log('卷宗是空的。')
    process.exit(0)
  }
  console.log(`卷宗：${file}`)
  console.log(`工作区：${record.workspace_path || '-'} · 更新 ${record.updated_at || '-'}\n`)
  let lastField = null
  for (let i = 0; i < all.length; i += 1) {
    const e = all[i]
    if (e.field !== lastField) {
      console.log(`【${e.label}】`)
      lastField = e.field
    }
    const tag = parseTag(e.text)
    const body = stripTag(e.text)
    const hidden = tag === 'done' || tag === 'note'
    const mark = tag ? `[${tag}]`.padEnd(8) : '        '
    const line = `${String(i + 1).padStart(3)} ${mark}${body.length > 46 ? `${body.slice(0, 46)}…` : body}`
    if (withScore) {
      const { score, reasons } = scoreEntry(body)
      console.log(`${line}${hidden ? '  (不注入)' : ''}`)
      console.log(`      ${String(score).padStart(3)} 分 · ${reasons.join(' / ') || '无信号'}`)
    } else {
      console.log(`${line}${hidden ? '  (不注入)' : ''}`)
    }
  }
  console.log(`\n共 ${all.length} 条。--score 看打分（仅参考，不作判决）；--drop <序号> 删除；--tag <序号> <goal|done|note> 打标签。`)
  // 只读浏览也算"这个功能有没有人用"的证据：留一条 case-list，内容只记条数与是否打分。
  auditCase('case-list', `entries=${all.length} score=${withScore}`)
  process.exit(0)
}

console.error(`未知子命令：${cmd}（可用：pending / approve <id> / list / status / case）`)
process.exit(2)
