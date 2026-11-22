/**
 * 文档状态总表（2026-11-19）：`docs/STATUS.md` 由本文件生成，**不手写**。
 *
 * ## 起因
 *
 * `docs/INDEX.md` 曾手抄一份「状态 / 适用版本 / 最后核对」表。2026-11-19 实测
 * **18 处与文档自身状态头冲突**——`RULES.md` 自己写 3.3.0·10-28，索引写 3.2.1·10-27；
 * `ARCH-MAP.md` 自己写 3.5.2，索引写 3.2.1。旧判据 `checkIndexCoverage` 只查
 * 「链接能不能点到」，**不查抄的数字对不对**，所以两份真值分叉了二十多天没人发现。
 *
 * 修法不是「再查一遍手抄表」，而是**取消手抄**：真值只有一个（文档自己的状态头），
 * 总表由它生成。手写的东西会腐化，生成的东西只跟着源一起腐化。
 *
 * ## 落后口径
 *
 * `落后` 只对**权威**文档有意义——`参考` 的定义就是「有价值但可能滞后」，
 * `台账` 是过程记录。所以该列对非权威显示 `—`。
 *
 * **不要求「适用版本 == 当前版本」**：文档没改过就说 3.3.0 是**真话**，
 * 逼它改成 3.5.3 才是让闸门逼文档说谎（同 `checkVersionFace` 2026-11-05 的教训）。
 * 本文件只**呈现**落后，不判它对错——判对错需要人。
 *
 * 为什么单独一份而不是塞进 `docs-core.mjs`：那个文件已 366 行，`smells` 阈值 400。
 * 与 `docs-version.mjs` 当初从 docs-core 拆出去是同一个理由。
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { listMarkdownFiles } from './docs-core.mjs'

export const STATUS_DOC = 'docs/STATUS.md'

/** 解析状态头。只认前 12 行里的 `> **状态**：X · 适用版本 Y · 最后核对 Z`。 */
export function parseStatusHeader(text) {
  const head = text.split(/\r?\n/).slice(0, 12).join('\n')
  const m = head.match(/>\s*\*\*状态\*\*\s*[：:]\s*([^\s·|（(]+)([^\n]*)/)
  if (!m) return null
  const rest = m[2] || ''
  const v = rest.match(/适用版本\s*([^\s·|]+)/)
  const d = rest.match(/最后核对\s*(\d{4}-\d{2}-\d{2})/)
  // 版本写法很杂：`3.3.0（4.5 前置）` / `3.3.2 / 3.5.0 / 4.0-P2` / `4.0 前置`。
  // 只取第一个数值串；取不出 x.y.z 的一律当「无版本面」，不参与落后计算。
  const raw = v ? v[1].split(/[（(/、,，]/)[0].trim() : ''
  const numeric = /^\d+\.\d+\.\d+$/.test(raw) ? raw : null
  return { status: m[1], version: numeric, rawVersion: v ? v[1] : null, date: d ? d[1] : null }
}

/** 次版本号距离：`3.3.0 → 3.5.3` 得 2（跨大版本按 ×10 折算）。 */
function minorDistance(from, to) {
  const a = String(from).split('.').map(Number)
  const b = String(to).split('.').map(Number)
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((n) => !Number.isFinite(n))) return null
  return (b[0] - a[0]) * 10 + (b[1] - a[1])
}

const STATUS_ORDER = { 权威: 0, 参考: 1, 台账: 2, 归档: 3 }

/**
 * 收集全仓文档状态（相对路径 + 状态头 + 落后档数 + 距今天数）。
 *
 * **排除 `docs/STATUS.md` 自己**：表里列一行「STATUS.md，权威，落后 0」毫无信息，
 * 却会让生成结果依赖上一次的生成结果——第一次 40 行、第二次 41 行，`checkStatusTable`
 * 的幂等比对永远红。自引用是生成器最经典的坑，直接在源上剪掉。
 */
export function collectDocStatus(root, files = listMarkdownFiles(root), now = new Date()) {
  const current = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).version
  const rows = []
  for (const file of files) {
    const rel = relative(root, file).split('\\').join('/')
    if (rel === STATUS_DOC) continue
    const head = parseStatusHeader(readFileSync(file, 'utf8'))
    const days = head?.date ? Math.floor((now - new Date(`${head.date}T00:00:00`)) / 86400000) : null
    const behind = head?.version ? minorDistance(head.version, current) : null
    rows.push({ rel, status: head?.status || null, version: head ? head.version || head.rawVersion : null, date: head?.date || null, days, behind })
  }
  // 权威在前；同类里落后的在前——「该先看哪份」由排序直接回答，不用读者自己找。
  rows.sort((x, y) => {
    const sx = STATUS_ORDER[x.status] ?? 4
    const sy = STATUS_ORDER[y.status] ?? 4
    if (sx !== sy) return sx - sy
    return (y.behind ?? -1) - (x.behind ?? -1) || x.rel.localeCompare(y.rel)
  })
  return { current, rows }
}

