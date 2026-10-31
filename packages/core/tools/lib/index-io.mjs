/**
 * 索引工具的公共 IO（2026-10-31）
 *
 * `library-index.mjs` 与 `knowledge.mjs` 的 `--check` 分支逐行相同——
 * smells 当场报「重复 9 行」，重复块从 41 涨到 43，顶破棘轮。
 *
 * 两个索引工具的差异只有三样：产物路径、索引字段名、条目唯一键。
 * 其余（读旧索引、比对、报漂移、写盘）全一样，抽到这里。
 *
 * 唯一键由调用方给：`library-index` 用 `id|file|chars`，
 * `knowledge` 用 `ns:id:path:chars`——后者多一个命名空间，
 * 因为源文件与积木的编号撞车（都是 B001）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** 集合比对。keyOf 决定什么算「同一条」——改一个字就必须变。 */
export function diffKeys(expected, actual, keyOf, field) {
  const a = new Set((expected[field] || []).map(keyOf))
  const b = new Set((actual[field] || []).map(keyOf))
  return {
    missing: [...a].filter((k) => !b.has(k)),
    extra: [...b].filter((k) => !a.has(k)),
  }
}

/**
 * 写盘或比对，二选一。返回 `{ code, message, detail? }`，调用方负责打印与退出。
 * `code` 就是进程退出码：0 干净 / 1 漂移或缺基线 / 2 无数据（调用方自己判）。
 */
export function emit({ out, index, check, keyOf, field, label, summary }) {
  if (!check) {
    writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), ...index }, null, 2) + '\n')
    return { code: 0, message: summary }
  }
  if (!existsSync(out)) {
    return { code: 1, message: `${label} 不存在，先跑一次不带 --check 的` }
  }
  const { missing, extra } = diffKeys(index, JSON.parse(readFileSync(out, 'utf8')), keyOf, field)
  if (missing.length || extra.length) {
    return {
      code: 1,
      message: `漂移：磁盘侧新增 ${missing.length} 条、索引侧多余 ${extra.length} 条`,
      detail: [...missing, ...extra].slice(0, 10),
    }
  }
  return { code: 0, message: `零漂移，${(index[field] || []).length} 条` }
}

/**
 * 索引工具的整个 main 骨架：建 → 空判 → 写/比 → 打印 → 退出。
 *
 * 上一步只抽了 `emit`，两个 `main` 仍逐行相同（smells 报重复 17 行，比抽之前更长）。
 * 说明「只抽中间一段」不够——**重复的是骨架，不是某一段**。
 *
 * `summary` 收函数而不是字符串：调用方要按自己的字段算（块数/条数/字数）。
 */
export function runIndexTool({ argv, build, field, out, label, keyOf, empty, summary, prefix }) {
  const index = build()
  if (!(index[field] || []).length) {
    console.error(`${prefix} ${empty}`)
    process.exit(2)
  }
  const r = emit({ out, index, check: argv.includes('--check'), keyOf, field, label, summary: summary(index) })
  if (r.code) {
    console.error(`${prefix} ${r.message}`)
    for (const k of r.detail || []) console.error(`  ${k}`)
    process.exit(r.code)
  }
  console.log(`${prefix} ${r.message}`)
}
