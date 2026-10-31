#!/usr/bin/env node
/**
 * 卷宗体检 —— 只读重放磁盘，比对卷宗【三】，报不一致（3.4.0）
 *
 * ## 抄的是谁
 *
 * `Ido1um/DeepSeek-memory-Ido1um` 的 `audit-facts.mjs`：只读重放原文 → 按当前抽取规则
 * 重抽一遍 → 跟事实库比对 → 报「漏记 N 条」。那套范式的价值不在代码，在**判据**：
 * 它不问「库好不好」，只问「原文里该有的，库里有没有」。
 *
 * ## 本仓的映射
 *
 *   memory 的「原文日志」  →  本仓的「磁盘现状」
 *   memory 的「抽取规则」  →  本仓的「侦查规则」（guard.mjs / postProgress.mjs 写【三】的口径）
 *   memory 的「事实库」    →  本仓的「卷宗【三】侦查记录」
 *
 * 卷宗是磁盘的投影。投影失真 = 记录不可信 = 拿旧结论当新证据。
 * 这正是 3.3 那四个症状的同一个病：**校验物与被校验物断线**。
 *
 * ## 三条断言
 *
 *   ghost    卷宗有行、磁盘没文件   改名/删除后没清理，记录悬空 —— **真异常**
 *   changed  读完之后文件又变了     卷宗落后于现实 —— 正常流转，下次读取自然更新
 *   aged     保持度 R < 0.5         半衰期已过 —— 正常流转，保守重读
 *
 * 前一条是缺陷，后两条是状态。混在一起报就是 197/200 全红——红得没信息量，
 * 人开始忽略红，检查等于没有（2026-10-29 教训：按原因分档，不按结果对错分档）。
 *
 * ## 读法（对齐 audit-facts 的三种结果）
 *
 *   ✓ 没有悬空 —— 卷宗与磁盘一致
 *   ✗ 悬空 N 条 —— 逐条列路径，删掉那一行即可（本命令只报告，不自动修）
 *   · 落后 M 条 —— 只是「该重读了」，不影响结论有效性，默认不展开
 *
 * 默认退出码 0（体检不阻断）；`--strict` 时只有**悬空**才 1。
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { casePath, loadCaseRecords, fingerprint, retention, halfLifeOf } from '../src/core/state.mjs'

const HALF_LIFE_MS = 3600e3

/** 卷宗行 → 绝对路径。绝对路径原样用，相对路径按工作区解析。 */
function resolveRecord(projDir, rec) {
  return isAbsolute(rec.path) ? rec.path : join(projDir, rec.path)
}

/** 单行判定：返回一条 finding 或 null。顺序即优先级，一条行只报一个最重的。 */
function judge(projDir, rec, now) {
  const abs = resolveRecord(projDir, rec)
  if (!existsSync(abs)) {
    return { kind: 'ghost', path: rec.path, detail: '卷宗有行，磁盘上没这个文件' }
  }
  let fp
  try {
    fp = fingerprint(abs)
  } catch {
    return { kind: 'ghost', path: rec.path, detail: '文件存在但读不动（权限/占用）' }
  }
  const moved = rec.sha ? Boolean(fp.sha) && fp.sha !== rec.sha : Math.abs(fp.mtime - rec.mtime) > 1 || fp.size !== rec.size
  if (moved) return { kind: 'changed', path: rec.path, detail: '读完之后文件又变了' }
  const r = retention(rec, now)
  if (r < 0.5) {
    const s = (halfLifeOf(rec, now) / HALF_LIFE_MS).toFixed(1)
    return { kind: 'aged', path: rec.path, detail: `R=${r.toFixed(2)}（半衰期 ${s}h 已过）` }
  }
  return null
}

export function auditCase(projDir, opts = {}) {
  const now = opts.now || Date.now()
  const file = casePath(projDir)
  const records = loadCaseRecords(file)
  const rows = Object.values(records)
  const findings = rows.map((rec) => judge(projDir, rec, now)).filter(Boolean)
  return { file, total: rows.length, findings }
}

function printHuman(result, showAll) {
  const { file, total, findings } = result
  const ghost = findings.filter((f) => f.kind === 'ghost')
  const drift = findings.filter((f) => f.kind !== 'ghost')
  console.log(`卷宗       ${file}`)
  console.log(`侦查记录   ${total} 条`)
  if (ghost.length) {
    console.log(`\n✗ 悬空 ${ghost.length} 条 —— 文件已不在，行该删`)
    for (const f of ghost.slice(0, 12)) console.log(`    ${f.path}`)
    if (ghost.length > 12) console.log(`    …另 ${ghost.length - 12} 条`)
  } else {
    console.log('\n✓ 没有悬空：卷宗里每一行都指向真实文件。')
  }
  if (!drift.length) return
  const changed = drift.filter((f) => f.kind === 'changed').length
  console.log(`\n· 落后 ${drift.length} 条（changed ${changed} / aged ${drift.length - changed}）—— 只是该重读了，不影响结论有效性`)
  if (!showAll) {
    console.log('  加 --all 展开明细')
    return
  }
  for (const f of drift.slice(0, 20)) console.log(`    [${f.kind}] ${f.path} —— ${f.detail}`)
  if (drift.length > 20) console.log(`    …另 ${drift.length - 20} 条`)
}

function main() {
  const argv = process.argv.slice(2)
  const dirIdx = argv.indexOf('--dir')
  const projDir = dirIdx >= 0 ? argv[dirIdx + 1] : process.cwd()
  const result = auditCase(projDir)
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else printHuman(result, argv.includes('--all'))
  const blocking = result.findings.filter((f) => f.kind === 'ghost').length
  process.exit(argv.includes('--strict') && blocking ? 1 : 0)
}

if (process.argv[1] && process.argv[1].endsWith('case-audit.mjs')) main()
