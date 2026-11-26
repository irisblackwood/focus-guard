#!/usr/bin/env node
/**
 * memory:recall（2026-11-24）—— 结构化记忆 vs 向量检索 的离线召回评测
 *
 * 目的：回答「FG 的结构化记忆注入」与「按查询检索记忆」哪个更准、哪个更省 token。
 *
 * 语料（memory units，两种方法用同一份）：
 *   - `.focus-guard/workspace.json` 的 decisions / constraints / next_action（每条一个 unit）
 *   - `.ai/CASE_FILE.md` 按 `##`/`###` 切段（每段一个 unit）
 *
 * 语料口径（2026-11-26 收紧）：`decisions` 里**只收带标签的条目**（`[goal]` / `[done]` / `[note]`，
 * 复用 `src/memory/tags.mjs` 的 `parseTag`/`stripTag`）。无标签的一律**排除并只计数**——
 * 自动落账已于 2026-11-26 下架（`memory/workspace.mjs` 头部有下架声明），存量那些是
 * 「本轮人类指令原文」，拿它们当语料等于用垃圾测垃圾：测出来的 100% 只能证明「全量注入包含全量」。
 *
 * 空语料不算通过：`units` 或可标注查询为 0 时**不打印召回率**，直接报「结论无效」并 exit 2。
 * 理由同上——这张表会被断章取义成「检索方案已验证」。
 *
 * 查询（queries）：本工作区历史会话里的用户消息（每条 ≥ 12 字、去重），来自 session.v4 日志。
 *
 * 相关性标注（qrels，判定与两种检索都独立）：
 *   查询与 unit 的**词项 Jaccard** ≥ `--jaccard`（默认 0.12）；没有命中的查询跳过并计数。
 *   这是启发式标注，不是人工 qrels——报告里必须写明，结论只能看相对差。
 *
 * 两种方法：
 *   S 结构化：把**全部** memory units 注入（模拟当前 FG 行为），token = 全量单位字数/3；
 *   V 向量：TF-IDF 稀疏向量（离线、零依赖；不是神经语义向量），按余弦取 top-k，token = 命中单位字数/3。
 *
 * 指标：Recall@k、MRR、平均注入 token；另报检索耗时。
 *
 * 用法：
 *   node packages/core/tools/memory-recall-eval.mjs
 *   node packages/core/tools/memory-recall-eval.mjs --k 5 --jaccard 0.1 --json
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeSession, walkSessionFiles } from './lib/sessionDump.mjs'
import { parseTag, stripTag } from '../src/memory/tags.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const args = process.argv.slice(2)
const pick = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : null
}
const K = Number(pick('--k') || 3)
const JACCARD = Number(pick('--jaccard') || 0.12)
const asJson = args.includes('--json')

const STOP = new Set(
  ('the a an and or of to in for on with is are was were be been it this that these those i you we they he she ' +
    '我 你 他 她 它 我们 你们 他们 这 那 这个 那个 的 了 是 在 和 与 或 就 都 也 还 把 被 对 从 到 向 给 让 一个 一些 什么 怎么 为什么 不 没 有 要 能 会 可以 已经 需要 应该 现在 然后 但是 因为 所以')
    .split(/\s+/)
    .filter(Boolean),
)

function terms(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[^\p{L}\p{N}_$-]+/gu, ' ')
  return t
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP.has(w))
}

function jaccard(a, b) {
  const A = new Set(a)
  const B = new Set(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter += 1
  return inter / (A.size + B.size - inter)
}

// ── 1) memory units ──
const units = []
function addUnit(kind, text) {
  const body = String(text || '').trim()
  if (!body) return
  units.push({ id: `${kind}#${units.length}`, kind, text: body, terms: terms(body) })
}
// 下架前的存量：无标签的 decisions 一律不进语料，只计数（见文件头「语料口径」）。
let legacyPrompts = 0
const wsFile = process.env.FG_WORKSPACE_FILE || join(ROOT, '.focus-guard', 'workspace.json')
if (existsSync(wsFile)) {
  const ws = JSON.parse(readFileSync(wsFile, 'utf8'))
  for (const x of ws.decisions || []) {
    const s = String(x ?? '').trim()
    if (!s) continue
    if (parseTag(s)) addUnit('decision', stripTag(s))
    else legacyPrompts += 1
  }
  for (const x of ws.constraints || []) addUnit('constraint', x)
  for (const x of ws.next_action || []) addUnit('next_action', x)
}
const caseFile = process.env.FG_CASE_FILE || join(ROOT, '.ai', 'CASE_FILE.md')
if (existsSync(caseFile)) {
  const sections = readFileSync(caseFile, 'utf8').split(/^#{2,3} /m).slice(1)
  for (const sec of sections) addUnit('case', sec.slice(0, 1200))
}

// ── 2) queries ──
const queries = []
const seen = new Set()
for (const { f } of walkSessionFiles(join(ROOT, '..', '.dsh', 'sessions'))) {
  let lines
  try {
    lines = decodeSession(f)
  } catch {
    continue
  }
  for (const j of lines) {
    if (j.type !== 'user/message') continue
    const msg = j.data && (j.data.message || j.data)
    const content = msg && msg.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((b) => b && b.type === 'text')
              .map((b) => b.text || '')
              .join(' ')
          : ''
    const q = String(text || '').trim()
    if ([...q].length < 12) continue
    if (seen.has(q)) continue
    seen.add(q)
    const sid = f.replace(/\\/g, '/').split('/').slice(-2, -1)[0] || ''
    queries.push({ q, sid, terms: terms(q) })
  }
}

// ── 3) qrels ──
const labelled = []
for (const q of queries) {
  const rel = units.filter((u) => jaccard(q.terms, u.terms) >= JACCARD).map((u) => u.id)
  if (rel.length) labelled.push({ ...q, rel })
}

// ── 4) 结构化基线：全量注入 ──
const allTokens = Math.round(units.reduce((a, u) => a + u.text.length, 0) / 3)
const structured = { name: 'S 结构化全量', recallAtK: null, mrr: null, tokensPerQuery: allTokens, latencyMs: 0 }
{
  let hit = 0
  for (const q of labelled) {
    // 全量注入：所有 relevant 都在上下文里 → Recall 恒为 100%；
    // MRR 对"全量"无意义（没有排序），留空而不是写 1.0 假装。
    hit += 1
  }
  structured.recallAtK = labelled.length ? hit / labelled.length : null
  structured.mrr = null
}

// ── 5) 向量检索：TF-IDF 稀疏向量 + 余弦 ──
const df = new Map()
for (const u of units) for (const w of new Set(u.terms)) df.set(w, (df.get(w) || 0) + 1)
const N = units.length || 1
const idf = (w) => Math.log((N + 1) / ((df.get(w) || 0) + 1)) + 1
function embed(t) {
  const m = new Map()
  for (const w of t) m.set(w, (m.get(w) || 0) + idf(w))
  let norm = 0
  for (const v of m.values()) norm += v * v
  norm = Math.sqrt(norm) || 1
  for (const [w, v] of m) m.set(w, v / norm)
  return m
}
const unitVec = new Map(units.map((u) => [u.id, embed(u.terms)]))
function cosine(a, b) {
  let s = 0
  for (const [w, v] of a) {
    const o = b.get(w)
    if (o) s += v * o
  }
  return s
}

const t0 = process.hrtime.bigint()
const vectorHits = []
for (const q of labelled) {
  const qv = embed(q.terms)
  const ranked = units
    .map((u) => ({ id: u.id, score: cosine(qv, unitVec.get(u.id)), len: u.text.length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, K)
  const relSet = new Set(q.rel)
  const hit = ranked.filter((r) => relSet.has(r.id))
  vectorHits.push({
    hit: hit.length ? 1 : 0,
    rr: hit.length ? 1 / (ranked.findIndex((r) => relSet.has(r.id)) + 1) : 0,
    tokens: Math.round(ranked.reduce((a, r) => a + r.len, 0) / 3),
  })
}
const elapsed = Number(process.hrtime.bigint() - t0) / 1e6
const vector = {
  name: `V 向量 top-${K}`,
  recallAtK: vectorHits.length ? vectorHits.reduce((a, r) => a + r.hit, 0) / vectorHits.length : null,
  mrr: vectorHits.length ? vectorHits.reduce((a, r) => a + r.rr, 0) / vectorHits.length : null,
  tokensPerQuery: vectorHits.length ? Math.round(vectorHits.reduce((a, r) => a + r.tokens, 0) / vectorHits.length) : null,
  latencyMs: Number((elapsed / Math.max(1, vectorHits.length)).toFixed(3)),
}

// ── 5.5) 混合：常驻「必须保证」的条目 + 其余走向量 top-k ──
const PIN_RE = /红线|禁止|不得|必须|不要|不能|约束|goal|目标/i
const decisionUnits = units.filter((u) => u.kind === 'decision')
// 钉选策略（可调）：约束/下一步 + **最近 3 条决策**。理由是近期决定比远期更可能被引用。
const recentDecisions = new Set(decisionUnits.slice(-3).map((u) => u.id))
const pinned = units.filter(
  (u) => u.kind === 'constraint' || u.kind === 'next_action' || recentDecisions.has(u.id) || PIN_RE.test(u.text),
)
const pinnedIds = new Set(pinned.map((u) => u.id))
const retrievable = units.filter((u) => !pinnedIds.has(u.id))
const pinnedTokens = Math.round(pinned.reduce((a, u) => a + u.text.length, 0) / 3)
const rVec = new Map(retrievable.map((u) => [u.id, embed(u.terms)]))
const hybridHits = []
const th0 = process.hrtime.bigint()
for (const q of labelled) {
  const qv = embed(q.terms)
  const ranked = retrievable
    .map((u) => ({ id: u.id, score: cosine(qv, rVec.get(u.id)), len: u.text.length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, K)
  const relSet = new Set(q.rel)
  const pinnedHit = q.rel.some((id) => pinnedIds.has(id))
  const vectorHit = ranked.some((r) => relSet.has(r.id))
  hybridHits.push({
    hit: pinnedHit || vectorHit ? 1 : 0,
    tokens: pinnedTokens + Math.round(ranked.reduce((a, r) => a + r.len, 0) / 3),
  })
}
const hybridElapsed = Number(process.hrtime.bigint() - th0) / 1e6
const hybrid = {
  name: `H 混合（钉 ${pinned.length} 条 + top-${K}）`,
  recallAtK: hybridHits.length ? hybridHits.reduce((a, r) => a + r.hit, 0) / hybridHits.length : null,
  mrr: null,
  tokensPerQuery: hybridHits.length ? Math.round(hybridHits.reduce((a, r) => a + r.tokens, 0) / hybridHits.length) : null,
  latencyMs: Number((hybridElapsed / Math.max(1, hybridHits.length)).toFixed(3)),
  pinned: pinned.map((u) => u.kind),
}

const byKind = {}
for (const u of units) byKind[u.kind] = (byKind[u.kind] || 0) + 1
// 结论无效的两种情形：语料空 / 标注空。都不打印召回率——空集上的 100% 是假象。
const invalidReason =
  units.length === 0
    ? '语料为空（无带标签结论、无约束、无 CASE 段）'
    : labelled.length === 0
      ? `语料 ${units.length} 条，但没有一条与查询相关（标注 0 条）`
      : null

const report = {
  generatedAt: new Date().toISOString(),
  units: units.length,
  byKind,
  legacyPrompts,
  queries: queries.length,
  labelled: labelled.length,
  k: K,
  jaccardThreshold: JACCARD,
  note: '向量=TF-IDF 稀疏向量（离线），不是神经语义向量；qrels 为词项 Jaccard 启发式，结论只看相对差',
  conclusionInvalid: invalidReason,
  methods: [structured, vector, hybrid],
}

// ── 6) 可选：会话级语料（更大、更像真实跨会话召回）──
if (args.includes('--sessions')) {
  const chunks = []
  for (const { f } of walkSessionFiles(join(ROOT, '..', '.dsh', 'sessions'))) {
    let lines
    try {
      lines = decodeSession(f)
    } catch {
      continue
    }
    const sid = f.replace(/\\/g, '/').split('/').slice(-2, -1)[0] || ''
    let buf = ''
    let lastTurn = null
    const flush = () => {
      const text = buf.trim()
      if ([...text].length >= 40) chunks.push({ id: `chunk#${chunks.length}`, sid, text: text.slice(0, 800), terms: terms(text) })
      buf = ''
    }
    for (const j of lines) {
      if (j.type !== 'user/message' && j.type !== 'assistant/message') continue
      const msg = j.data && (j.data.message || j.data)
      const content = msg && msg.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ')
            : ''
      if (!text) continue
      const turn = j.data && j.data.turn
      if (lastTurn !== null && turn !== lastTurn) {
        flush()
      }
      lastTurn = turn
      buf += ' ' + text
      if ([...buf].length > 800) flush()
    }
    flush()
  }
  const cdf = new Map()
  for (const c of chunks) for (const w of new Set(c.terms)) cdf.set(w, (cdf.get(w) || 0) + 1)
  const CN = chunks.length || 1
  const cidf = (w) => Math.log((CN + 1) / ((cdf.get(w) || 0) + 1)) + 1
  const cvec = (t) => {
    const m = new Map()
    for (const w of t) m.set(w, (m.get(w) || 0) + cidf(w))
    let n = 0
    for (const v of m.values()) n += v * v
    n = Math.sqrt(n) || 1
    for (const [w, v] of m) m.set(w, v / n)
    return m
  }
  const chunkVec = new Map(chunks.map((c) => [c.id, cvec(c.terms)]))
  const relabel = []
  for (const q of queries) {
    const rel = chunks.filter((c) => c.sid !== q.sid && jaccard(q.terms, c.terms) >= JACCARD).map((c) => c.id)
    if (rel.length) relabel.push({ ...q, rel })
  }
  const hits = []
  let tokens = 0
  let structHits = 0
  const hybHits = []
  let hybTokens = 0
  const t1 = process.hrtime.bigint()
  for (const q of relabel) {
    // 结构化基线在同一任务上的"召回归属"：qrel 命中的会话片段，其词项是否被 FG 记忆覆盖
    // （记忆全是短条目，命中按 0.3 Jaccard 算覆盖；这是摘要保真度代理，不是逐字包含）。
    const chunkById = new Map(chunks.map((c) => [c.id, c]))
    const covered = q.rel.some((id) => {
      const c = chunkById.get(id)
      if (!c) return false
      return units.some((u) => jaccard(c.terms, u.terms) >= 0.3)
    })
    structHits += covered ? 1 : 0
    const qv = cvec(q.terms)
    const ranked = chunks
      .map((c) => ({ id: c.id, score: cosine(qv, chunkVec.get(c.id)), len: c.text.length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, K)
    const relSet = new Set(q.rel)
    const idx = ranked.findIndex((r) => relSet.has(r.id))
    const vhit = idx >= 0 ? 1 : 0
    hits.push(vhit)
    const chunkTokens = ranked.reduce((a, r) => a + r.len, 0) / 3
    tokens += chunkTokens
    hybHits.push(covered || vhit ? 1 : 0)
    hybTokens += pinnedTokens + chunkTokens
  }
  const el = Number(process.hrtime.bigint() - t1) / 1e6
  report.sessionCorpus = {
    chunks: chunks.length,
    labelled: relabel.length,
    recallAtK: relabel.length ? hits.reduce((a, b) => a + b, 0) / relabel.length : null,
    structuredCoverage: relabel.length ? structHits / relabel.length : null,
    hybridRecall: relabel.length ? hybHits.reduce((a, b) => a + b, 0) / relabel.length : null,
    hybridTokensPerQuery: relabel.length ? Math.round(hybTokens / relabel.length) : null,
    tokensPerQuery: relabel.length ? Math.round(tokens / relabel.length) : null,
    latencyMs: Number((el / Math.max(1, relabel.length)).toFixed(3)),
  }
}

if (asJson) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`[memory:recall] units=${units.length} queries=${queries.length} labelled=${labelled.length} k=${K} jaccard=${JACCARD}`)
  console.log(
    `  语料构成：带标签结论 ${byKind.decision || 0} · 被否命令 ${byKind.constraint || 0} · ` +
      `下一步 ${byKind.next_action || 0} · CASE 段 ${byKind.case || 0}`,
  )
  if (legacyPrompts) {
    console.log(
      `  已排除：无标签 decisions ${legacyPrompts} 条（自动落账已于 2026-11-26 下架，指令原文不再算语料）`,
    )
  }
  if (invalidReason) {
    console.log(`\n  ⚠ 结论无效：${invalidReason}。`)
    console.log('    不打印召回率——空语料上的 100% 会被读成「检索已验证」。')
    console.log('    要有可用语料，先等 `fg_memory_note` 写出带标签的结论（VERSION-PLAN §1.8 步 1）。')
  } else {
    for (const m of report.methods) {
      console.log(
        `  ${m.name.padEnd(14)} Recall@${K}=${m.recallAtK == null ? '-' : (m.recallAtK * 100).toFixed(1) + '%'}  ` +
          `MRR=${m.mrr == null ? '-' : m.mrr.toFixed(3)}  tokens/query=${m.tokensPerQuery}  latency=${m.latencyMs}ms`,
      )
    }
    console.log(`  注：${report.note}`)
  }
  if (report.sessionCorpus) {
    const s = report.sessionCorpus
    console.log(
      `  [会话语料] chunks=${s.chunks} labelled=${s.labelled}  ` +
        `V Recall@${K}=${s.recallAtK == null ? '-' : (s.recallAtK * 100).toFixed(1) + '%'}  ` +
        `H Recall=${s.hybridRecall == null ? '-' : (s.hybridRecall * 100).toFixed(1) + '%'}  ` +
        `S 覆盖=${s.structuredCoverage == null ? '-' : (s.structuredCoverage * 100).toFixed(1) + '%'}  ` +
        `V tokens=${s.tokensPerQuery}  H tokens=${s.hybridTokensPerQuery}  latency=${s.latencyMs}ms`,
    )
  }
}

// exit 2 专指「没测出东西」，与 1（脚本自身出错）区分开：方便外面一眼分辨是缺语料还是坏了。
if (invalidReason) process.exitCode = 2
