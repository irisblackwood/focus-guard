#!/usr/bin/env node
/**
 * 真实调用夹具导出（2026-10-22）——防"手写参数自欺"。
 *
 * 病根：合成测试之所以能骗过自己，是因为**测试输入由实现作者手写**：写 `head_limit`
 * 的人，测试里就有 `head_limit`。真实模型发的是另一套参数（`{pattern,path,include}`）。
 * 本工具只做一件事：把**真实会话里的 (工具名, 参数, 判定结果)** 原样导出成夹具，
 * 测试只准读这些夹具。手写参数仅作为补充，且必须在测试里标注「合成」。
 *
 * 用法：
 *   node packages/core/tools/capture-fixtures.mjs              # 写到 tests/fixtures/real-calls/
 *   node packages/core/tools/capture-fixtures.mjs --limit 40    # 最多扫 40 个会话
 *   node packages/core/tools/capture-fixtures.mjs --since 24h   # 只取最近 24h
 */

import { decodeSession as decode } from './lib/sessionDump.mjs'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, '..')
const SESSIONS = process.env.FG_SESSIONS_DIR || 'E:/DSH/.dsh/sessions'
const OUT = join(CORE, 'tests', 'fixtures', 'real-calls')

const argv = process.argv.slice(2)
const LIMIT = Number(argv.includes('--limit') ? argv[argv.indexOf('--limit') + 1] : 30) || 30
const MAX_BYTES = 3 * 1024 * 1024

// 判定为「被拦」的真实文案（与 collect-panel / gate-audit 同口径）
// 判定为「被拦」：必须命中 FG 自己的**拒绝措辞**，不能只是文本里出现"禁/红线/拦截"这类词。
// 2026-10-22 教训：宽松正则把专家团任务描述（含"禁"“红线"）全判成 deny，夹具一跑就假阳性。
const DENY_RE =
  /focus-guard-native|该工具需先调 fg_apply|命中绝对红线|整文件闸|体积刺客|本机环境[：:]用|第\s*3\s*层状态校验|卷宗无取证记录|反规避抽查B|改动类工具/
// 拒绝必须以 Error 开头：成功结果里也可能出现上面这些词（例如读的是 FG 自己的源码）。
const DENY_PREFIX_RE = /^\s*Error[:：]/
const DENY_ZCODE_RE = /^\s*【拦截】/

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
    else if (e === 'session.v4.jsonl.zstd') out.push({ f: p, m: st.mtimeMs, size: st.size })
  }
  return out
}

/** 截断过长的参数值（content/command 可能上千字），只保留形状。 */
function compactArg(value, limit = 160) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…(${value.length})` : value
  if (Array.isArray(value)) return value.slice(0, 6).map((v) => compactArg(v, limit))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = compactArg(v, limit)
    return out
  }
  return value
}

const files = walk(SESSIONS)
  .filter((x) => x.size < MAX_BYTES)
  .sort((a, b) => b.m - a.m)
  .slice(0, LIMIT)

const fixtures = []
const passPerTool = new Map()

for (const { f } of files) {
  let lines
  try {
    lines = decode(f)
  } catch {
    continue
  }
  const sid = basename(dirname(f)).replace('session-', '').slice(0, 8)
  const calls = new Map()
  for (const l of lines) {
    if (l.type === 'tool/call') {
      let args = {}
      try {
        args = JSON.parse(l.data.arguments || '{}')
      } catch {
        args = { _raw: String(l.data.arguments || '').slice(0, 200) }
      }
      calls.set(l.data.callId, { name: l.data.name, args, turn: l.data.turn, step: l.data.step })
    }
  }
  for (const l of lines) {
    if (l.type !== 'tool/result') continue
    const call = calls.get(l.data.toolCallId || (l.data.message && l.data.message.toolCallId))
    if (!call) continue
    const content = (l.data.message && l.data.message.content) || []
    const text = JSON.stringify(content)
    // 判定"被拦"必须看**结果的首个文本块是否以 Error 开头**：
    // 2026-10-22 教训：成功结果里也会出现"整文件闸""拦截"等字样（读的是 FG 自己的源码），
    // 用全文正则匹配会把成功读取误判成拦截，夹具一重放就露馅。
    const firstText = String((content.find((c) => c && c.type === 'text') || {}).text || '')
    const denied = DENY_PREFIX_RE.test(firstText) || DENY_ZCODE_RE.test(firstText)
    if (!denied) {
      const n = passPerTool.get(call.name) || 0
      if (n >= 2) continue // 放行样本每工具最多留 2 条，避免夹具膨胀
      passPerTool.set(call.name, n + 1)
    }
    // 参数必须**原样**保留：截断过的参数会让重放判定失真（2026-10-22 实测：
    // 截断后的路径不再是目录 → Grep 未收窄闸不触发 → 夹具自己假阳性）。
    // 过大参数整条跳过，而不是截断。
    const argJson = JSON.stringify(call.args)
    if (argJson.length > 4000) continue
    fixtures.push({
      source: { session: sid, turn: call.turn, step: call.step },
      tool: call.name,
      args: call.args,
      verdict: denied ? 'deny' : 'pass',
      reason: denied ? text.replace(/\\n/g, ' ').slice(0, 160) : null,
    })
  }
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

fixtures.forEach((fx, i) => {
  writeFileSync(join(OUT, `call-${String(i + 1).padStart(3, '0')}-${fx.verdict}.json`), JSON.stringify(fx, null, 2) + '\n')
})

writeFileSync(
  join(OUT, 'manifest.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sessions: files.length,
      total: fixtures.length,
      deny: fixtures.filter((f) => f.verdict === 'deny').length,
      pass: fixtures.filter((f) => f.verdict === 'pass').length,
      byTool: fixtures.reduce((acc, f) => ((acc[f.tool] = (acc[f.tool] || 0) + 1), acc), {}),
    },
    null,
    2,
  ) + '\n',
)

writeFileSync(
  join(OUT, 'README.md'),
  `# 真实调用夹具（自动生成，禁止手改）

由 \`node packages/core/tools/capture-fixtures.mjs\` 从**真实会话**导出：
每条 = 一次真实 \`tool/call\` 的参数形状 + 宿主返回的 \`tool/result\` 判定。

- \`verdict: "deny"\` = 当时 FG 拦下了（真实拦截文案前 160 字）
- \`verdict: "pass"\` = 当时放行（每工具最多 2 条）

**纪律**：测试只准读这里 + 自己的合成参数（合成必须标注）。手改本目录等于毁掉证据链。
`,
)

console.log(`[capture-fixtures] 写出 ${fixtures.length} 条（deny ${fixtures.filter((f) => f.verdict === 'deny').length} / pass ${fixtures.filter((f) => f.verdict === 'pass').length}）→ ${OUT}`)
