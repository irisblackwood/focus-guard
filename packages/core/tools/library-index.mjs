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
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
export function diffIndex(expected, actual) {
  const key = (b) => `${b.id}|${b.file}|${b.chars}`
  const a = new Set((expected.blocks || []).map(key))
  const b = new Set((actual.blocks || []).map(key))
  return {
    missing: [...a].filter((k) => !b.has(k)),
    extra: [...b].filter((k) => !a.has(k)),
  }
}

function main() {
  const argv = process.argv.slice(2)
  const index = buildIndex()
  if (!index.blocks.length) {
    console.error(`[library-index] ${DIR} 下没有积木，先跑 library-build`)
    process.exit(2)
  }
  if (argv.includes('--check')) {
    if (!existsSync(OUT)) {
      console.error('[library-index] index.json 不存在，先跑一次不带 --check 的')
      process.exit(1)
    }
    const { missing, extra } = diffIndex(index, JSON.parse(readFileSync(OUT, 'utf8')))
    if (missing.length || extra.length) {
      console.error(`[library-index] 漂移：积木侧新增 ${missing.length} 条、索引侧多余 ${extra.length} 条`)
      for (const k of [...missing, ...extra].slice(0, 10)) console.error(`  ${k}`)
      process.exit(1)
    }
    console.log(`[library-index] 零漂移，${index.blocks.length} 块`)
    return
  }
  writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), ...index }, null, 2) + '\n')
  const graded = index.blocks.filter((b) => b.grade).length
  const total = index.blocks.reduce((n, b) => n + b.chars, 0)
  console.log(`[library-index] ${index.blocks.length} 块（分级结论 ${graded}）/ ${total} 字 → ${OUT}`)
}

if (process.argv[1] && process.argv[1].endsWith('library-index.mjs')) main()
