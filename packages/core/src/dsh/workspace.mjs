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
export const WORKSPACE_FILE = fileURLToPath(new URL('../../../../.focus-guard/workspace.json', import.meta.url))

/** `FG_WORKSPACE_FILE` 可重定向——测试必须用它，否则会写进真实工作区。 */
export function workspaceFilePath() {
  return process.env.FG_WORKSPACE_FILE || WORKSPACE_FILE
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

function clean(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    const text = String(item ?? '').trim().slice(0, MAX_CHARS)
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= MAX_ITEMS) break
  }
  return out
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
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(tmp, file)
  return next
}

/** 渲染成系统提示 section；无内容返回 null（正常路径零注入）。 */
export function renderWorkspaceSection(record) {
  if (!record) return null
  const block = (label, items) => (items && items.length ? `${label}：${items.map((x) => `「${x}」`).join('、')}` : '')
  const lines = [
    block('决策', record.decisions),
    block('约束', record.constraints),
    block('下一步', record.next_action),
  ].filter(Boolean)
  if (!lines.length) return null
  const text = `[FG-WORKSPACE] 本工作区跨会话卷宗（hash=${record.workspace_hash}，仅当前路径可见）：\n${lines.join('\n')}`
  return text.slice(0, MAX_RENDER)
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
  const rejected = Object.keys(state.rejectedCmds || {})
  return mergeWorkspace(cwd, {
    decisions: prompt ? [prompt.slice(0, MAX_CHARS)] : [],
    constraints: rejected.slice(0, MAX_ITEMS),
    next_action: [],
  })
}
