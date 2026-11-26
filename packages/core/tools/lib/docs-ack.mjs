/**
 * 状态头「最后核对」的时效判据（2026-11-26）：**不得早于该文件的最后一次提交日期**。
 *
 * ## 起因
 *
 * 2026-11-26 接手盘点：35 份文档的状态头日期早于它们各自的最后提交，权威文档里
 * `README.md` 写 11-19（实际 11-26 改过）、`ARCH-MAP.md` 写 11-18 且版本停在 3.5.2。
 * 这不是笔误，是**结构性的**：`docs-status.mjs` 只负责把状态头拼成总表，
 * `docs-core.mjs` 只查「权威文档有没有状态头」，**没有一条规则问过『这行日期还诚实吗』**。
 * 于是总表越整齐，越像真的。
 *
 * ## 判据
 *
 * 只查 `权威`。`参考` 的定义就是「有价值但可能滞后」，`台账`/`归档` 是过程记录与冻结历史，
 * 逼它们改日期等于让闸门逼文档说谎——与 `docs-status.mjs` 拒绝「适用版本 == 当前版本」同一个理由。
 *
 * ## 为什么用 git 日期而不是 mtime
 *
 * mtime 随 clone / checkout 全变，且不区分「改了正文」与「只是格式化」。git 的提交日期是
 * **这条内容进入仓库的时间**，正是「最后核对」想声明的那个时刻。代价是浅克隆下不可信：
 * `actions/checkout` 默认 `fetch-depth: 1` 时每个文件都显示成 tip 那次提交，
 * 于是全部判红。这种情况**跳过并说明**，不假红——永久红的闸门等于没有闸门。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { listMarkdownFiles } from './docs-core.mjs'
import { parseStatusHeader } from './docs-status.mjs'

/**
 * 每个文件最后一次被提交的日期（`YYYY-MM-DD`）。
 *
 * 一次 `git log` 拿全部，而不是每文件一次（45 份文档 × 30ms 会让 `gate:fast` 多出 1.4s）。
 * 无法判断时返回 `null`：非 git 目录、浅克隆、git 不可用——三种都不该让闸门红。
 */
export function lastCommitDates(root) {
  try {
    if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' }).trim() === 'true') {
      return null
    }
    // 分隔符不能用 NUL：`argv` 里传不了 NUL，git 会把 `\u0000` 当字面量收下，
    // 于是切不开、一条都判不到——「闸门在跑但空转」比红更难发现（2026-11-26 实测踩到）。
    const out = execFileSync('git', ['log', '--date=short', '--pretty=format:@@%ad', '--name-only'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
    const dates = new Map()
    for (const chunk of out.split('@@')) {
      const lines = chunk.split('\n')
      const date = (lines.shift() || '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      for (const raw of lines) {
        const p = raw.trim()
        if (!p || dates.has(p)) continue // log 是倒序：先见到的就是最后一次
        dates.set(p, date)
      }
    }
    return dates
  } catch {
    return null
  }
}

/** 判据：权威文档的「最后核对」不得早于最后提交日期。 */
export function checkAckFreshness(root, files = listMarkdownFiles(root)) {
  const dates = lastCommitDates(root)
  if (!dates) return []
  const findings = []
  for (const abs of files) {
    const rel = relative(root, abs).split('\\').join('/')
    let head = null
    try {
      head = parseStatusHeader(readFileSync(abs, 'utf8'))
    } catch {
      continue
    }
    if (!head || head.status !== '权威') continue
    const commit = dates.get(rel)
    if (!commit) continue // 未入库（新文件还没提交）：无从比较，不假红
    if (!head.date) {
      findings.push({ rule: 'missing-ack', file: rel, line: 1, detail: `权威文档缺「最后核对」日期（最后提交 ${commit}）` })
      continue
    }
    if (head.date < commit) {
      findings.push({
        rule: 'stale-ack',
        file: rel,
        line: 1,
        detail: `最后核对 ${head.date} 早于最后提交 ${commit}——正文改过而状态头没跟上`,
      })
    }
  }
  return findings
}
