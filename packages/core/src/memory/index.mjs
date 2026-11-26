/**
 * 记忆模块唯一入口（4.5 M1，2026-11-02）。
 *
 * 分层纪律：本模块不 import 任何 `src/dsh/`；宿主适配层只准 import 这里。
 * 旧路径 `src/dsh/workspace.mjs` 保留转发，调用方不必改。
 *
 * 注入边界（2026-11-02 定，2026-11-22 更新）：
 *   ① 不新开 `focus-guard-memory` 段；原 `focus-guard-workspace` 段自 2026-11-22 起
 *      **不再常驻注入**，改为 `fg_workspace` 工具按需拉取（前缀更短、缓存更稳）。
 *   ② FG 只记录**约束类**内容（决策 / 被否决的命令 / 熔断）；
 *      用户偏好归 DSH 的 self-improvement，两边不重复写。
 *   ③ 静态知识库与人格档**不进注入**：前者只在 `tools/` 离线落索引，后者待裁决。
 */
export * from './workspace.mjs'
export * from './tags.mjs'
