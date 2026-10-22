#!/usr/bin/env node
/**
 * 死闸审计（2026-10-22）：把"判定条件里引用的参数键 / 工具名"与**真实会话里的工具 schema** 对账。
 *
 * 病根（两次实测）：
 *   ① `grep` 体积闸要求 `args.output_mode === 'content' && !args.head_limit`，
 *      而真实 DSH grep 只有 `{pattern,path,include}` → 条件永不成立；
 *   ② 整文件闸/取证闸拿相对路径直接 statSync（按宿主 cwd 解析）→ ENOENT → 静默放行。
 * 共同特征：**判定写在合成参数上**，测试用合成数据全绿，线上百发百中漏。
 *
 * 本工具只读会话记录，不做判定；输出两类清单：
 *   A. 源码引用但真实 schema 里不存在的参数键（可能是死闸）
 *   B. 真实目录里既不算只读、也不算改动、也不算 shell 的工具（分类盲区）
 *
 * 用法：node packages/core/tools/gate-audit.mjs [--limit 20] [--json]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, '..')
const SESSIONS = process.env.FG_SESSIONS_DIR || 'E:/DSH/.dsh/sessions'

const argv = process.argv.slice(2)
const LIMIT = Number(argv.includes('--limit') ? argv[argv.indexOf('--limit') + 1] : 20) || 20
const AS_JSON = argv.includes('--json')

function walk(dir, out = []) {
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else if (e === 'session.v4.jsonl.zstd') out.push({ file: p, mtime: st.mtimeMs })
  }
  return out
}

/** 多帧 zstd：按魔数 0x28B52FFD 分帧解压（单帧 API 只解第一帧）。 */
function decode(file) {
  const buf = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
    } catch {
      /* 跳过坏帧 */
    }
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** 从会话里取真实工具表：{ 工具名: Set(参数键) }。 */
function realToolSchema(limit) {
  const files = walk(SESSIONS).sort((a, b) => b.mtime - a.mtime).slice(0, limit)
  const schema = new Map()
  let usedSessions = 0
  for (const f of files) {
    const lines = decode(f.file)
    const header = lines.find((l) => l.type === 'request/header') || null
    // 真实结构：{data:{header:{config,adapterDefaults,tools:[{name,description,parameters}]}, reason}}
    const h = header && header.data ? header.data.header || header.data : null
    const tools = (h && (h.tools || h.toolList)) || (header && header.data && header.data.tools) || null
    if (!Array.isArray(tools)) continue
    usedSessions += 1
    for (const t of tools) {
      const name = String(t && t.name)
      if (!name) continue
      const keys = schema.get(name) || new Set()
      const props = (t.parameters && t.parameters.properties) || {}
      for (const k of Object.keys(props)) keys.add(k)
      schema.set(name, keys)
    }
  }
  return { schema, usedSessions }
}

/** 源码里引用过的参数键：args.xxx / arguments.xxx / ti.xxx（只取 dsh 侧判定文件），带行号。 */
function referencedKeys() {
  const files = ['src/dsh/pipeline.mjs', 'src/dsh/preGuard.mjs', 'src/adapters/dsh/eligibility-gate.mjs']
  const keys = new Map()
  for (const rel of files) {
    let src = ''
    try {
      src = readFileSync(join(CORE, rel), 'utf8')
    } catch {
      continue
    }
    const lines = src.split('\n')
    lines.forEach((line, idx) => {
      for (const m of line.matchAll(/\b(?:args|arguments|ti)\.([A-Za-z_$][\w$]*)/g)) {
        const k = m[1]
        if (!keys.has(k)) keys.set(k, [])
        keys.get(k).push(`${rel}:${idx + 1}`)
      }
    })
  }
  return keys
}

const READ = /^(?:Read|Grep|Glob|read_image|NotebookRead|read|grep|glob|read_image|web_search|web_fetch|list_\w+|get_\w+|search|query_\w+)$/i
const MUT = /^(?:write|edit|multiedit|patch|applypatch|notebookedit|plugin_manager|move_run|import_claude|claude_export)$/i
const MUT_MCP =
  /^mcp__[\s\S]+?__(?:write|create|update|delete|remove|move|copy|patch|apply|edit|save|install|uninstall|build|package|scaffold|deploy|upload|publish)_/i
const SHELL = /^(?:bash|shell|sh|pwsh|powershell|cmd|terminal|runcommand)$/i

const { schema, usedSessions } = realToolSchema(LIMIT)
const union = new Set()
for (const keys of schema.values()) for (const k of keys) union.add(k)
const refs = referencedKeys()

const ghost = []
for (const [k, where] of refs) {
  if (!union.has(k)) ghost.push({ key: k, sites: where.slice(0, 6), count: where.length })
}

const blind = []
for (const name of schema.keys()) {
  if (READ.test(name) || MUT.test(name) || MUT_MCP.test(name) || SHELL.test(name)) continue
  blind.push(name)
}

const report = {
  sessions: usedSessions,
  tools: schema.size,
  ghostKeys: ghost.sort((a, b) => a.key.localeCompare(b.key)),
  unclassifiedTools: blind.sort(),
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`扫描会话 ${report.sessions} 个，工具 ${report.tools} 个`)
  console.log(`\nA. 源码引用但真实 schema 无此键（${ghost.length}）——可能是死闸：`)
  for (const g of report.ghostKeys) console.log(`  ${g.key}  ← ${g.sites.join(', ')}${g.count > g.sites.length ? ` …(+${g.count - g.sites.length})` : ''}`)
  console.log(`\nB. 既不算只读/改动/shell 的工具（${blind.length}）——分类盲区：`)
  for (const t of report.unclassifiedTools) console.log(`  ${t}`)
}
process.exit(0)
