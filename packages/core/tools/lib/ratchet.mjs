import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * 存量棘轮台账（3.3 B，2026-10-30）
 *
 * ## 为什么需要
 *
 * 棘轮（`smells.mjs` 的 BUDGET / DUP_BUDGET）只能**防涨**，不能**催还**。
 * 实测：存量长期停在 8 / 41，闸门天天绿，债务一分没还。
 * 「顶格」其实是**最严**的状态（没有余量），所以问题不在阈值松，而在**没有还款义务**。
 *
 * 本模块把「降」从口号变成可校验的事实：台账里每个版本记一次实际值，发版时必须
 * 严格小于上一版本。想发版，就得先还一条债。
 *
 * ## 四条规则
 *
 *   ① 实测 ≤ 本版记账值 —— 防反弹（台账写完又被改坏）
 *   ② 本版总和 < 上一版总和 —— 每版至少还 1 条
 *   ③ 首版免 ② —— 总得有个起点
 *   ④ 自上次记账起 ≥10 次提交仍未降 —— 还款期限（2026-10-30 人类要求：
 *      「每 N 次提交必须降 1」。按版本记账的问题是：版本可以很久不发，
 *      于是 8/8 能一直挂着不动。改成按提交数催，才管得住「不发版就不还债」）
 *
 * ## 为什么不塞进 smells.mjs
 *
 * 那个文件 380 行，上限 400。台账逻辑加进去会把闸门自己顶成一条新的结构异味。
 * 判据：**闸门不能自己触发自己的告警**。
 */

/** 还款期限：自上次记账 commit 起，多少提交内必须还 1 条 */
export const COMMITS_PER_PAYBACK = 10

/**
 * 自某 commit 起的提交数。取不到就返回 null（浅克隆 / 非 git 仓库 / 无该 sha）。
 * 返回 null 时规则④跳过——**缺数据允许粗判，但必须在输出里写明**，不能假装查过。
 */
function commitsSince(repo, sha) {
  if (!sha) return null
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${sha}..HEAD`], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const n = Number(out.trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/**
 * 校验台账。
 *
 * @param {object} ledger 台账 JSON（`history` 数组，每项 {version, smells, duplicates}）
 * @param {string} version 当前版本号（取 package.json）
 * @param {{smells: number, duplicates: number}} actual 本次实测值
 * @returns {{findings: Array<{rule: string, detail: string}>, entry: object|null, total: number|null}}
 */
export function checkRatchet(ledger, version, actual, opts = {}) {
  const findings = []
  const history = Array.isArray(ledger?.history) ? ledger.history : []
  const idx = history.findIndex((h) => h && h.version === version)

  if (idx < 0) {
    findings.push({
      rule: 'no-ledger-entry',
      detail: `台账里没有 ${version} 的记账行——发版前先补一行（照实测值填）`,
    })
    return { findings, entry: null, total: null }
  }

  const cur = history[idx]
  const total = (cur.smells || 0) + (cur.duplicates || 0)

  // ① 防反弹：台账写下的数字，实测不得超过
  if (actual.smells > (cur.smells || 0)) {
    findings.push({
      rule: 'ratchet-rebound',
      detail: `结构异味 ${actual.smells} > 本版记账 ${cur.smells}`,
    })
  }
  if (actual.duplicates > (cur.duplicates || 0)) {
    findings.push({
      rule: 'ratchet-rebound',
      detail: `重复块 ${actual.duplicates} > 本版记账 ${cur.duplicates}`,
    })
  }

  // ② 还款义务：必须严格小于上一版
  let prevTotal = null
  if (idx > 0) {
    const prev = history[idx - 1]
    prevTotal = (prev.smells || 0) + (prev.duplicates || 0)
    if (!(total < prevTotal)) {
      findings.push({
        rule: 'ratchet-not-lowered',
        detail: `${version} 总和 ${total} 未小于 ${prev.version} 的 ${prevTotal}——每版至少还 1 条债`,
      })
    }
  }

  // ④ 还款期限：不发新版也要还债。只看「当前版本还没降」这一种情形——
  //    已经降过的（② 满足）不该再被催。
  //
  // 2026-10-31 修：原先写的是 `idx === 0 || total >= prevTotal`，首版（idx===0）恒为 stalled，
  // 于是「实测 29 < 记账 41、已经还了 12 条」照样被催债。注释里那句「已经降过的不该再被催」
  // 代码根本没实现——**判据与它自己声明的语义断线**，正是本轮一直在修的那个病。
  // 改为先看「实测是否低于本版记账值」，降过就不催；没降才按上一版比。
  const n = opts.commitsSinceLast
  if (typeof n === 'number' && n >= COMMITS_PER_PAYBACK) {
    // 「降」看的是**实测**，不是台账。第一版这里写成了 `total < booked`——而 total 就是
    // cur 的和、booked 也是 cur 的和，两边同一个数，恒为 false：判据又一次和自己的语义断线。
    const booked = (cur.smells || 0) + (cur.duplicates || 0)
    const lowered = (actual.smells || 0) + (actual.duplicates || 0) < booked
    const stalled = !lowered && (idx === 0 || total >= prevTotal)
    if (stalled) {
      findings.push({
        rule: 'ratchet-overdue',
        detail: `自上次记账（${cur.commit || '未记 commit'}）起已 ${n} 次提交，总和仍为 ${total}——超过 ${COMMITS_PER_PAYBACK} 次必须还 1 条`,
      })
    }
  }

  return { findings, entry: cur, total, commitsSinceLast: typeof n === 'number' ? n : null }
}

/** 还款期限的展示文案。放在这里而不是 smells.mjs——那文件 396 行，上限 400，加 4 行就自己超限。 */
export function paybackNote(check) {
  if (check.commitsKnown === false) return '（提交数取不到，只能粗判）'
  const n = check.commitsSinceLast
  return typeof n === 'number' ? `（距上次记账 ${n}/${COMMITS_PER_PAYBACK} 次提交）` : ''
}

/**
 * 读台账并校验，全程容错。
 *
 * 必须容错的理由：`FG_REPO_ROOT` 可以指向夹具仓库（测试就这么造），那里既没有
 * `package.json` 也没有台账。**闸门不能因为台账缺失就崩掉**——崩掉等于这条检查消失，
 * 而且是静默消失（子进程空输出，上层只看到"断言失败"）。
 *
 * @param {string} repo 仓库根
 * @param {{smells: number, duplicates: number}} actual
 * @returns {{findings: Array, entry: object|null, total: number|null, version?: string, skipped?: string}}
 */
export function loadRatchet(repo, actual) {
  const pkgPath = join(repo, 'package.json')
  const ledgerPath = join(repo, 'packages/core/docs/RATCHET.json')
  if (!existsSync(pkgPath)) return { findings: [], entry: null, total: null, skipped: '无 package.json（夹具仓库）' }
  if (!existsSync(ledgerPath)) {
    return { findings: [{ rule: 'no-ledger', detail: '台账 RATCHET.json 缺失' }], entry: null, total: null }
  }
  try {
    const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    const history = Array.isArray(ledger.history) ? ledger.history : []
    const last = history.length ? history[history.length - 1] : null
    const n = commitsSince(repo, last && last.commit)
    return {
      ...checkRatchet(ledger, version, actual, { commitsSinceLast: n }),
      version,
      // 取不到提交数时明说「只能粗判」——假装精确比承认不确定更糟
      commitsKnown: n !== null,
    }
  } catch (error) {
    return {
      findings: [{ rule: 'ledger-unreadable', detail: String(error && error.message) }],
      entry: null,
      total: null,
    }
  }
}
