/**
 * focus-guard 原生插件 · 工具名归一化（3.0.8 适配层）
 *
 * 母版 `src/core/risk.mjs` 的 `isMutating` / `isInvestigation` 按 **ZCode 命名**精确判定
 * （`tool === "Write"`、`["Read","Grep","Glob",...].includes(tool)`），而 DSH 传的是**小写**
 * （`write` / `read` / `pwsh` / `subagent`）。直接调用会恒不匹配，后果不是"漏拦一次"而是**静默判错**：
 *   · `isMutating('write')` === false  → L2 强制取证/L5 降权期间改动类**不被拦**
 *   · `isInvestigation('read')` === false → 只读调用被计入**执行池**，侦查池永不满、执行池被提前耗尽
 * 2026-10-10 由移植批 5 的用例抓到（前一批 postProgress 已带此缺陷）。
 *
 * 归一化放在**适配层**而不是改母版：母版要同时服务 ZCode（原名）与 DSH（小写），
 * 翻译是适配层的职责；改母版会把 DSH 的命名泄漏进母版，破坏"母版零宿主依赖"的分层约定。
 */

/** DSH 工具名 → ZCode 名。未登记的原样返回（母版函数对未知名一律返回 false，安全默认）。 */
const TABLE = {
  read: 'Read',
  notebookread: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  grep: 'Grep',
  glob: 'Glob',
  'fs-search': 'Glob',
  search: 'Grep',
  pwsh: 'Bash',
  bash: 'Bash',
  shell: 'Bash',
  'bash-persistent': 'Bash',
  'pwsh-persistent': 'Bash',
  subagent: 'Agent',
  agent: 'Agent',
  websearch: 'WebSearch',
  webfetch: 'WebFetch',
}

/** 把 DSH 的工具名翻成母版认得的 ZCode 名。 */
export function zcodeToolName(tool) {
  const raw = String(tool || '')
  return TABLE[raw.toLowerCase()] || raw
}
