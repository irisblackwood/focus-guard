#!/usr/bin/env node
/**
 * 【私有工具】知识库统一索引（2026-10-31，M2）
 *
 * 产物落 `.ai/output/`——私有面，不入库、不随 npm 分发。
 *
 * ## 为什么有 namespace
 *
 * 源文件是 `B001-主题-1-防幻觉-…`（106 份），积木是 `B001-s-级-改改措辞就能进-rules-…`（28 块）。
 * **同一个 B001 指两个文件。** 统一索引里必须带 `ns`（src / note / block），
 * 唯一键是 `ns:id`——`src:B001` 与 `block:B001` 是两条，不是一条。
 *
 * ## 为什么不接进 check 链
 *
 * 归档是冻结快照。索引它，`--check` 永远零漂移——一条永远绿的闸门，
 * 跟 schema:verify 空转 8 天是同一个形状（2026-10-29 抓到的病）。
 * 所以 `--check` 只作为「快照没被手改」的取证工具，**不进 npm run check**。
 *
 * ## 四个源（2026-10-31 按归档 README 纠正）
 *
 *   src    docs/vault-notes/               外部原文（8 份，**唯一可信源**）
 *   note   .ai/notes/                      自研笔记（12 份，含 prompts-mining/ 子目录）
 *   block  .ai/output/library/             当前派生积木（28 块）
 *   hist   .ai/archive/library/<日期>/     历史派生积木（106 份）
 *
 * 第一版把 `hist` 当成 `src` 索引，是错的——`.ai/archive/library/2026-10-08/`
 * 的 README 第一句就是「这是历史归档，不是工作区」，那 105 份是 `library-build`
 * 当年切出来的派生视图，`source:` 多已指向不存在的路径。真正的原文在
 * `docs/vault-notes/`。**索引历史可以，但必须标成 hist，不能混进 src。**
 *
 * ## 用法
 *
 *   node tools/knowledge.mjs            重建 knowledge.json
 *   node tools/knowledge.mjs --check    只比对，不写；漂移则退 1
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseBlock } from './library-index.mjs'
import { diffKeys, runIndexTool } from './lib/index-io.mjs'

const OUT = '.ai/output/knowledge.json'
const SOURCES = [
  { ns: 'src', dir: 'docs/vault-notes', test: /\.md$/ },
  { ns: 'note', dir: '.ai/notes', test: /\.md$/ },
  { ns: 'block', dir: '.ai/output/library', test: /^B\d{3}-.+\.md$/ },
  { ns: 'hist', dir: '.ai/archive/library', test: /\.md$/ },
]

/** 递归列出相对路径（正斜杠）。目录不存在返回空数组，不抛。 */
function walk(dir, test, prefix = '') {
  if (!existsSync(dir)) return []
  const out = []
  for (const d of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name
    if (d.isDirectory()) out.push(...walk(dir, test, rel))
    else if (test.test(d.name)) out.push(rel)
  }
  return out.sort()
}

/** 单个文件 → 索引项。block 走 library-index 的 parseBlock，不另写一套解析。 */
export function entryOf(ns, dir, rel) {
  const abs = join(dir, rel)
  const chars = readFileSync(abs, 'utf8').length
  const name = rel.split('/').pop()
  if (ns === 'block') {
    const b = parseBlock(name, chars)
    return b ? { ns, ...b, path: abs } : null
  }
  const stem = rel.replace(/\.md$/, '')
  const numbered = /^B(\d{3})-(.+)$/.exec(name.replace(/\.md$/, ''))
  return {
    ns,
    id: numbered ? `B${numbered[1]}` : stem,
    topic: numbered ? numbered[2] : stem,
    path: abs,
    chars,
  }
}

/** 扫三个源，出统一索引。不写盘。 */
export function buildKnowledge() {
  const entries = []
  const sources = []
  for (const { ns, dir, test } of SOURCES) {
    const files = walk(dir, test)
    const got = files.map((rel) => entryOf(ns, dir, rel)).filter(Boolean)
    entries.push(...got)
    sources.push({ ns, dir, count: got.length })
  }
  return { sources, entries }
}

/** 零漂移判据：ns:id:path:chars 四元组全等。改一个字都算。 */
const KEY = (e) => `${e.ns}:${e.id}:${e.path}:${e.chars}`
export function diffKnowledge(expected, actual) {
  return diffKeys(expected, actual, KEY, 'entries')
}

function main() {
  runIndexTool({
    argv: process.argv.slice(2),
    build: buildKnowledge,
    field: 'entries',
    out: OUT,
    label: 'knowledge.json',
    keyOf: KEY,
    prefix: '[knowledge]',
    empty: '三个源都没扫到文件，先确认 .ai/ 下有没有资料',
    summary: (i) => {
      const byNs = i.sources.map((s) => `${s.ns} ${s.count}`).join(' / ')
      const chars = i.entries.reduce((n, e) => n + e.chars, 0)
      return `${i.entries.length} 条（${byNs}）/ ${chars} 字 → ${OUT}`
    },
  })
}

if (process.argv[1] && process.argv[1].endsWith('knowledge.mjs')) main()
