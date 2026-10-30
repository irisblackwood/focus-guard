import { existsSync, readFileSync } from 'node:fs'
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
 * ## 三条规则
 *
 *   ① 实测 ≤ 本版记账值 —— 防反弹（台账写完又被改坏）
 *   ② 本版总和 < 上一版总和 —— 每版至少还 1 条
 *   ③ 首版免 ② —— 总得有个起点
 *
 * ## 为什么不塞进 smells.mjs
 *
 * 那个文件 380 行，上限 400。台账逻辑加进去会把闸门自己顶成一条新的结构异味。
 * 判据：**闸门不能自己触发自己的告警**。
 */

/**
 * 校验台账。
 *
 * @param {object} ledger 台账 JSON（`history` 数组，每项 {version, smells, duplicates}）
 * @param {string} version 当前版本号（取 package.json）
 * @param {{smells: number, duplicates: number}} actual 本次实测值
 * @returns {{findings: Array<{rule: string, detail: string}>, entry: object|null, total: number|null}}
 */
export function checkRatchet(ledger, version, actual) {
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
  if (idx > 0) {
    const prev = history[idx - 1]
    const prevTotal = (prev.smells || 0) + (prev.duplicates || 0)
    if (!(total < prevTotal)) {
      findings.push({
        rule: 'ratchet-not-lowered',
        detail: `${version} 总和 ${total} 未小于 ${prev.version} 的 ${prevTotal}——每版至少还 1 条债`,
      })
    }
  }

  return { findings, entry: cur, total }
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
    return { ...checkRatchet(ledger, version, actual), version }
  } catch (error) {
    return {
      findings: [{ rule: 'ledger-unreadable', detail: String(error && error.message) }],
      entry: null,
      total: null,
    }
  }
}
