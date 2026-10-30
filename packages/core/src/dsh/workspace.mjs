/**
 * focus-guard 原生插件 · 跨会话防污染（L4，2026-10-18）
 *
 * DCR 的替代品，但**只做一件 DCR 没做对的事**：把持久状态绑死在工作区身份上。
 * DCR 的实测缺陷（见 AGENTS.md 卸载记录）：删会话、摘工作区、甚至**改文件夹名**之后，
 * 旧状态照样注入——因为它没有"这份状态属于哪个路径"的概念。
 *
 * 本模块的身份就是路径哈希：
 *   workspace_hash = sha256(realpath(cwd)) 前 16 位
 *   读的时候 hash 对不上 → 一条都不注入（路径不匹配即彻底屏蔽，零污染）
 *
 * 纪律（对齐 DCR 死因）：
 *   · 不 cancel、不 reject、不写 surface —— 只读文件、只追加系统提示 section；
 *   · 不伪造 user 消息（DSH 0.2 的 UserMessage 走 runtime context 投影，硬塞会断）；
 *   · 写失败只 warn，绝不阻断回合。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statePath, loadState } from '../core/state.mjs'

/** 默认落点：仓库根 `.focus-guard/workspace.json`（该目录已在 .gitignore）。 */
const WORKSPACE_FILE = fileURLToPath(new URL('../../../../.focus-guard/workspace.json', import.meta.url))

/** `FG_WORKSPACE_FILE` 可重定向——测试必须用它，否则会写进真实工作区。 */
export function workspaceFilePath() {
  return process.env.FG_WORKSPACE_FILE || WORKSPACE_FILE
}

/**
 * 条目标签（2026-10-30）：卷宗是**人格连续性**的载体，不是聊天记录，
 * 所以要能区分"长期目标"和"当下的一句话"。
 *
 * 只有四个状态，自由标签会失控：
 *   [goal] 长期目标——上限淘汰时永不挤掉
 *   [done] 已完成——**不注入**（僵尸记忆的主要来源）
 *   [note] 备注——**不注入**
 *   无标签 普通决策——按 FIFO
 *
 * 用文本前缀而不是结构化字段：零 schema 变更、可逆、人可直接编辑文件。
 */
export const CASE_TAGS = Object.freeze(['goal', 'done', 'note'])
const TAG_RE = /^\[(goal|done|note)\]\s*/i

/** 取标签；无标签返回 null。 */
export function parseTag(text) {
  const m = TAG_RE.exec(String(text ?? ''))
  return m ? m[1].toLowerCase() : null
}

/** 去掉标签前缀（注入时用，别把标记塞进系统提示）。 */
export function stripTag(text) {
  return String(text ?? '').replace(TAG_RE, '')
}

/** 不注入的标签：已完成 / 备注。 */
export function isHiddenTag(text) {
  const t = parseTag(text)
  return t === 'done' || t === 'note'
}

/** 条目上限：每类最多 10 条、每条 ≤200 字、注入正文 ≤1200 字。 */
const MAX_ITEMS = 10
const MAX_CHARS = 200
const MAX_RENDER = 1200

/** 工作区身份：realpath 的 sha256 前 16 位。路径不存在时退回 cwd 原样。 */
export function workspaceHash(cwd) {
  const raw = String(cwd || '')
  if (!raw) return null
  let real = raw
  try {
    real = realpathSync(raw)
  } catch {
    /* 路径还不存在：用原字符串，仍然稳定 */
  }
  return createHash('sha256').update(real.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16)
}