/** 渲染 `docs/STATUS.md`。**纯函数**：同输入必得同输出（`checkStatusTable` 靠这条做幂等比对）。 */
/**
 * 结构指纹：只收**不随「现在」变**的字段（哪份文档、状态、版本、最后核对）。
 *
 * 为什么要它：本表含「距今天数」和生成当天的日期，逐字比对等于**每天都必须重新生成**，
 * 一天不生成 `status-table-stale` 就红——那正是「永久红的闸门等于没有闸门」。
 * 判据改成比指纹：文档集合与状态头一致即可；「多久没核对」由 pre-commit 自动刷新。
 */
export function statusKey({ rows }) {
  return rows.map((r) => [r.rel, r.status || '未标', r.version || '—', r.date || '—'].join('|')).join('\n')
}

export function renderStatusTable({ current, rows }) {
  const count = (s) => rows.filter((r) => r.status === s).length
  const out = [
    '# 文档状态总表（自动生成）',
    '',
    `> **状态**：权威 · 适用版本 ${current} · 最后核对 ${new Date().toISOString().slice(0, 10)}`,
    '',
    '> 由 `npm run docs:status` 从各文档自己的状态头生成，**不要手改**——手改会被 `docs:lint` 判 `status-table-stale`。',
    '> 真值只有一个：每份文档开头那行 `> **状态**：…`。本表只是把它们拼成一页。',
    '> 「落后」= 适用版本比当前次版本号落后几档，**只对权威文档计**（参考/台账按定义可以滞后）。',
    '> 法条（`RULES.md`）的适用版本记的是**最后一次修法**时的产品版本，长期落后是常态、不是欠债。',
    '> 加粗 = 值得先看：落后 > 0，或最后核对已超 45 天。',
    '',
    `合计 ${rows.length} 份：权威 ${count('权威')} / 参考 ${count('参考')} / 台账 ${count('台账')} / 归档 ${count('归档')} / 未标 ${rows.filter((r) => !r.status).length}。`,
    '',
    '| 文档 | 状态 | 适用版本 | 最后核对 | 距今天数 | 落后 |',
    '|---|---|---|---|---|---|',
  ]
  for (const r of rows) {
    const behind = r.status !== '权威' ? '—' : r.behind === null ? '—' : r.behind > 0 ? `**${r.behind}**` : '0'
    const days = r.days === null ? '—' : r.days > 45 ? `**${r.days}**` : String(r.days)
    out.push(`| [\`${r.rel}\`](../${r.rel}) | ${r.status || '未标'} | ${r.version || '—'} | ${r.date || '—'} | ${days} | ${behind} |`)
  }
  out.push('')
  out.push('<!-- status-key（判据用，勿改）')
  out.push(statusKey({ rows }))
  out.push('-->')
  out.push('')
  return out.join('\n')
}

/** 判据：`docs/STATUS.md` 的**结构指纹**必须与现算一致（不看距今天数——那个每天都变）。 */
export function checkStatusTable(root, files = listMarkdownFiles(root)) {
  const target = join(root, STATUS_DOC)
  const want = renderStatusTable(collectDocStatus(root, files))
  let got = ''
  try {
    got = readFileSync(target, 'utf8')
  } catch {
    return [{ rule: 'status-table-stale', file: STATUS_DOC, line: 1, detail: '总表不存在，跑 `npm run docs:status` 生成' }]
  }
  const keyOf = (t) => (t.match(/<!-- status-key[^\n]*\n([\s\S]*?)\n-->/) || [, ''])[1]
  if (keyOf(got) !== keyOf(want)) {
    return [{ rule: 'status-table-stale', file: STATUS_DOC, line: 1, detail: '总表与各文档状态头不一致，跑 `npm run docs:status` 重新生成' }]
  }
  return []
}
