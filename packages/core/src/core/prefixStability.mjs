/**
 * 前缀稳定性（2026-10-29）
 *
 * 为什么需要：缓存命中要求**前缀逐字节相同**。实测（`tools/prefix-drift.mjs`，读真实会话落盘）
 * 四个会话里 `tools` / `user` 段全程 1 个版本，`system` 段却是 2 个版本，首次分歧恒定落在
 * `[FG-WORKSPACE]` 的「决策：」那一行——FG 自己往系统提示里塞了**历史**，而历史每回合都在长。
 *
 * 于是分两件事：
 *   ① 注入内容分类：**不变量**可以进前缀，**历史**不进（人类指令原文已经在会话消息里，再抄一份既重复又抖）
 *   ② 抖动可测：每步算一次 FG 段指纹，变了就写一条 `prompt-prefix-shift` 审计——
 *      下次谁再往注入里塞易变内容，AUDIT.log 里会现形，而不是靠人记得
 *
 * 边界（如实声明）：本模块只看 `focus-guard-*` 段。宿主的工具表 / 系统提示 / 技能目录不归 FG 管，
 * 它们变了这里不会报——FG 不能替宿主背这个锅，也不该假装能测。
 */

import { createHash } from 'node:crypto'

/** FG 注入段的命名前缀：只有这些算"我们的前缀"。 */
const FG_SECTION_PREFIX = 'focus-guard-'

export function isFgSection(name) {
  return typeof name === 'string' && name.startsWith(FG_SECTION_PREFIX)
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12)

/**
 * 段指纹：整段一个总哈希 + 每段一个。
 * 总哈希用「名字:字节数:内容哈希」拼起来再哈希——**顺序敏感**，
 * 因为段的顺序一变，前缀就不再是同一段字节（哪怕内容集合相同）。
 *
 * 2026-10-29 修：原先用 `text.length`（UTF-16 码元）却把差值写成 `B`——
 * 中文一字 3 字节，审计里的"字节差"会低估约 3 倍。现统一用 UTF-8 字节。
 */
export function fingerprintSections(sections) {
  const parts = (sections || []).map((s) => {
    const text = String((s && s.text) ?? '')
    return { name: String((s && s.name) ?? ''), bytes: Buffer.byteLength(text, 'utf8'), hash: sha(text) }
  })
  const hash = sha(parts.map((p) => `${p.name}:${p.bytes}:${p.hash}`).join('|'))
  const bytes = parts.reduce((a, p) => a + p.bytes, 0)
  return { hash, bytes, parts }
}

/** 两版指纹的差异：谁变了、变了多少字节、有没有增删。 */
export function diffFingerprints(prev, next) {
  const before = new Map(((prev && prev.parts) || []).map((p) => [p.name, p]))
  const after = new Map(((next && next.parts) || []).map((p) => [p.name, p]))
  const changed = []
  const added = []
  const removed = []
  for (const [name, p] of after) {
    const q = before.get(name)
    if (!q) added.push(name)
    else if (q.hash !== p.hash) changed.push({ name, bytes: p.bytes, delta: p.bytes - q.bytes })
  }
  for (const name of before.keys()) if (!after.has(name)) removed.push(name)
  const bytes = ((next && next.bytes) || 0) - ((prev && prev.bytes) || 0)
  return { changed, added, removed, bytes, stable: !changed.length && !added.length && !removed.length }
}

/** 一行证据文本（写审计用；别让它长到把审计行撑爆）。 */
export function describeShift(diff) {
  const bits = []
  for (const c of diff.changed) bits.push(`${c.name}(${c.delta >= 0 ? '+' : ''}${c.delta}B)`)
  if (diff.added.length) bits.push(`+${diff.added.join(',+')}`)
  if (diff.removed.length) bits.push(`-${diff.removed.join(',-')}`)
  const head = bits.join(' ') || 'same-sections'
  return `${head} | 总 ${diff.bytes >= 0 ? '+' : ''}${diff.bytes}B`.slice(0, 180)
}

/**
 * 按会话跟踪前缀指纹。
 * 只在**同一会话内**比：会话 A 的基线拿去比会话 B 是两回事（换会话本来就会变）。
 *
 * @param {{audit?: (evt: {sid: string, diff: object, fingerprint: object}) => void, max?: number}} opts
 */
export function createPrefixTracker({ audit, max = 64 } = {}) {
  const memo = new Map()
  return {
    /**
     * 记一次装配。首见某会话只建基线（不报）；之后变了才回调 audit。
     * @returns {object|null} 变化描述；稳定或首见返回 null
     */
    note(sid, sections) {
      if (!sid) return null
      const fp = fingerprintSections((sections || []).filter((s) => isFgSection(s && s.name)))
      const prev = memo.get(sid)
      const diff = prev && prev.hash !== fp.hash ? diffFingerprints(prev, fp) : null
      // 有界：长跑进程里会话数无上限，最老的先丢（丢掉的会话下次装配重算基线，不报）。
      if (!memo.has(sid) && memo.size >= max) memo.delete(memo.keys().next().value)
      // **先更新基线再回调**：回调（写审计）万一抛错，基线也已经是新的，
      // 否则下一步会拿旧基线再报一次，把一次抖动变成每步都报。
      memo.set(sid, fp)
      if (diff && typeof audit === 'function') audit({ sid, diff, fingerprint: fp })
      return diff
    },
    /** 取某会话当前基线（诊断/测试用）。 */
    get(sid) {
      return memo.get(sid) || null
    },
    size() {
      return memo.size
    },
    reset() {
      memo.clear()
    },
  }
}
