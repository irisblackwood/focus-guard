#!/usr/bin/env node
/**
 * memory:audit（4.5 M1，2026-11-02）——列出记忆的三类载体，只读。
 *
 * 收益：M1 验收要求一条命令说清「记忆存在哪、多大、索引有没有」。
 * 改动面：本文件 + package.json 一行 script，不跨层。
 * 替代：无更小做法——验收命令需要一个真实入口。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
      const n = (j.decisions?.length || 0) + (j.constraints?.length || 0) + (j.next?.length || 0)
      return `${raw.length} 字节 · workspace_hash=${j.workspace_hash || '—'} · 条目 ${n}`
    },
  },
  {
    key: 'case-file',
    label: '四册卷宗',
    path: join(REPO, '.ai', 'CASE_FILE.md'),
    describe: (p) => {
      const raw = readFileSync(p, 'utf8')
      const sections = (raw.match(/^#{1,6}\s*【[一二三四五六七八九十]+】/gm) || []).length
      return `${raw.length} 字节 · 章节 ${sections}`
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
      return `现行 ${live} 份 · 归档 ${archive} 份 · 索引 ${existsSync(idx) ? '有' : '无'}`
    },
  },
]

let bad = 0
for (const c of carriers) {
  if (!existsSync(c.path)) {
    process.stdout.write(`${c.key}\t${c.label}\tMISSING\t${c.path}\n`)
    bad++
    continue
  }
  statSync(c.path)
  process.stdout.write(`${c.key}\t${c.label}\tOK\t${c.describe(c.path)}\n`)
}
process.exitCode = bad ? 1 : 0
