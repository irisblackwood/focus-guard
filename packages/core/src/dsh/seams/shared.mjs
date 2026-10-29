/**
 * seams 共用件（2026-10-27 拆分）——会话/工作区标识、子代理判定、人类文本提取、状态载入、审计入口。
 *
 * 拆分起因：`src/dsh/seams.mjs` 当时 498 行、四个监听器挤在一处，超结构异味阈值
 * （文件 400 行 / 函数 80 行 / 嵌套 5 层）。这些 helper 被多条缝共用，单独一处也避免
 * `seams/` 内各模块互相 import 成环。
 *
 * **纯搬运**：判定条件、阈值、文案、审计字段一字未改。取值口径与官方桥一致
 * （lib/index.js:349-354）——**这不是可选项**：
 *   sid = agent.session.header.id   ← 用 agent.session.id 会取不到，于是全部会话退化成同一个
 *                                      'dsh-native'，造成跨会话状态污染。
 *   cwd = agent.session.header.cwd ?? process.cwd()
 *   人类文本 = messages.flatMap(m => m.content).filter(b => b.type==='text').map(b => b.text).join('')
 */
import { statePath, loadState } from '../../core/state.mjs'
import { appendAudit, buildAuditRow } from '../audit.mjs'

/** 会话标识：与桥同源（agent.session.header.id）。取不到才退化为 dsh-native。 */
export function sidOf(agent) {
  return (
    (agent && ((agent.session && agent.session.header && agent.session.header.id) || agent.sessionId || agent.id)) ||
    'dsh-native'
  )
}

/** 工作目录：与桥同源（session.header.cwd），缺省用进程 cwd。 */
export function projDirOf(agent) {
  return (agent && agent.session && agent.session.header && agent.session.header.cwd) || process.cwd()
}

/**
 * 是否为子代理会话（`origin === 'subagent'`）。
 *
 * 2026-10-10 实测必要性：hermes-loop 的复盘子代理走 `ctx.agents.create({ meta: { origin: 'subagent' } })`，
 * 它会**同样触发 `agent/created` 与 `agent/pre-step`**。若不加区分，FG 会对一个只跑几十秒的复盘子代理：
 *   · 做完整环境检测、载入 39 条卷宗记录（实测白占 20KB 状态文件）
 *   · **重写工作区 `.ai/CASE_FILE.md` 的卷宗【一】**（每个 agent 创建都写一次 → 文件抖动、并发时可能互相覆盖）
 *   · 把 hermes 自己生成的复盘 prompt **当成人类批示**去识别（实测命中 KEY50_RE → 额度误判为 50、并记了无意义的 goal）
 * 子代理的 prompt 由父 agent 生成、不是人类输入，故这些一律应跳过。
 */
export function isSubagent(agent) {
  const s = agent && agent.session
  const origin = (s && ((s.header && s.header.origin) || s.origin)) || (agent && agent.origin)
  if (origin === 'subagent') return true
  // 兜底：委派深度 > 0 亦视为子代理
  const depth = (s && ((s.header && s.header.delegationDepth) || s.delegationDepth)) || agent?.delegationDepth
  return typeof depth === 'number' && depth > 0
}

/**
 * 从 `agent/pre-step` 的 messages 提取人类提示原文。
 *
 * ⚠ 2026-10-10 实际运行修正（真实会话审计里出现 `prompt:无`）：
 *  ① **形状不止一种**。原实现只认 `messages[].content[]` 的 text 块（照桥的 `blocksToText` 假设），
 *     真实载荷对不上 → 人类文本恒为空 → **批示识别全部失效**（追加额度/停止令/特批/额度核定 50·15
 *     全都拿不到输入，额度永远按默认 10 走）。测试发现不了，因为测试造的就是自己假设的形状。
 *  ② **messages 里混有非人类消息**。DSH 的 pre-step 默认 next 是
 *     `{ messages: [...claimed, context] }`（dsh-agent-loop/lib/index.js:911-918），
 *     即**渲染后的系统提示也会作为一条消息追加进来**。若无条件拼接，会把系统提示当成人类批示——
 *     那是比"取不到"更危险的方向，所以这里**优先只取 user 角色的消息**，取不到才退回全量。
 */
export function humanTextOf(messages) {
  if (!Array.isArray(messages)) return ''
  /** 单条消息 → 文本（逐层兜底，覆盖常见的几种载荷形状）。 */
  const pick = (m) => {
    if (typeof m === 'string') return m
    if (!m || typeof m !== 'object') return ''
    if (typeof m.text === 'string') return m.text
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
        .map((b) => b.text || '')
        .join('')
    }
    if (Array.isArray(m.parts)) {
      return m.parts
        .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
        .map((b) => b.text || '')
        .join('')
    }
    if (typeof m.message === 'string') return m.message
    return ''
  }
  const isUser = (m) =>
    m && typeof m === 'object' && (m.role === 'user' || m.author === 'user' || m.type === 'user')
  const users = messages.filter(isUser)
  // 有明确的 user 消息就只用它（排除 pre-step 追加的 context 消息，防把系统提示当批示）
  const pool = users.length ? users : messages
  return pool.map(pick).join('\n')
}

/** 载入本会话状态；文件不存在时 loadState 返回默认结构（含 readSet: {}）。 */
export function loadOrInit(agent) {
  const sid = sidOf(agent)
  const file = statePath(sid)
  return { sid, file, state: loadState(file) }
}

/**
 * 写一条审计（DSH 侧统一入口，带体积轮转）。
 * 2026-10-29：行构造收敛到 `core/audit-writer.mjs::buildAuditRow`——
 * 此前本函数与 postProgress / preGuard / stopGuard / compactionWatch 各写一份，
 * 五份字段集不同，实测日志里漂出三种形态。现在只保留"取 evidence、透传 extra"这一层。
 */
export function auditRow(sid, action, evidence, extra = {}) {
  const { level, pardon, ...rest } = extra
  appendAudit(buildAuditRow(sid, action, { level, pardon, evidence, extra: rest }))
}
