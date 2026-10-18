#!/usr/bin/env node
/**
 * 卷宗【三】路径有效性自检（2026-10-18，REPORT-2026-10-12 P3）
 *
 * 背景：monorepo 化（docs/ → packages/core/docs/ 等）之后，取证记录未随迁，
 * 卷宗【三】里长期残留指向已不存在路径的行，而 CASE_MAX_ROWS=200 无淘汰压力，不会被自然挤掉。
 * 本工具只做**只读核查**：列出失效行，不删、不改（清理须走人类批准 + 备份流程）。
 *
 * 用法：
 *   node tools/verify-case-paths.mjs            # 人读摘要 + 失效清单
 *   node tools/verify-case-paths.mjs --json     # 机器读
 * 退出码：0 全部有效 / 1 存在失效路径 / 2 卷宗或章节缺失
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_CASE_FILE = fileURLToPath(new URL('../../../.ai/CASE_FILE.md', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * 从 CASE_FILE 文本里抽出【三】的表格行。
 * 列序：文件名 | 读取时间 | mtime | size | SHA-256 | 变更历史 | TTL | 验证方式
 * @param {string} text
 * @returns {Array<{path: string, readAt: string, line: number}>}
 */
export function parseCaseRows(text) {
  const lines = String(text || '').split('\n')
  const start = lines.findIndex((l) => /^###\s*【三】/.test(l.trim()))
  if (start < 0) return []
  const rows = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^###\s/.test(line.trim())) break
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.split('|').map((c) => c.trim())
    // cells[0] 是行首空串；cells[1] 文件名、cells[2] 读取时间
    const cellPath = cells[1]
    if (!cellPath || /^[-:]+$/.test(cellPath) || cellPath === '文件名') continue
    rows.push({ path: cellPath, readAt: cells[2] || '', line: i + 1 })
  }
  return rows
}

/** 校验一批行；返回 {ok, missing}。相对路径按仓库根解析。 */
export function checkPaths(rows, root = REPO_ROOT) {
  const ok = []
  const missing = []
  for (const row of rows) {
    const abs = isAbsolute(row.path) ? row.path : join(root, row.path)
    if (existsSync(abs)) ok.push(row)
    else missing.push(row)
  }
  return { ok, missing }
}

function main() {
  const json = process.argv.includes('--json')
  const file = process.env.FG_CASE_FILE || DEFAULT_CASE_FILE
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    console.error(`卷宗不可读：${file}（${error && error.message}）`)
    process.exit(2)
  }
  const rows = parseCaseRows(text)
  if (rows.length === 0) {
    console.error(`卷宗【三】未找到表格行：${file}`)
    process.exit(2)
  }
  const { ok, missing } = checkPaths(rows, REPO_ROOT)
  const result = {
    file,
    total: rows.length,
    valid: ok.length,
    missing: missing.map((r) => ({ path: r.path, readAt: r.readAt, line: r.line })),
  }
  if (json) {
    console.log(JSON.stringify(result))
  } else {
    console.log(`卷宗【三】共 ${result.total} 行：有效 ${result.valid} / 失效 ${missing.length}`)
    for (const m of result.missing) console.log(`  ✗ L${m.line} ${m.path}  (读取于 ${m.readAt})`)
    if (missing.length > 0) {
      console.log('处置建议：人工确认后移入 .ai/archive/（不删），或重新取证刷新该行。')
    }
  }
  process.exit(missing.length > 0 ? 1 : 0)
}

if (process.argv[1] && process.argv[1].endsWith('verify-case-paths.mjs')) main()
