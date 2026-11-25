#!/usr/bin/env node
/**
 * legacy:audit —— 旧写法扫描器（3.5.3）
 *
 * 回答一个问题：**这段文字描述的对象还在不在？**
 *
 * 两类判据：
 *   1. retired-name  退役台账（packages/core/docs/RETIRED.json）里记过的旧名字，除 allow 外不得出现
 *   2. stale-anchor  文档里的 `file.mjs:123` 锚点，行号不得超过文件长度（可证明的失效）
 *
 * `missing-file`（仓内找不到目标）只报不拦：它可能是外部包路径，也可能是删掉的文件，
 * 机器分不清。判不了的不要假装判得了。
 *
 * 用法：
 *   node packages/core/tools/legacy-audit.mjs            # 人读清单
 *   node packages/core/tools/legacy-audit.mjs --brief    # 一行（供 npm run check）
 *   node packages/core/tools/legacy-audit.mjs --json     # 机器读
 *   node packages/core/tools/legacy-audit.mjs --strict   # 有硬伤即 exit 1
 *
 * 为什么要有这个工具：改名是本仓最高频的操作，也是最高频的漏改。3.5.3 一轮里同一个
 * 错误出现三次（标识符漏改 4 处 / description 副本漏 1 份 / dsh-native 只改 2 个文件）。
 * 根因不是不小心——是没有任何地方记着「旧名是什么」。台账补的就是这一块。
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkScope, loadLedger, scanRetired, scanAnchors } from './lib/legacy-core.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const argv = process.argv.slice(2)
const AS_JSON = argv.includes('--json')
const BRIEF = argv.includes('--brief')
const STRICT = argv.includes('--strict')

const files = walkScope(ROOT)
const ledger = loadLedger(ROOT)
const retired = scanRetired(ROOT, files, ledger.entries)
const anchors = scanAnchors(ROOT, files, ledger.anchorAllow)
const overflow = anchors.filter((a) => a.kind === 'line-overflow')
const missing = anchors.filter((a) => a.kind === 'missing-file')

/** 硬伤 = 台账命中的旧名 + 可证明越界的锚点。missing-file 不算。 */
const hard = retired.length + overflow.length

if (AS_JSON) {
  console.log(JSON.stringify({ files: files.length, retired, overflow, missing, hard }, null, 2))
  process.exit(STRICT && hard > 0 ? 1 : 0)
}

if (BRIEF) {
  const parts = [`旧写法 ${hard} 处（旧名 ${retired.length} / 锚点越界 ${overflow.length}）`]
  if (missing.length) parts.push(`待人工判 ${missing.length}（仓内无此文件）`)
  console.log(parts.join('，'))
  process.exit(STRICT && hard > 0 ? 1 : 0)
}

console.log(`扫描 ${files.length} 个文件，台账 ${ledger.entries.length} 条退役记录\n`)

if (retired.length) {
  console.log(`旧名字残留 ${retired.length} 处：`)
  for (const r of retired) {
    console.log(`  ${r.file}:${r.line}  「${r.pattern}」（${r.id}）`)
    console.log(`    ${r.text}`)
  }
  console.log('')
} else {
  console.log('旧名字残留：0')
}

if (overflow.length) {
  console.log(`\n行号锚点越界 ${overflow.length} 处（可证明失效）：`)
  for (const a of overflow) console.log(`  ${a.file} → ${a.anchor}（${a.detail}）`)
} else {
  console.log('行号锚点越界：0')
}

if (missing.length) {
  console.log(`\n待人工判 ${missing.length} 处（仓内找不到目标，可能是外部包路径）：`)
  for (const a of missing.slice(0, 20)) console.log(`  ${a.file} → ${a.anchor}`)
  if (missing.length > 20) console.log(`  …另有 ${missing.length - 20} 处`)
}

console.log(`\n合计硬伤 ${hard} 处。${STRICT && hard > 0 ? '闸门：红' : ''}`)
process.exit(STRICT && hard > 0 ? 1 : 0)
