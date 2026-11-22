/**
 * 模块台账的渲染（tools/lib/modules-doc.mjs，2026-11-19）
 *
 * 从 `modules.mjs` 拆出：那边要装算法，渲染是纯函数、与 git 无关，
 * 放一起只是让「怎么算」和「怎么写」互相挤。
 *
 * 只做一件事：把 `collectModules` 的结果写成 `docs/MODULES.md` 的 markdown。
 * 纯函数——同输入同输出，`checkModulesDoc` 靠这条做幂等比对。
 */

export const MODULES_DOC = 'docs/MODULES.md'

/** 累计提交少于此数视为「历史浅」：样本不足以谈节奏，本身也是遗忘风险。 */
const THIN = 3

const num = (v) => (v === null || v === undefined ? '—' : `${v}`)

/**
 * 结构指纹：只收**清单本身**（有哪些模块、叫什么、管什么），不收任何会随「现在」变的量。
 *
 * 本表含「距今 / 其后提交」这些活数据，逐字比对等于每次提交都要重新生成——
 * 而开发中途跑一次 `check` 就会因为「还没提交所以数字对不上」而红。
 * 那正是「永久红的闸门等于没有闸门」。所以判据只比指纹：
 * 模块清单变了而台账没重生成，才算落后；数字由 pre-commit 自动刷新。
 */
export function modulesKey({ rows }) {
  return rows.map((r) => `${r.id}|${r.name}|${r.note}`).join('\n')
}

export function renderModules({ head, version, age, total, rows }, coverage) {
  const count = (f) => rows.filter(f).length
  const out = [
    '# 模块修订台账（自动生成）',
    '',
    `> **状态**：权威 · 适用版本 ${version || '—'} · 最后核对 ${new Date().toISOString().slice(0, 10)}`,
    '',
    `> 由 \`.githooks/pre-commit\` 自动重新生成并 \`git add\`（HEAD \`${head ? head.slice(0, 7) : '—'}\`），**不要手改**。`,
    '> 手动重生成：`npm run modules:sync`；只看表：`npm run modules:table`。',
    `> 仓况：${age ?? '—'} 天 / ${total} 次提交。表里**没有一个手写日期**，全部现算——手写的真值一定会腐化`,
    '> （`docs/INDEX.md` 手抄版本实测 18 处与源不符）。手写的只有一样：**哪些路径算一个模块**。',
    '',
    '## 三个「距今」是什么意思',
    '',
    '一个模块里有几十个文件，它们不是一起变的。所以按文件各算一遍「距最后修订多少天」，取三个位置：',
    '',
    '- `最新距今` = 最勤快的那个文件。它只能说明「有人碰过这块」，说明不了这块是否还活着。',
    '- `中位距今` = 一半文件比它更新、一半比它旧。**判定看这一列**。',
    '- `最久距今` = 最沉的那个文件，极端值，供人看死角。',
    '',
    '为什么判定用中位而不用最新：实测 `tools` 最新文件 0 天、中位文件 16 天；',
    '`src/core` 最新 0 天、中位 21 天。一个 61 文件的目录里两个在动，取最新就显示「活跃」——',
    '「个别文件活跃、其余很少动」正是这样被遮住的。中位数不会被少数活跃文件带跑。',
    '',
    '## 判定依据是「其后全仓提交」，不是天数',
    '',
    '`中位·其后全仓提交` = 中位那个文件最后修订之后，仓库又提交了多少次。',
    '`≥30` 偏冷 ｜ `≥80` 临期 ｜ `≥150` 久未动。它是相对量——仓库走得快，三十次就是三天；',
    '走得慢，三十次就是半年。所以不需要给每个模块单独配天数。',
    '',
    `合计 ${rows.length} 个模块：久未动 ${count((r) => r.level === '久未动')} / 临期 ${count((r) => r.level === '临期')} / 偏冷 ${count((r) => r.level === '偏冷')} / 活跃 ${count((r) => r.level === '活跃')} / 无法定位 ${count((r) => r.level === '无法定位')}。`,
    '',
    '| 模块 | 管什么 | 文件 | 最新修订 | 最新距今 | 中位距今 | 最久距今 | 中位·其后全仓提交 | 判定 |',
    '|---|---|---|---|---|---|---|---|---|',
  ]
  for (const r of rows) {
    const mark = { 久未动: '**久未动**', 临期: '**临期**', 偏冷: '偏冷', 活跃: '活跃', 无法定位: '无法定位' }[r.level]
    const flags = []
    if (r.touches < THIN) flags.push('历史浅')
    if (r.dirty) flags.push('有未提交改动')
    const state = flags.length ? `${mark} · ${flags.join(' · ')}` : mark
    const when = r.date ? `${r.date.slice(0, 10)} \`${r.hash}\`` : '—'
    out.push(
      `| **${r.name}**<br>\`${r.id}\` | ${r.note} | ${num(r.files)} | ${when} | ${num(r.latestDays)} | ${num(r.medianDays)} | ${num(r.oldestDays)} | ${num(r.median)} | ${state} |`,
    )
  }
  out.push('')
  out.push('> 「无法定位」= 该模块的路径在 git 历史里没有任何提交，或本机没有 git。')
  out.push(`> 「历史浅」= 累计提交不足 ${THIN} 次，没有节奏可参照——这类模块比高频模块更容易被忘掉。`)
  if (coverage) {
    out.push(
      `> 覆盖：受管文件 ${coverage.total} 个，其中仓根元数据 ${coverage.meta} 个（LICENSE / package.json / CI 一类，本来就不归属任何模块）；` +
        `**未被任何模块认领的功能文件 ${coverage.unowned} 个**。`,
    )
    out.push('> 这一项不是摆设：清单曾漏掉整个 `packages/extended`，而它 43 天没动、史上只有 5 次提交，最该提醒的那块根本不在表里。')
    out.push('> `docs:lint` 的 `modules-unowned-path` 会盯着它——**冒出未归属的功能文件就是错**，久未动不是。')
  }
  out.push('> 若路径写错，`modules-path-missing` 会红；两个模块抢同一个文件，`modules-path-overlap` 会红。')
  out.push('> 本表自身**不进 `docs:lint`**：`其后全仓提交` 每次提交都会变，当硬闸就是每次 commit 红一次。')
  out.push('> 它由 pre-commit 自动重生成，所以永远是最新的；`npm run modules:audit -- --check-doc` 可手动核。')
  out.push('')
  out.push('<!-- modules-key（判据用，勿改）')
  out.push(modulesKey({ rows }))
  out.push('-->')
  out.push('')
  return out.join('\n')
}
