/**
 * 测试运行时判定 —— 「关闭闸门」类开关的唯一准入条件（2026-10-29）。
 *
 * ── 为什么有这个文件 ──────────────────────────────────────────────────
 * 立法：**不允许关闭任何一个功能**。闸门只有「开」这一种状态。
 *
 * 但测试要验「闸拦住了」，就必须能造出「闸关掉」的对照组，否则只能测放行分支。
 * 折中：关闭能力只在**测试运行时**存在。生产环境里 `FG_EVIDENCE_GATE=0` 被读到
 * 也不生效——不是「设了无效」，是代码里根本没有那个分支可走（`gateSwitch` 恒返 true）。
 *
 * ── 判据为什么不用 `NODE_ENV === 'test'` ──────────────────────────────
 * 本仓测试跑法是 `node --test`，实测 `NODE_ENV` 为 `undefined`。用它做判据，
 * 等于把闸门的关闭权交给一个「谁都能随手设」的普通变量——比现在更糟。
 * `NODE_TEST_CONTEXT` 由 `node --test` 子进程自动注入（实测值 `child-v8`），
 * 生产环境不存在，无法被普通用户伪造。
 *
 * ── 与 `FG_*` 其他变量的关系 ─────────────────────────────────────────
 * 只有「关闭型」开关走本模块。调阈值（`FG_AUDIT_MAX_BYTES`）、换路径
 * （`FG_AUDIT_FILE`）、指执行体（`FG_SHELL`）不受影响——那些不关功能。
 */

/**
 * 是否运行在测试里。
 *
 * 判据（任一成立）：
 *   1. `NODE_TEST_CONTEXT` 存在 —— `node --test` 子进程自动设置
 *   2. `FG_TEST_MODE=1` —— 显式声明，给不走 `node --test` 的夹具/脚本用
 *
 * @returns {boolean}
 */
export function isTestRuntime() {
  return Boolean(process.env.NODE_TEST_CONTEXT) || process.env.FG_TEST_MODE === '1'
}

/**
 * 布尔型关闭开关：`offValue` 视为「关闭」，其余一律「开」。
 *
 * 生产环境恒 true —— 传什么值都关不掉。
 *
 * @param {string} name 环境变量名
 * @param {string} [offValue='0'] 视为关闭的值
 * @returns {boolean}
 */
export function gateSwitch(name, offValue = '0') {
  if (!isTestRuntime()) return true
  return process.env[name] !== offValue
}

/**
 * 数字型阈值兼开关（0 = 关闭）：生产环境下限 1，测试环境保留 0。
 *
 * 只禁「关掉」，不禁「调大调小」——`FG_RESULT_ADMIT_BUDGET=5` 在生产仍生效。
 *
 * @param {string} name 环境变量名
 * @param {number} fallback 缺省值
 * @returns {number}
 */
export function gateThreshold(name, fallback) {
  const raw = Number(process.env[name] ?? fallback)
  const n = Number.isFinite(raw) ? raw : fallback
  return isTestRuntime() ? n : Math.max(1, n)
}
