/**
 * 改动面闸（Blast-Radius Gate，2026-10-25）
 *
 * 人类原话："需要改大量文件，结果只是实现一个小彩灯"。
 * 所以判据不是 token ROI，而是 **改动面 × 收益量级**：
 *   - 改动面：新建架构敏感文件（src/、packages/ 下）/ 加依赖 / 一次动 ≥N 个文件
 *   - 收益：必须能一句话说清"用户可见/可测的改善"；说不清 = 小彩灯
 *
 * 设计纪律（与既有闸一致）：
 *   ① **只拒一次**：同一条调用第二次即放行（不死锁，不替人类做最终决定）
 *   ② 不预测数字：不要求"省 X%"，只要求"收益是什么 + 更小的替代是什么"
 *   ③ 只覆盖架构敏感面：文档、测试、示例不受本闸影响
 */

const SENSITIVE_RE = /(^|[\\/])(src|packages)[\\/]/i

/** 是否为"新建架构敏感文件"（路径不存在 + 落在 src/ 或 packages/ 下）。 */
export function isNewSensitiveFile(filePath, exists) {
  const p = String(filePath || '')
  if (!p || !SENSITIVE_RE.test(p)) return false
  try {
    return exists ? !exists(p) : false
  } catch {
    return false
  }
}

/** 是否需要本闸介入（新建敏感文件 / 加依赖）。 */
export function shouldGate({ filePath, exists, command }) {
  if (isNewSensitiveFile(filePath, exists)) return true
  const cmd = String(command || '')
  // 加依赖 = 引入长期维护负担，同样要求一句话收益。
  // 2026-10-25 修：原条件要求命令里出现 package.json 字样，而 `npm install x` 并不会带文件名 → 永不触发。
  return /\b(?:npm|pnpm|yarn|bun|pip3?|poetry|uv)\s+(?:install|add)\b/i.test(cmd)
}

/** 一次性拦截的理由：给模板，不替人类判断。 */
export function gateReason({ filePath, kind }) {
  const what = kind === 'dep' ? '新增依赖' : `新建架构文件 ${String(filePath || '').split(/[\\/]/).pop()}`
  return (
    `focus-guard-native: 改动面闸——${what}。先回三行（每条 ≤40 字）：\n` +
    '1) 收益：这个改动让用户/指标看到什么变化（说不清就是小彩灯）\n' +
    '2) 改动面：预计要碰几个文件、是否跨层（core/adapter/seam）\n' +
    '3) 替代：更小的做法是什么（不加文件/不改依赖能否达成）\n' +
    '回完直接重试本条即放行（只拒一次，不重复劝）。'
  )
}

/** 解析人类指令里是否已声明收益（有则无需再拦）。 */
export function promptDeclaresBenefit(prompt) {
  const t = String(prompt || '')
  return /(收益|用户可见|可测|提升|减少|避免|加速|降本)/.test(t) && t.length >= 10
}
