#!/usr/bin/env node
/**
 * 跨会话快速交接（主图 L4，2026-10-22）
 *
 * 打印当前工作区的交接简报：上次会话快照 + 决策 + 约束 + 下一步。
 * 只读、不推断：所有数字都来自 FG 自己数出来的状态与卷宗，不猜"做到哪了"。
 *
 * 用法：
 *   node packages/core/tools/handoff.mjs                 # 当前目录
 *   node packages/core/tools/handoff.mjs --cwd <path>    # 指定工作区
 *   node packages/core/tools/handoff.mjs --json          # 机器读
 */

import { readWorkspace, renderWorkspaceSection, workspaceHash } from '../src/dsh/workspace.mjs'

const argv = process.argv.slice(2)
const cwdArg = argv.includes('--cwd') ? argv[argv.indexOf('--cwd') + 1] : process.cwd()
const asJson = argv.includes('--json')

const record = readWorkspace(cwdArg)
if (!record) {
  console.log(`无卷宗：${cwdArg}（hash=${workspaceHash(cwdArg)}）`)
  process.exit(0)
}

if (asJson) {
  console.log(JSON.stringify(record, null, 2))
  process.exit(0)
}

const s = record.snapshot
console.log(`# 交接简报 · ${record.workspace_path || cwdArg}`)
console.log(`hash=${record.workspace_hash} · 更新 ${record.updated_at || '-'}`)
if (s) {
  console.log(
    `\n上次会话：${s.sid || '-'}（${s.at || '-'}）\n` +
      `- 工具调用 ${s.toolCalls ?? '-'} · 被拦 ${s.denies ?? '-'}\n` +
      `- KPI ${s.kpi ?? '-'} · 委托池剩余 ${s.delegateBudget ?? '-'}`,
  )
}
const block = (label, items) => {
  if (!items || !items.length) return
  console.log(`\n${label}：`)
  // 简报要"快速"：只取最近 5 条，每条压到 90 字（原文仍在 workspace.json，不丢数据）。
  for (const x of items.slice(-5)) {
    const one = String(x).replace(/\s+/g, ' ').trim()
    console.log(`- ${one.length > 90 ? one.slice(0, 90) + '…' : one}`)
  }
  if (items.length > 5) console.log(`- …（共 ${items.length} 条，其余见 workspace.json）`)
}
block('决策（人类指令原文）', record.decisions)
block('约束（被人否决过的命令）', record.constraints)
block('下一步', record.next_action)

const section = renderWorkspaceSection(record)
if (section) console.log(`\n---\n（新会话自动注入的 section，${section.length} 字）\n${section}`)
