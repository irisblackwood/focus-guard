#!/usr/bin/env node
/**
 * 【私有工具】资料积木索引（2026-10-31）
 *
 * 读 `.ai/output/library/*.md` 的文件名，落一份 `index.json` 当目录。
 * 产物落 `.ai/output/`——私有面，不入库、不随 npm 分发。
 *
 * ## 为什么只做文件名索引，不做内容索引
 *
 * 实测：118 份源文件 174,479 字，全量读一遍 ≈ 12 万 token，而 compaction 阈值 0.3，
 * 读不完。但积木的文件名本身已经是「编号-主题-来源」——索引项早就存在，只是没人读它。
 * 29 项合计 638 字符，比 118 条机器摘要（约 2,360 字）便宜四倍，且不会抽错主题。
 *
 * 内容级索引留到真有检索痛点再做。两套索引源 = 两个真相源，那是 3.3 修过的病。
 *
 * ## 命名规律（实测 28 块）
 *
 *   B001-s-级-改改措辞就能进-rules-注入前缀.md   分级结论：s/a/b 级
 *   B006-核心机制-anthropic.md                    主题 + 来源
 *
 * 认不出的写法不猜：整段原样进 `topic`，`grade`/`source` 留 null。
 *
 * ## 用法
 *
 *   node tools/library-index.mjs           重建 index.json
 *   node tools/library-index.mjs --check   只比对，不写；漂移则退 1
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { diffKeys, runIndexTool } from './lib/index-io.mjs'

const DIR = '.ai/output/library'
const OUT = join(DIR, 'index.json')
const SOURCES = ['anthropic', 'google', 'misc', 'openai', 'others', 'xai']

/** 文件名 → 索引项。认不出的一律不猜，整段当 topic。 */
export function parseBlock(file, chars) {
  const m = /^B(\d{3})-(.+)\.md$/.exec(file)
  if (!m) return null
  const [, num, rest] = m
  const item = { id: `B${num}`, file, grade: null, topic: rest, source: null, chars }
  const graded = /^([sab])-级-(.+)$/.exec(rest)
  if (graded) {
    item.grade = graded[1]
    item.topic = graded[2]
    return item
  }
  const tail = new RegExp(`^(.+)-(${SOURCES.join('|')})$`).exec(rest)
  if (tail) {
    item.topic = tail[1]
    item.source = tail[2]
  }
  return item
}

/** 扫目录，出索引对象。不写盘。 */
export function buildIndex(dir = DIR) {
  if (!existsSync(dir)) return { dir, blocks: [] }
  const blocks = readdirSync(dir)
    .filter((f) => /^B\d{3}-.+\.md$/.test(f))
    .sort()
    .map((f) => parseBlock(f, readFileSync(join(dir, f), 'utf8').length))
    .filter(Boolean)
  return { dir, blocks }
}

/** 零漂移判据：id/file/chars 三者全等。少一块、多一块、改一个字都算。 */
const KEY = (b) => `${b.id}|${b.file}|${b.chars}`
export function diffIndex(expected, actual) {
  return diffKeys(expected, actual, KEY, 'blocks')
}

function main() {
  runIndexTool({
    argv: process.argv.slice(2),
    build: buildIndex,
    field: 'blocks',
    out: OUT,
    label: 'index.json',
    keyOf: KEY,
    prefix: '[library-index]',
    empty: `${DIR} 下没有积木，先跑 library-build`,
    summary: (i) => {
      const graded = i.blocks.filter((b) => b.grade).length
      const total = i.blocks.reduce((n, b) => n + b.chars, 0)
      return `${i.blocks.length} 块（分级结论 ${graded}）/ ${total} 字 → ${OUT}`
    },
  })
}

if (process.argv[1] && process.argv[1].endsWith('library-index.mjs')) main()