/** 读卷宗；hash 不匹配或文件缺失返回 null（= 不注入）。 */
export function readWorkspace(cwd) {
  const file = workspaceFilePath()
  const hash = workspaceHash(cwd)
  if (!hash || !existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || parsed.workspace_hash !== hash) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 清洗条目：去重 + 截断 + **只保留最新**。
 *
 * 2026-10-22 修：旧实现 `for…break` 在满 10 条时停止，等于保留**最早**的 10 条——
 * 于是卷宗里塞满会话开头的废话（报错复制、骂人话），最近的决策反而进不来。
 * 现改为取尾部（最新）再反转回时间正序。
 */
function clean(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const kept = []
  for (const item of list) {
    const text = String(item ?? '').trim().slice(0, MAX_CHARS)
    if (!text || seen.has(text)) continue
    seen.add(text)
    kept.push(text)
  }
  if (kept.length <= MAX_ITEMS) return kept
  // 上限淘汰：从**最老的**开始，但跳过 `[goal]`。
  // 原先直接 slice(-10)：说十句闲话就能把"本科→普通级→高级"这种长期目标挤掉，
  // 而被挤掉的恰好是唯一一句像"人"的话（2026-10-30 实测，真实卷宗正好顶格 10 条）。
  const out = [...kept]
  const need = out.length - MAX_ITEMS
  let removed = 0
  for (let i = 0; i < out.length && removed < need; i += 1) {
    if (parseTag(out[i]) === 'goal') continue
    out.splice(i, 1)
    i -= 1
    removed += 1
  }
  return out
}

/**
 * 指令质量筛选（2026-10-22）：只留"像一条人类指令"的文本。
 * 剔掉：多行/表格/代码块粘贴、终端报错、超长转述、子代理回执。
 * 判据保守——宁可少记，也不要让卷宗变成垃圾桶。
 */
export function pickDecisionText(raw) {
  const text = String(raw ?? '').replace(/\r/g, '').trim()
  if (!text) return ''
  const firstLine = text.split('\n')[0].trim()
  if (/^[|#>`]/.test(firstLine)) return '' // 表格 / 标题 / 引用 / 代码块
  if (/```/.test(text)) return ''
  if (/^(npm (error|warn)|Error:|ERR!|Traceback)/i.test(firstLine)) return ''
  if (/^Background subagent|^Its closing message/i.test(firstLine)) return ''
  const one = firstLine.replace(/\s+/g, ' ')
  if (one.length < 4 || one.length > 120) return ''
  return one
}

/** 合并写入（去重、截断、原子替换）。返回写入后的记录。 */
export function mergeWorkspace(cwd, patch = {}) {
  const file = workspaceFilePath()
  const hash = workspaceHash(cwd)
  if (!hash) throw new Error('workspaceHash: cwd 为空')
  let prev = {}
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && parsed.workspace_hash === hash) prev = parsed
    }
  } catch {
    /* 损坏就重建，不阻断 */
  }
  const next = {
    schema: 1,
    workspace_hash: hash,
    workspace_path: String(cwd || ''),
    updated_at: new Date().toISOString(),
    decisions: clean([...(prev.decisions || []), ...(patch.decisions || [])]),
    constraints: clean([...(prev.constraints || []), ...(patch.constraints || [])]),
    next_action: clean([...(prev.next_action || []), ...(patch.next_action || [])]),
    // 2026-10-22（主图 L4「跨会话快速交接」）：状态快照**覆盖式**保存，不追加。
    // 只存 FG 亲眼看得到的计数与最近被拦命令，不推断"做到哪了"。
    snapshot: patch.snapshot === undefined ? prev.snapshot || null : patch.snapshot,
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(tmp, file)
  return next
}

/** 渲染成系统提示 section；无内容返回 null（正常路径零注入）。 */
export function renderWorkspaceSection(record, opts = {}) {
  if (!record) return null
  const s = record.snapshot
  // 快照行只在"换会话"时出现：同一会话里重复自己的快照纯属噪音。
  const showSnapshot = s && (opts.sid === undefined || shouldInjectHandoff(record, opts.sid))
  const snap = showSnapshot
    ? `上次会话：${s.sid ? String(s.sid).slice(0, 12) : '-'} · ${s.at || '-'} · 工具调用 ${s.toolCalls ?? '-'} · 被拦 ${s.denies ?? '-'} · KPI ${s.kpi ?? '-'} · 委托 ${s.delegateBudget ?? '-'}`
    : ''
  // 决策行同理，且理由更硬（2026-10-29）：它是**历史**，而历史每回合都在长。
  // 实测（tools/prefix-drift.mjs）系统段每会话 2 个版本，分歧点恒定落在这一行——
  // 前缀一变，后面整段会话历史都要按未缓存价重付，而这些指令原文本来就在会话消息里。
  const showDecisions = opts.sid === undefined || shouldInjectHandoff(record, opts.sid)
  const head = `[FG-WORKSPACE] 本工作区跨会话卷宗（hash=${record.workspace_hash}，仅当前路径可见）：`
  /** 组装可见条目：`[done]` / `[note]` 不注入，`[goal]` 剥掉标记。 */
  const parts = []
  const push = (label, items) => {
    const shown = (items || []).filter((x) => !isHiddenTag(x)).map((x) => stripTag(x))
    if (shown.length) parts.push({ label, shown })
  }
  if (showDecisions) push('决策', record.decisions)
  // 约束（人类否决过的命令）保留实时：它是安全信息、只在真被否决时变，不是每回合的噪音。
  push('约束', record.constraints)
  push('下一步', record.next_action)
  if (!parts.length) return null
  const compose = () => {
    const body = parts.map((p) => `${p.label}：${p.shown.map((x) => `「${x}」`).join('、')}`).join('\n')
    return snap ? `${head}\n${snap}\n${body}` : `${head}\n${body}`
  }
  let text = compose()
  // 超预算时**丢整条**，绝不切半句——切半句比丢整条更糟：模型会把半截指令当真。
  // 淘汰顺序：决策最老 → 下一步最老 → 其余最老；约束是安全信息，最后才动。
  while (text.length > MAX_RENDER) {
    const target =
      parts.find((p) => p.label === '决策' && p.shown.length > 1) ||
      parts.find((p) => p.label === '下一步' && p.shown.length > 1) ||
      parts.find((p) => p.shown.length > 1)
    if (!target) break
    target.shown.shift()
    text = compose()
  }
  return text.slice(0, MAX_RENDER)
}

/**
 * 会话首步冻结（2026-10-29）
 *
 * 为什么必须冻结：`workspace.json` 是**每工作区一份**，而同一工作区常有多个并发会话。
 * 每个会话在回合结束都会写自己的快照，于是 A 会话的系统提示里会忽而出现 B 的快照、
 * 忽而变回自己的——实测两个真实会话的卷宗段都是 2 个版本，分歧点就在「上次会话」这一行。
 * 前缀一变，后面整段会话历史都要按未缓存价重付。
 *
 * 冻结的语义：**本会话首步渲染出什么，整场会话就是什么**。换会话自然是新的一份（交接信息还在）。
 * 代价如实说：本会话内新增的约束不会出现在提示里——但约束由闸门实时执行，
 * 提示里那份只是提示，不是执法依据。
 *
 * 只冻结**非空**渲染：首步还没有卷宗（新工作区）时不缓存，等第一次真的有内容再冻。
 */
const onceCache = new Map()
const ONCE_MAX = 64

export function renderWorkspaceSectionOnce(record, opts = {}) {
  const sid = opts && opts.sid
  const key = sid ? `${(record && record.workspace_hash) || '-'}|${sid}` : null
  if (key && onceCache.has(key)) return onceCache.get(key)
  const text = renderWorkspaceSection(record, opts)
  if (key && text) {
    if (onceCache.size >= ONCE_MAX) onceCache.delete(onceCache.keys().next().value)
    onceCache.set(key, text)
  }
  return text
}

/** 测试/诊断用：清空冻结缓存（进程重启等价于此）。 */
export function resetWorkspaceSectionCache() {
  onceCache.clear()
}

/**
 * 快速交接：新会话是否需要注入"上次会话快照"。
 * 判据只有两条：① 存在快照；② 快照来自**别的**会话（本会话已开始就不重复注入）。
 * @param {object|null} record 卷宗记录
 * @param {string} sid 当前会话 id
 */
export function shouldInjectHandoff(record, sid) {
  const s = record && record.snapshot
  if (!s || !s.sid) return false
  return String(s.sid) !== String(sid || '')
}

/**
 * 回合结束落账：只记 FG **亲眼看到**的三类事实，不推断、不编造。
 *   decisions  ← 本轮人类指令原文（≤200 字）
 *   constraints← 人类明确否决过的命令（state.rejectedCmds 的键）
 *   next_action← FG 不知道，留空（宁可空，不猜）
 */
export function recordWorkspaceTurn(agent) {
  const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
  if (!cwd) return null
  const sid =
    (agent && agent.session && agent.session.header && agent.session.header.id) ||
    (agent && (agent.sessionId || agent.id)) ||
    'dsh-native'
  let state = {}
  try {
    state = loadState(statePath(sid)) || {}
  } catch {
    state = {}
  }
  const prompt = String(state.turnPromptFull || state.turnPrompt || '').trim()
  const decided = pickDecisionText(prompt)
  const rejected = Object.keys(state.rejectedCmds || {})
  // 快速交接快照（主图 L4）：只存 FG 亲自数得出来的量，不推断"做到哪了"。
  const snapshot = {
    at: new Date().toISOString(),
    sid,
    toolCalls: Number(state.turnCalls || state.effectiveCalls || 0) || 0,
    denies: Number(state.denyCount || state.turnDenies || 0) || 0,
    kpi: Number.isFinite(state.kpi) ? state.kpi : 0,
    delegateBudget: Number.isFinite(state.delegateBudget) ? state.delegateBudget : null,
  }
  return mergeWorkspace(cwd, {
    decisions: decided ? [decided] : [],
    constraints: rejected.slice(0, MAX_ITEMS),
    next_action: [],
    snapshot,
  })
}
