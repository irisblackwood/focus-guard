/**
 * 卷宗条目的人工维护工具（2026-10-30）
 *
 * 定位：卷宗是**人格连续性**的载体，不是聊天记录。所以这里的操作全部是
 * **人工发起、人工确认**——不做自动淘汰，不做"猜你想删哪条"。
 *
 * 三个动作：
 *   list  列出条目（序号 + 标签）
 *   score 给出可解释的分数与理由，**仅供参考，不作判决**
 *   drop  删除指定序号（先整份备份到 archive）
 *   tag   给指定序号打标签
 *
 * 标签只有四个（自由标签会失控）：
 *   [goal]  长期目标——上限淘汰时永不挤掉，正常注入
 *   [done]  已完成——**不注入**（僵尸记忆的主要来源）
 *   [note]  备注——**不注入**
 *   无标签  普通决策——按 FIFO
 *
 * 为什么用文本前缀而不是结构化字段：零 schema 变更、可逆、人可以直接编辑文件。
 * 解析集中在 parseTag / stripTag，将来要换结构化只改这两处。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
// 解析函数只在 workspace.mjs 定义一份：那边负责"注入时怎么用"，这边负责"人怎么改"，
// 两边共用一个正则，免得 `[Goal]` 在一边认、在另一边不认。
import { CASE_TAGS, parseTag, stripTag, workspaceFilePath } from '../../src/dsh/workspace.mjs'
import { appendAudit, buildAuditRow } from '../../src/core/audit-writer.mjs'

export { CASE_TAGS, parseTag, stripTag }

/**
 * 使用审计（2026-10-31）：人工维护动作必须留痕，否则"这个功能有没有人用"只能靠猜。
 * 审计写失败不阻断文件操作——人已经按下确认，记账不能反过来把改动吞掉。
 */
export function auditCase(action, evidence) {
  try {
    appendAudit(buildAuditRow('dsh-native', action, { trigger: 'cli', level: null, evidence }))
  } catch {
    /* 记账失败不影响人工操作 */
  }
}

const brief = (text, n = 60) => String(text ?? '').slice(0, n)

/** 给文本加/换标签；tag 为 null 表示清除。 */
export function withTag(text, tag) {
  const body = stripTag(text)
  if (!tag) return body
  if (!CASE_TAGS.includes(tag)) throw new Error(`未知标签 ${tag}（只支持 ${CASE_TAGS.join(' / ')}）`)
  return `[${tag}] ${body}`
}

// ── 打分（只读，仅供参考）────────────────────────────────────────────────

const ACTION_WORDS = ['改', '加', '删', '必须', '不要', '走', '新建', '换成', '优先', '禁止', '保留', '去掉']
const CONCRETE = ['fg', 'focus-guard', '卷宗', '文档', '版本', '规则', '前缀', '审批', '测试', '成本', 'token', '文件', '函数']
const VAGUE_PRONOUN = ['它', '这个', '那个', '这样', '那样', '这些', '那些']
const FILLER_HEAD = ['哦', '啊', '嗯', '对了', '然后', '其实', '就是', '好吧', '行', '对']

/**
 * 文本质量分：**不是判决，只是提示**。
 * 判据全部可解释；宁可漏判，也不误杀（2026-10-30：初版把「其实我不想只止于本科论文级」
 * 扣成 0 分，因为它以"其实"开头——那条恰恰是最该留的长期目标。现改为只在极短句上扣语气词）。
 */
export function scoreEntry(text) {
  const t = String(text ?? '')
  const low = t.toLowerCase()
  const why = []
  let s = 0
  if (ACTION_WORDS.some((k) => t.includes(k))) {
    s += 3
    why.push('+3 含动作词')
  }
  if (CONCRETE.some((k) => low.includes(k))) {
    s += 2
    why.push('+2 含具体名词')
  }
  if (VAGUE_PRONOUN.some((k) => t.includes(k)) && !CONCRETE.some((k) => low.includes(k))) {
    s -= 2
    why.push('-2 只有指代没有指称对象')
  }
  // 只在**极短**句上扣语气词：长句以"其实"开头是正常表达，不是碎片。
  if (t.length < 12 && FILLER_HEAD.some((k) => t.startsWith(k))) {
    s -= 1
    why.push('-1 极短且以语气词开头')
  }
  if (t.length < 8) {
    s -= 1
    why.push('-1 极短')
  }
  if (t.length >= 20) {
    s += 1
    why.push('+1 有展开')
  }
  return { score: s, reasons: why }
}

