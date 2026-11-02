#!/usr/bin/env node
/**
 * 版本号单点（tools/version.mjs，2026-11-02）——一处改动，九处跟随。
 *
 * 为什么要这个东西：
 *   版本号散在 9 个地方：7 个清单（`VERSION_FILES`）+ `ENGINE_VERSION` + CHANGELOG 最新段。
 *   此前每次发版靠手工同步 7 次，`docs-lint` 只负责事后喊「你们不一样」——它是**比对器**，
 *   不是**写入器**。比对器能抓住错误，但抓不住「忘了改」这件事本身，因为它每次都只是红。
 *
 * 唯一真源 = `packages/core/src/core/constants.mjs` 的 `ENGINE_VERSION`。
 *   理由不是"我觉得"，是 `docs/ARCHITECTURE.md:135` 已经写死的那句：
 *   **「版本以 `ENGINE_VERSION` 为准，代码即事实」**。运行时读的就是它，
 *   其余 7 个清单是**宿主与发布面的副本**，只能由本工具写，不许手改。
 *
 * 用法：
 *   node tools/version.mjs                 # 打印九处现状（不一致 exit 1）
 *   node tools/version.mjs --set 3.4.0     # 写 6 个清单 + ENGINE_VERSION + CHANGELOG 新段
 *   node tools/version.mjs --set 3.4.0 --dry   # 只看会改什么，不落盘
 *
 * 为什么 `--set` 连 CHANGELOG 的标题一起写：
 *   标题是**机械的**（`## 3.4.0 · 2026-11-02`），正文才是人的。把它拆开写，等于每次都留
 *   一个"代码已是新版、记录还是旧版"的中间态，而那个中间态正是版本混乱的产地。
 *   正文只放一行 `> 待填`，逼着人回来补——比让标题对不上更诚实。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

/** 七个清单。与 `tools/lib/docs-core.mjs` 的 `VERSION_FILES` 同源——改一处必须改两处时，
 *  下面那条自检会红（见 `assertSingleList`）。 */
const VERSION_FILES = [
  'package.json',
  'marketplace.json',
  '.zcode-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  'packages/core/package.json',
  'packages/extended/package.json',
]

const CONSTANTS = 'packages/core/src/core/constants.mjs'
const CHANGELOG = 'CHANGELOG.md'
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 读清单里的版本。根 `marketplace.json` 与 `.claude-plugin/marketplace.json` 的版本在
 *  `plugins[0].version`，其余是顶层 `version`——两种形状都认，读不到就报错，不静默算 undefined。 */
function readManifest(rel) {
  const json = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
  const value = json.version ?? (Array.isArray(json.plugins) ? json.plugins[0]?.version : undefined)
  return { value, json }
}

function readEngineVersion() {
  const text = readFileSync(join(ROOT, CONSTANTS), 'utf8')
  const m = text.match(/ENGINE_VERSION\s*=\s*["']([^"']+)["']/)
  if (!m) throw new Error(`${CONSTANTS} 里找不到 ENGINE_VERSION`)
  return m[1]
}

