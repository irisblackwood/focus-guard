// FocusGuard 母版层 · 体积闸判定内核（3.0.9）
//
// 为什么单独成模块（2026-10-22 架构审查）：
//   体积闸此前在两条适配路径各写一份判定——`hooks/guard.mjs`（Claude Code / ZCode 路径）
//   与 `src/dsh/pipeline.mjs`（DSH 路径）。两份判据已经开始分叉，而红线判定早就收敛在
//   `core/redlines.mjs` 一处。同一套架构里两个判定走两种做法，就是漂移的温床。
//
// 但**不能简单合并**：两个宿主的工具 schema 不同，参数提取必须各自做。
//   · Claude Code / ZCode 的 Grep 有 `output_mode` / `head_limit`
//   · DSH 的 Grep 只有 `{ pattern, path, include }`
//   所以本模块只做**判定**（给定语义输入，返回该不该拦），
//   参数提取留在各适配层。这样规则单点、适配各异，两边都不吃亏。
//
// 纪律：本模块纯函数，不读文件、不写审计、不碰状态。副作用留在适配层。

/** 审计/盘点/审查类任务的整读豁免（法典：审计是 50 预算重大专项）。 */
export const AUDIT_TASK_RE = /审计|盘点|审查/

/** 裸 cat/type 刷屏的识别与放行条件。 */
const CAT_RE = /(^|[;&|]\s*)(cat|type|Get-Content)\s/i
const CAT_GUARDED_RE = /\||>|-(?:TotalCount|First|Tail)\b/i

/**
 * Read 整读体积闸。
 *
 * @param {object} p
 * @param {number} p.bytes       目标文件字节数（取不到时传 0，等价放行）
 * @param {number} p.gateBytes   阈值（`constants.mjs` 的 OUTPUT_GATE_BYTES）
 * @param {string} [p.turnPrompt] 本回合用户提示，用于判定审计豁免
 * @returns {'allow'|'exempt'|'deny'} allow=未超阈值；exempt=审计任务留痕放行；deny=拦
 */
export function judgeReadGate({ bytes = 0, gateBytes, turnPrompt = '' } = {}) {
  if (!Number.isFinite(bytes) || bytes <= gateBytes) return 'allow'
  return AUDIT_TASK_RE.test(String(turnPrompt || '')) ? 'exempt' : 'deny'
}

/**
 * Grep 收窄闸。
 *
 * 两种宿主的"未收窄"语义不同，由适配层翻译成布尔量再交进来：
 *   · DSH：`broadDir` = 指定了目录 且 无 include 且 无限量
 *   · Claude Code / ZCode：`contentUnlimited` = output_mode 为 content 且 无 head_limit
 *
 * @param {object} p
 * @param {boolean} [p.broadDir]          目录级搜索未收窄
 * @param {boolean} [p.contentUnlimited]  正文模式未限量
 * @returns {{ action: 'allow'|'deny', reason: string }}
 */
export function judgeGrepGate({ broadDir = false, contentUnlimited = false } = {}) {
  if (broadDir) {
    return {
      action: 'deny',
      reason: '目录级搜索会一次返回数百条正文；请补 include（如 "**/*.mjs"）或改为先定位文件名。',
    }
  }
  if (contentUnlimited) {
    return {
      action: 'deny',
      // 文案保持宿主中立：不同宿主的"仅文件名模式"参数名不同（Claude 的 files_with_matches、DSH 的 paths），
      // 由适配层在 reason 前缀里补本宿主的具体写法（2026-10-22 分层泄漏修复）。
      reason: '内容模式必须限量（limit ≤50），或先用"仅文件名"模式定位后精确读取。',
    }
  }
  return { action: 'allow', reason: '' }
}

/**
 * 裸 cat/type 刷屏闸。有管道、重定向或限量参数即视为已收窄。
 *
 * @param {string} command
 * @returns {'allow'|'deny'}
 */
export function judgeCatGate(command = '') {
  const cmd = String(command || '')
  if (!CAT_RE.test(cmd)) return 'allow'
  return CAT_GUARDED_RE.test(cmd) ? 'allow' : 'deny'
}
