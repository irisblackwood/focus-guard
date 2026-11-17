/**
 * 压缩损失度量 · 锚点提取（2026-11-16）
 *
 * 为什么要这一层：压缩器都在说"省了多少 token"，没人说"丢了什么"。
 * 而代码任务靠**坐标**定位——文件路径、行号、错误码、常量名。这些一旦被摘要吞掉，
 * 模型就会"改一处忘一处"，但账单上看不出来。
 *
 * 纪律（与 compactionWatch 三条纪律一致）：
 *   ① 只读、只数，绝不改会话；
 *   ② **只返回计数，不返回内容** —— 审计行要能公开读，原文不进日志；
 *   ③ 拿不到原文时**不猜**：返回 0，由调用方记一条"无法度量"，而不是报"零损失"。
 *
 * 为什么只数这四类：它们误报率低、且是"重查成本最高"的一类。
 * 自然语言、代码结构不在其中——那些压缩器本来就会改写，数了只会淹没真信号。
 *
 * 末尾三个非纯函数（`messagesOf` / `lossBegin` / `lossSummary`）是快照入口：
 * 只读 session、只写 state 的两个字段，放这里是为了让 compactionWatch 主文件守住 400 行。
 */

/**
 * 锚点模式。顺序无关，每类内部**去重**（同一个路径出现十次只算一个）。
 *
 * `const` 强制要求含下划线：`\b[A-Z][A-Z0-9]{2,}_[A-Z0-9_]+\b`。
 * 不用 `[A-Z_]{4,}` 是因为那会把 `NULL` / `TODO` / `JSON` / `API` 全算成锚点——
 * 实测这类通用词在任何摘要里都会被保留，加进来等于给分母注水。
 */
const PATTERNS = [
  { kind: 'path', re: /[\w./\\-]+\.(?:mjs|js|ts|tsx|py|md|json|ya?ml|toml|sh)\b/g },
  { kind: 'errcode', re: /\bE\d{4}\b/g },
  { kind: 'const', re: /\b[A-Z][A-Z0-9]{2,}_[A-Z0-9_]+\b/g },
  { kind: 'lineref', re: /[\w.-]+\.\w+:\d+\b/g },
]

export const ANCHOR_KINDS = PATTERNS.map((p) => p.kind)

/**
 * 数锚点。
 * @param {string} text
 * @returns {{path:number, errcode:number, const:number, lineref:number, total:number}}
 */
export function countAnchors(text) {
  const s = String(text || '')
  const out = { path: 0, errcode: 0, const: 0, lineref: 0, total: 0 }
  for (const { kind, re } of PATTERNS) {
    const seen = new Set()
    re.lastIndex = 0
    let m
    while ((m = re.exec(s)) !== null) {
      seen.add(m[0])
      // 零宽匹配保护：正则若被改成可匹配空串，这里会死循环。
      if (m.index === re.lastIndex) re.lastIndex += 1
    }
    out[kind] = seen.size
    out.total += seen.size
  }
  return out
}

/**
 * 消息数组 → 纯文本。
 *
 * 形状不止一种（与 `seams/shared.mjs` 的 `blocksToText` 同源教训）：
 * `content` 可能是字符串，也可能是 `[{type:'text', text}]` 或 `[{type:'tool_result', content}]`。
 * 认不出的块直接跳过——宁可少数，不要猜错把工具输出当人类文本。
 */
export function textOfMessages(messages) {
  const parts = []
  for (const m of messages || []) {
    const c = m && m.content
    if (typeof c === 'string') {
      parts.push(c)
      continue
    }
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (!b || typeof b !== 'object') continue
      if (typeof b.text === 'string') parts.push(b.text)
      else if (typeof b.content === 'string') parts.push(b.content)
    }
  }
  return parts.join('\n')
}

/**
 * 一行证据文本。只报计数与差值，**不报任何原文片段**。
 * @param {{total:number}} before
 * @param {{total:number}} after
 */
export function describeLoss(before, after) {
  const b = before || {}
  const a = after || {}
  const lost = (b.total ?? 0) - (a.total ?? 0)
  const bits = ANCHOR_KINDS.map((k) => `${k} ${b[k] ?? 0}→${a[k] ?? 0}`)
  return `锚点 ${b.total ?? 0}→${a.total ?? 0}（${lost >= 0 ? '丢' : '增'} ${Math.abs(lost)}）| ${bits.join(' · ')}`
}

/** 会话消息数组；宿主未暴露时返回空数组（不猜、不抛）。 */
export function messagesOf(session) {
  try {
    const m = session && session.messages
    return Array.isArray(m) ? m : []
  } catch {
    return []
  }
}

/** 压缩前快照：此刻 messages 还是原文，是唯一能取到"将要被折掉什么"的时机。 */
export function lossBegin(state, session) {
  state.anchorsBefore = countAnchors(textOfMessages(messagesOf(session)))
  state.anchorsAfter = null
}

/** 摘要正文落在 `data.content`（形状取自真实会话样本）；取不到就留 null，不当作零损失。 */
export function lossSummary(state, data) {
  const body = data.content
  state.anchorsAfter = body === undefined ? null : countAnchors(textOfMessages([{ content: body }]))
}