function readChangelogHead() {
  const text = readFileSync(join(ROOT, CHANGELOG), 'utf8')
  const m = text.match(/^## (\d+\.\d+\.\d+)/m)
  return m ? m[1] : null
}

/** 九处现状。每处带 `authority` 标记：真源那处为 true，其余是副本。 */
function survey() {
  const rows = []
  for (const rel of VERSION_FILES) {
    try {
      rows.push({ where: rel, value: readManifest(rel).value, authority: false })
    } catch (error) {
      rows.push({ where: rel, value: `读取失败：${error.message}`, authority: false })
    }
  }
  rows.push({ where: CONSTANTS, value: readEngineVersion(), authority: true })
  rows.push({ where: `${CHANGELOG} 最新段`, value: readChangelogHead(), authority: false })
  return rows
}

function print(rows) {
  const truth = rows.find((r) => r.authority).value
  const bad = rows.filter((r) => r.value !== truth)
  const pad = Math.max(...rows.map((r) => r.where.length))
  for (const r of rows) {
    const mark = r.value === truth ? '✓' : '✗'
    const tag = r.authority ? '（真源）' : ''
    console.log(`  ${mark} ${r.where.padEnd(pad)}  ${r.value}${tag}`)
  }
  if (bad.length) {
    console.log(`\n✗ ${bad.length} 处与真源 ${truth} 不一致：`)
    for (const r of bad) console.log(`    ${r.where} = ${r.value}`)
    console.log('\n  修法：node tools/version.mjs --set ' + truth + '   （以真源为准写回副本）')
  } else {
    console.log(`\n✓ 九处一致：${truth}`)
  }
  return bad.length
}

/** 写 JSON 时保留原有缩进**与行尾**——工具写出来的文件不该和手写的长得不一样。
 *  行尾这条不是洁癖：本仓清单是 CRLF，`JSON.stringify` 吐 LF，写一次就在 `git status` 里
 *  留一条"改过"的假记录，`git diff` 却是空的。噪音会训练人忽略 status。 */
function writeManifest(rel, version, dry) {
  const path = join(ROOT, rel)
  const raw = readFileSync(path, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const { json } = readManifest(rel)
  if (Array.isArray(json.plugins) && json.version === undefined) json.plugins[0].version = version
  else json.version = version
  const after = (JSON.stringify(json, null, 2) + '\n').replace(/\n/g, eol)
  if (after === raw) return false
  if (!dry) writeFileSync(path, after)
  return true
}

function writeEngineVersion(version, dry) {
  const path = join(ROOT, CONSTANTS)
  const text = readFileSync(path, 'utf8')
  const next = text.replace(/(ENGINE_VERSION\s*=\s*["'])([^"']+)(["'])/, `$1${version}$3`)
  if (next === text) return false
  if (!dry) writeFileSync(path, next)
  return true
}

/** 在第一个 `## ` 之前插入新版本段。标题机械、正文留白——正文是人写的，工具不代笔。 */
function writeChangelogSection(version, dry) {
  const path = join(ROOT, CHANGELOG)
  const text = readFileSync(path, 'utf8')
  if (new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm').test(text)) return false
  const at = text.search(/^## /m)
  if (at < 0) throw new Error(`${CHANGELOG} 里找不到任何 ## 段，不敢插`)
  const day = new Date().toISOString().slice(0, 10)
  const block = `## ${version} · ${day}\n\n> 待填：本段正文（工具只写标题，正文必须人写）。\n\n`
  if (!dry) writeFileSync(path, text.slice(0, at) + block + text.slice(at))
  return true
}

/** 本文件的清单与 docs-core 的清单必须同源。两边各写一份就是"七个版本号"的同一个病换个地方犯。 */
function assertSingleList() {
  const core = readFileSync(join(ROOT, 'packages/core/tools/lib/docs-core.mjs'), 'utf8')
  const m = core.match(/VERSION_FILES\s*=\s*\[([\s\S]*?)\]/)
  if (!m) return null
  const theirs = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  const same = theirs.length === VERSION_FILES.length && theirs.every((v, i) => v === VERSION_FILES[i])
  return same ? null : { theirs, mine: VERSION_FILES }
}

function main() {
  const argv = process.argv.slice(2)
  const dry = argv.includes('--dry')
  const setAt = argv.indexOf('--set')
  const target = setAt >= 0 ? argv[setAt + 1] : null

  const mismatch = assertSingleList()
  if (mismatch) {
    console.error('✗ 清单不同源：本文件的 VERSION_FILES 与 tools/lib/docs-core.mjs 不一致')
    console.error('  本文件:', mismatch.mine.join(', '))
    console.error('  docs-core:', mismatch.theirs.join(', '))
    process.exit(1)
  }

  if (!target) {
    const bad = print(survey())
    process.exit(bad ? 1 : 0)
  }

  if (!SEMVER.test(target)) {
    console.error(`✗ 不是合法语义化版本：${target}`)
    process.exit(1)
  }

  const changed = []
  for (const rel of VERSION_FILES) if (writeManifest(rel, target, dry)) changed.push(rel)
  if (writeEngineVersion(target, dry)) changed.push(CONSTANTS)
  if (writeChangelogSection(target, dry)) changed.push(`${CHANGELOG}（新增段）`)

  console.log(`${dry ? '（演练，未落盘）' : ''}版本 → ${target}`);
  for (const c of changed) console.log(`  ✎ ${c}`)
  if (!changed.length) console.log('  （九处本来就是它，无需改动）')
  console.log('')
  print(survey())
}

main()
