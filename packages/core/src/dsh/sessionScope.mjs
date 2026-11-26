/**
 * 会话/工作区取值的唯一入口（2026-10-31，3.3.1 还债；2026-11-25 收口）。
 *
 * 为什么抽出来：`sidOf` / `projDirOf` / `normalize` 在 `postProgress.mjs` 与 `preGuard.mjs`
 * 各有一份逐字相同的实现（重复块检测报 12 行 ×2）。口径只该有一处——否则改会话字段时
 * 一半模块跟着改、另一半悄悄保持旧口径。
 *
 * 2026-11-25 再收一次：这个「唯一实现」当时并不唯一。`seams/shared.mjs`、`traceMeta.mjs`、
 * `guard/tooling.mjs`、`audit.mjs`、`adapters/dsh/eligibility-gate.mjs` 各自又写了一遍
 * `|| 'dsh-native'`，合计 7 个模块 15 处。分叉的后果是真实的：`audit-writer` 改缺省值
 * 为 'unknown' 时只有两处跟着改；`eligibility-gate` 那份更是**连 header.id 都没读**。
 *
 * 现在实现只有一处：`adapters/dsh/session.mjs`（哨兵值是宿主标识，不能进母版；
 * 而适配层不能依赖宿主缝，所以只能落在适配层）。本文件对宿主缝内的调用方保持原名字，
 * 只是不再自己实现——`projDirOf` / `normalizePath` 仍留在这里。
 */
export { UNKNOWN_SESSION, sidOf } from '../adapters/dsh/session.mjs'

/** 工作目录：header.cwd 优先，取不到回退进程 cwd。 */
export function projDirOf(exec) {
  const a = exec && exec.agent
  return (a && a.session && a.session.header && a.session.header.cwd) || process.cwd()
}

/** 路径归一：统一正斜杠（仅用于键，不用于 fs）。 */
export function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/')
}
