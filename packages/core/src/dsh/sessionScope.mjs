/**
 * 会话/工作区取值的唯一实现（2026-10-31，3.3.1 还债）。
 *
 * 为什么抽出来：`sidOf` / `projDirOf` / `normalize` 在 `postProgress.mjs` 与 `preGuard.mjs`
 * 各有一份逐字相同的实现（重复块检测报 12 行 ×2）。口径只该有一处——否则改会话字段时
 * 一半模块跟着改、另一半悄悄保持旧口径。
 */

/** 会话标识：header.id > agent.sessionId > agent.id > exec.sessionId > 'dsh-native'。 */
export function sidOf(exec) {
  const a = exec && exec.agent
  return (
    (a && ((a.session && a.session.header && a.session.header.id) || a.sessionId || a.id)) ||
    (exec && exec.sessionId) ||
    'dsh-native'
  )
}

/** 工作目录：header.cwd 优先，取不到回退进程 cwd。 */
export function projDirOf(exec) {
  const a = exec && exec.agent
  return (a && a.session && a.session.header && a.session.header.cwd) || process.cwd()
}

/** 路径归一：统一正斜杠（仅用于键，不用于 fs）。 */
export function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/')
}
