/**
 * 记忆模块唯一入口（4.5 M1，2026-11-02）。
 *
 * 分层纪律：本模块不 import 任何 `src/dsh/`；宿主适配层只准 import 这里。
 * 旧路径 `src/dsh/workspace.mjs` 保留转发，调用方不必改。
 */
export * from './workspace.mjs'
export * from './tags.mjs'
