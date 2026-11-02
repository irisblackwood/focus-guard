/**
 * 卷宗条目标签（M1 抽出，2026-11-02）。
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
