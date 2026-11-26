#!/usr/bin/env node
/**
 * memory:audit（4.5 M1，2026-11-02）——列出记忆的三类载体，只读。
 *
 * 收益：M1 验收要求一条命令说清「记忆存在哪、多大、索引有没有」。
 * 改动面：本文件 + package.json 一行 script，不跨层。
 * 替代：无更小做法——验收命令需要一个真实入口。
 *
 * 状态口径（2026-11-26 收紧）：`OK` 只说明**文件在**，不说明记忆健康。
 * 卷宗里若还有下架前的无标签 `decisions`（自动落账已于 2026-11-26 下架，见
 * `src/memory/workspace.mjs` 头部），标 `STALE` 并写明条数——那些是指令原文，不是结论。
 * 早期版本把它们算进「条目 N」并盖 OK，等于让体检报告替半成品背书。
 *
 * 退出码：0 = 全 OK；1 = 有载体缺失；2 = 文件都在但有存量待清理（不是坏了，是脏）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTag } from '../src/memory/tags.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')

const carriers = [
  {
    key: 'workspace',
    label: '跨会话卷宗',
    path: join(REPO, '.focus-guard', 'workspace.json'),
    describe: (p) => {
      const raw = readFileSync(p, 'utf8')
      const j = JSON.parse(raw)
      const decisions = (j.decisions || []).map((x) => String(x ?? '').trim()).filter(Boolean)
      const conclusions = decisions.filter((x) => parseTag(x)).length
      const legacy = decisions.length - conclusions
      const constraints = (j.constraints || []).length
      // 旧版读的是 `j.next`（字段名不存在，恒算 0），实际键是 `next_action`。
      const next = (j.next_action || []).length
      const detail =
        `${raw.length} 字节 · workspace_hash=${j.workspace_hash || '—'} · ` +
        `带标签结论 ${conclusions} · 被否命令 ${constraints} · 下一步 ${next}` +
        (legacy ? ` · 存量指令原文 ${legacy}（待清理，不注入）` : '')
      return { status: legacy ? 'STALE' : 'OK', detail }
    },
  },
  {
    key: 'case-file',
    label: '四册卷宗',
    path: join(REPO, '.ai', 'CASE_FILE.md'),
    describe: (p) => {
      const raw = readFileSync(p, 'utf8')
      const sections = (raw.match(/^#{1,6}\s*【[一二三四五六七八九十]+】/gm) || []).length
      return { status: 'OK', detail: `${raw.length} 字节 · 章节 ${sections}` }
    },
  },
  {
    key: 'library',
    label: '静态知识库',
    path: join(REPO, '.ai', 'library'),
    describe: (p) => {
      const idx = join(p, 'INDEX.md')
      const live = readdirSync(p).filter((f) => f.endsWith('.md') && f !== 'README.md').length
      const archiveRoot = join(REPO, '.ai', 'archive', 'library')
      let archive = 0
      if (existsSync(archiveRoot)) {
        for (const d of readdirSync(archiveRoot)) {
          try { archive += readdirSync(join(archiveRoot, d)).filter((f) => f.endsWith('.md')).length } catch {}
        }
      }
      return { status: 'OK', detail: `现行 ${live} 份 · 归档 ${archive} 份 · 索引 ${existsSync(idx) ? '有' : '无'}` }
    },
  },
]

let bad = 0
let stale = 0
for (const c of carriers) {
  if (!existsSync(c.path)) {
    process.stdout.write(`${c.key}\t${c.label}\tMISSING\t${c.path}\n`)
    bad++
    continue
  }
  statSync(c.path)
  const { status, detail } = c.describe(c.path)
  if (status === 'STALE') stale++
  process.stdout.write(`${c.key}\t${c.label}\t${status}\t${detail}\n`)
}
if (stale) {
  process.stdout.write(
    `\nSTALE ≠ 文件坏了：卷宗里还留着下架前的指令原文。` +
      `它们既不注入也不进评测语料；清掉用 \`fg case rm <序号>\` 逐条删，或删 \`.focus-guard/workspace.json\` 让下次落账重建。\n`,
  )
}
process.exitCode = bad ? 1 : stale ? 2 : 0