// ── 读写 ────────────────────────────────────────────────────────────────

export function loadCase(file = workspaceFilePath()) {
  if (!existsSync(file)) return { file, record: null }
  try {
    return { file, record: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    return { file, record: null, error: (error && error.message) || String(error) }
  }
}

/** 整份备份再写回——删条目是不可逆动作，先留一份原文。 */
export function backupCase(record, file = workspaceFilePath()) {
  const dir = join(dirname(file), 'archive', 'case-dropped')
  mkdirSync(dir, { recursive: true })
  const name = `case-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  const target = join(dir, name)
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`)
  return target
}

function saveCase(record, file) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(tmp, file)
}

/** 展平成带序号的行：决策 / 约束 / 下一步 各自编号，用前缀区分。 */
export function entriesOf(record) {
  const out = []
  for (const [field, label] of [
    ['decisions', '决策'],
    ['constraints', '约束'],
    ['next_action', '下一步'],
  ]) {
    const list = Array.isArray(record && record[field]) ? record[field] : []
    list.forEach((text, i) => out.push({ field, label, index: i, text: String(text) }))
  }
  return out
}

/**
 * 定位条目。两种写法：
 *   `3`              → 全局序号（与 `fg case` 列表显示的编号一致，默认 decisions 优先）
 *   `constraints:2`  → 指定字段的第 2 条
 */
export function resolveEntry(record, locator) {
  const raw = String(locator ?? '').trim()
  const m = /^(decisions|constraints|next_action)?:?(\d+)$/.exec(raw)
  if (!m) return null
  if (!m[1]) {
    const all = entriesOf(record)
    const i = Number(m[2]) - 1
    if (i < 0 || i >= all.length) return null
    const e = all[i]
    return { field: e.field, index: e.index, text: e.text, global: i + 1 }
  }
  const field = m[1]
  const index = Number(m[2]) - 1
  const list = Array.isArray(record && record[field]) ? record[field] : []
  if (index < 0 || index >= list.length) return null
  return { field, index, text: String(list[index]), global: null }
}

/** 删除一条并备份整份；返回备份路径。 */
export function dropEntry(record, locator, file = workspaceFilePath()) {
  const hit = resolveEntry(record, locator)
  if (!hit) return { ok: false, reason: `找不到条目 ${locator}` }
  const backup = backupCase(record, file)
  const next = { ...record, [hit.field]: record[hit.field].filter((_, i) => i !== hit.index) }
  saveCase(next, file)
  auditCase('case-drop', `${hit.field}:${hit.index + 1} 删除「${brief(hit.text)}」备份 ${backup}`)
  return { ok: true, removed: hit.text, backup }
}

/** 打标签（tag 为 null 清除）。 */
export function tagEntry(record, locator, tag, file = workspaceFilePath()) {
  const hit = resolveEntry(record, locator)
  if (!hit) return { ok: false, reason: `找不到条目 ${locator}` }
  if (tag && !CASE_TAGS.includes(tag)) return { ok: false, reason: `未知标签 ${tag}` }
  const list = [...record[hit.field]]
  list[hit.index] = withTag(hit.text, tag)
  const next = { ...record, [hit.field]: list }
  saveCase(next, file)
  auditCase('case-tag', `${hit.field}:${hit.index + 1} ${tag || '清除'}｜${brief(hit.text, 40)} → ${brief(list[hit.index], 40)}`)
  return { ok: true, before: hit.text, after: list[hit.index] }
}
