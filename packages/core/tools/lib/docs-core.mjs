/**
 * 文档口径内核（3.3 D5 / D2）：版本面 + 相对链接 + 状态头 + INDEX 覆盖。纯函数，零依赖。
 *
 * 机械判定的四件事：
 *  1) **版本面**：七处清单 + `ENGINE_VERSION` 必须等于 CHANGELOG 最新版本段；
 *  2) **相对链接**：仓库内 `.md` 的 `[text](path)` 目标文件必须存在（http/mailto/锚点跳过）；
 *  3) **状态头**（D2）：权威文档正文必须带 `> **状态**：权威 · 适用版本 … · 最后核对 …`；
 *  4) **INDEX 覆盖**（D2）：权威文档必须能从 `docs/INDEX.md` 的链接到达。
 *
 * 不做的（各自有理由）：README 硬指标属于 3.4 D1、数字单点属于 D4、排版属于 `changelog-format`。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** 七处清单（与 RELEASE-POLICY 第三节逐字对应）。 */
export const VERSION_FILES = [
  'package.json',
  'marketplace.json',
  '.zcode-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  'packages/core/package.json',
  'packages/extended/package.json',
]

/**
 * 权威文档（D2）。新增权威文档必须同时：① 正文带状态头 ② 进 `docs/INDEX.md`。
 * `docs/INDEX.md` 自己是索引，不要求在索引里自我链接。
 */
export const AUTHORITATIVE_DOCS = [
  'README.md',
  'docs/ARCHITECTURE.md',
  'INSTALL.md',
  'CHANGELOG.md',
  'packages/core/docs/RULES.md',
  'packages/core/docs/ARCH-MAP.md',
  'packages/core/docs/VERSION-PLAN.md',
  'packages/core/docs/RELEASE-POLICY.md',
  'packages/core/docs/WRITING-STYLE.md',
  'packages/core/docs/BENCH.md',
  'packages/core/docs/PROFILE-TUNING.md',
]

// `HANDOFF.md` 是本机私有备忘（在 .git/info/exclude 里），不属于公开文档面，
// 混进来会让"文档口径"这个数字同时反映私有文件——口径不纯。
const SKIP_SEGMENTS = new Set(['node_modules', '.git', '.focus-guard', '.ai', 'self-improvement', 'archived', 'archive', 'backup', 'HANDOFF.md'])
// 2026-10-31（3.4 D3）：`docs/archive/` 是历史证据，链接按旧路径原样保留才不失真，
// 因此归档文档整体不进 lint（不查链接/状态头）；INDEX 仍负责列出它们。

/** 遍历仓库内 Markdown（排除运行产物与归档）。 */
export function listMarkdownFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (SKIP_SEGMENTS.has(entry.name)) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.name.toLowerCase().endsWith('.md')) out.push(full)
    }
  }
  walk(root)
  return out
}

/** CHANGELOG 最新版本段（`## x.y.z`）。 */
export function changelogLatest(root) {
  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const m = text.match(/^## (\d+\.\d+\.\d+)/m)
  return m ? m[1] : null
}

/** 七个清单的 version + ENGINE_VERSION + CHANGELOG 最新段必须一致。 */
/**
 * 已推送版本锚点：`tests/changelog-audience.test.mjs` 里的 `PUBLISHED_MAX`。
 * 读不到返回 null——**不假红**（测试文件被改名不该让文档闸门误报）。
 */
export function publishedMax(root) {
  try {
    const text = readFileSync(join(root, 'packages/core/tests/changelog-audience.test.mjs'), 'utf8')
    const m = text.match(/PUBLISHED_MAX\s*=\s*["']([^"']+)["']/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** 粗比 semver（只比 x.y.z 三段数字）；任一侧不可解析返回 0（不比较）。 */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  if (pa.length !== 3 || pb.length !== 3) return 0
  if ([...pa, ...pb].some((n) => !Number.isFinite(n))) return 0
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  return 0
}

/**
 * 版本面检查（2026-11-05 改判据）。
 *
 * **改之前的病**：拿"本地 CHANGELOG 最新段"当唯一真值，于是每写一条还没推送的记录，
 * 所有清单都被逼着改成那个号——**闸门在逼着文档说谎**。对外读者看到的应当是"已发布"，
 * 不是"作者本地写到哪了"。这就是"四套版本号并存"的机械成因。
 *
 * **现在三条判据，各管一件事**：
 *   ① 清单之间必须互相一致（内部自洽；本地可以领先发布，但不能自相矛盾）；
 *   ② CHANGELOG 最新段不得**落后**于清单（可以领先，领先就是"未推送"）；
 *   ③ 对外展示（README badge / 状态头）必须等于 `PUBLISHED_MAX`（已推送），不跟本地开发版本走。
 */
export function checkVersionFace(root) {
  const findings = []
  const versions = []
  for (const rel of VERSION_FILES) {
    const file = join(root, rel)
    try {
      const json = JSON.parse(readFileSync(file, 'utf8'))
      // 根 marketplace.json / .claude-plugin/marketplace.json 的版本在 plugins[0].version；
      // 其余清单是顶层 version。两种形状都认，避免"读不到就静默算 undefined"。
      const value = json.version ?? (Array.isArray(json.plugins) ? json.plugins[0]?.version : undefined)
      versions.push({ where: rel, value })
    } catch (error) {
      findings.push({ rule: 'version-unreadable', file: rel, line: 1, detail: String(error && error.message) })
    }
  }
  const constFile = join(root, 'packages/core/src/core/constants.mjs')
  const constText = readFileSync(constFile, 'utf8')
  const em = constText.match(/ENGINE_VERSION\s*=\s*["']([^"']+)["']/)
  versions.push({ where: 'packages/core/src/core/constants.mjs ENGINE_VERSION', value: em ? em[1] : null })

  // ① 清单之间一致。基准取**众数**而非第一个：否则"改坏第一个"会把其余全部报红，
  //    一条错变成七条错，红的数量跟病灶无关，人就学会忽略红。
  const tally = new Map()
  for (const v of versions) if (v.value) tally.set(v.value, (tally.get(v.value) || 0) + 1)
  let base = versions[0]?.value
  let best = 0
  for (const [value, n] of tally) {
    if (n > best) {
      base = value
      best = n
    }
  }
  for (const v of versions) {
    if (base && v.value !== base) {
      findings.push({
        rule: 'version-inconsistent',
        file: v.where,
        line: 1,
        detail: `${v.value} ≠ ${base}（清单之间必须一致）`,
      })
    }
  }

  // ② CHANGELOG 不得落后于清单
  const latest = changelogLatest(root)
  if (latest && base && cmpVersion(latest, base) < 0) {
    findings.push({
      rule: 'version-changelog-behind',
      file: 'CHANGELOG.md',
      line: 1,
      detail: `最新段 ${latest} 落后于清单 ${base}`,
    })
  }

  // ③ 对外展示盯远端
  const published = publishedMax(root)
  if (published) findings.push(...checkReadmeVersionFace(root, published))

  return findings
}

/**
 * 对外展示的版本号（README badge / 状态头）必须等于 `PUBLISHED_MAX`。
 *
 * 单独成函数有两个理由：① `checkVersionFace` 会超长函数阈值；
 * ② 这条判据管的是"读者看到的" ，与"清单之间是否自洽"是两件事，分开才改得动。
 */
function checkReadmeVersionFace(root, published) {
  const findings = []
  let readme = ''
  try {
    readme = readFileSync(join(root, 'README.md'), 'utf8')
  } catch {
    return findings
  }
  const shown = []
  const badge = readme.match(/badge\/version-(\d+\.\d+\.\d+)/)
  if (badge) shown.push({ where: 'README.md badge', value: badge[1] })
  const head = readme.match(/适用版本\s*(\d+\.\d+\.\d+)/)
  if (head) shown.push({ where: 'README.md 状态头', value: head[1] })
  for (const s of shown) {
    if (s.value !== published) {
      findings.push({
        rule: 'version-face-stale',
        file: s.where,
        line: 1,
        detail: `${s.value} ≠ 已推送 ${published}（对外展示盯远端，不盯本地）`,
      })
    }
  }
  return findings
}

/**
 * 对外文档不得出现"某月某日人类说了什么"（2026-11-05 定）。
 *
 * 决策只写**规则 + 日期**，主语省略；原话属过程材料，归 `HANDOFF`。
 * 反例：`超预算不裁剪（2026-10-30 人类批示「半句比不写危害大的多」）`
 * 正例：`超预算不裁剪（2026-10-30）`
 *
 * 为什么不靠自觉：PATTERNS.md 建库 27 天零条就是"只有规矩没有闸门"的下场。
 *
 * 范围只含**活跃对外文档**：`README` / `CHANGELOG` / `docs/`（排除 `archive` 与 `vault-notes`）。
 * 这两处 2026-11-05 已按要求清过一次，但**不纳入闸门**：归档是历史证据，闸门管到它
 * 等于逼后人改历史；`vault-notes` 是外部资料摘录，会被重新生成覆盖。
 */
const CITATION_RE = /人类批示|人类原话|人类报告/
export function checkCitationStyle(root) {
  const findings = []
  const targets = ['README.md', 'CHANGELOG.md']
  for (const abs of listMarkdownFiles(root)) {
    const rel = relative(root, abs).split('\\').join('/')
    if (!rel.startsWith('docs/')) continue
    if (rel.startsWith('docs/archive/') || rel.startsWith('docs/vault-notes/')) continue
    targets.push(rel)
  }
  for (const rel of targets) {
    let text = ''
    try {
      text = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (CITATION_RE.test(lines[i])) {
        findings.push({
          rule: 'citation-style',
          file: rel,
          line: i + 1,
          detail: '决策写规则与日期，不写"谁说的"（原话归 HANDOFF）',
        })
      }
    }
  }
  return findings
}

/**
 * 行内代码里的仓库相对路径必须能解析（3.3 A）。
 *
 * 为什么单列一条：`checkRelativeLinks` 只查 `[文字](路径)`，而本仓大量引用写成**行内代码**
 * `` `tools/lint.mjs` ``——这部分从来没被校验过。于是出现「CHANGELOG 指向
 * `docs/HOOK-ORDERING.md`、文件实际在 `packages/core/docs/`」这种悬空，读者按字面找不到。
 *
 * **基准不唯一是现状**（2026-10-30 实测 223 条）：142 条相对 `packages/core/`、
 * 74 条相对仓库根。所以两个根都试，能解析就算过；两边都不成立才算死引用。
 * 这条规则同时也是"两个 docs 根该不该合并"的尺子——等哪天真单根化了，把它收紧成单根即可。
 */
export function checkCodePathRefs(root, files = listMarkdownFiles(root)) {
  const REF = /`([A-Za-z0-9_./-]+\.(?:md|mjs|json))`/g
  const REPO_REL = /^(?:docs|packages|tools|src)\//
  const findings = []
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, '/')
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      // 表格行里的路径是**数据**不是指针：RULES.md 有一张「蓝图路径 → 实际部署」映射表，
      // 左列写的是设想中的文件（`src/guard.mjs`），从来不存在也不该存在。
      // 只校验正文里的引用（含列表项），才是"读者会照着去找"的那类。
      if (/^\s*\|/.test(line)) return
      for (const m of line.matchAll(REF)) {
        const p = m[1]
        if (!REPO_REL.test(p)) continue
        if (existsSync(join(root, p)) || existsSync(join(root, 'packages/core', p))) continue
        findings.push({ rule: 'dead-code-path', file: rel, line: i + 1, detail: p })
      }
    })
  }
  return findings
}

/** 相对链接目标存在性（跳过 http(s)/mailto/锚点/空链接）。 */
export function checkRelativeLinks(root, files = listMarkdownFiles(root)) {
  const findings = []
  const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, '/')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      // 先剥掉行内代码：`` `[文字](路径)` `` 是在**讲**链接语法，不是真链接。
      // 不剥的话，任何"举例说明链接写法"的文档都会自己把自己判成死链（2026-10-30 踩过）。
      const text = line.replace(/`[^`]*`/g, '')
      for (const m of text.matchAll(LINK)) {
        const raw = String(m[1] || '').trim().replace(/^<|>$/g, '')
        if (!raw || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(raw)) continue
        const target = raw.split('#')[0].split('?')[0]
        if (!target) continue
        const abs = resolve(dirname(file), target)
        if (!existsSync(abs)) {
          findings.push({ rule: 'dead-link', file: rel, line: i + 1, detail: `${raw} → ${abs}` })
        }
      }
    })
  }
  return findings
}

/** D2：权威文档正文必须带状态头（`> **状态**：权威 · 适用版本 … · 最后核对 …`）。 */
export function checkStatusHeaders(root, docs = AUTHORITATIVE_DOCS) {
  const findings = []
  for (const rel of docs) {
    const text = readFileSync(join(root, rel), 'utf8')
    if (!/^> \*\*状态\*\*：权威[^\n]*适用版本[^\n]*最后核对/m.test(text)) {
      findings.push({ rule: 'missing-status-header', file: rel, line: 1, detail: '缺「> **状态**：权威 · 适用版本 … · 最后核对 …」' })
    }
  }
  return findings
}

/** D2：`docs/INDEX.md` 必须能到达每一份权威文档（链接解析后按绝对路径比对）。 */
/**
 * docs/ 与 packages/core/docs/ 下的全部 `.md`（相对仓库根）。
 *
 * 为什么需要：`checkIndexCoverage` 原先只查「权威」文档，于是「参考」级的漏登记不报。
 * 2026-10-30 我判定 `HOOK-ORDERING.md`「不存在」——只查了 `docs/`，而它一直在
 * `packages/core/docs/`，且没在 INDEX 里登记（25 份里漏 1 份，正是这份）。
 * 两个根并存时，检索顺序决定结论；**INDEX 漏登记 = 那份文档在入口页上不存在**。
 * 所以口径从「权威文档」扩到「全部文档」：只要落在文档目录里，就必须能点得到。
 */
export function allDocFiles(root) {
  const out = []
  for (const dir of ['docs', 'packages/core/docs']) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs)) {
      if (name.endsWith('.md') && name !== 'INDEX.md') out.push(`${dir}/${name}`)
    }
  }
  return out
}

export function checkIndexCoverage(root, docs = AUTHORITATIVE_DOCS) {
  const findings = []
  const indexPath = join(root, 'docs/INDEX.md')
  if (!existsSync(indexPath)) {
    return [{ rule: 'missing-index', file: 'docs/INDEX.md', line: 1, detail: '索引文件不存在' }]
  }
  const text = readFileSync(indexPath, 'utf8')
  const reached = new Set()
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = String(m[1] || '').trim()
    if (!raw || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(raw)) continue
    reached.add(resolve(dirname(indexPath), raw.split('#')[0]))
  }
  for (const rel of docs) {
    if (!reached.has(resolve(root, rel))) {
      findings.push({ rule: 'index-missing', file: rel, line: 1, detail: '权威文档未出现在 docs/INDEX.md 的链接里' })
    }
  }
  return findings
}

/** D1：README 硬指标（行数 / 标题数 / 表格行数 / 三位数只留版本号）。 */
export const README_LIMITS = { lines: 160, headings: 10, tableRows: 30 }

export function checkReadmeMetrics(root) {
  const file = join(root, 'README.md')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const findings = []
  if (lines.length > README_LIMITS.lines) {
    findings.push({ rule: 'readme-lines', file: 'README.md', line: 1, detail: `${lines.length} 行（上限 ${README_LIMITS.lines}）` })
  }
  const headings = lines.filter((l) => /^#{1,6}\s/.test(l)).length
  if (headings > README_LIMITS.headings) {
    findings.push({ rule: 'readme-headings', file: 'README.md', line: 1, detail: `${headings} 个标题（上限 ${README_LIMITS.headings}）` })
  }
  const tableRows = lines.filter((l) => /^\|/.test(l) && !/^\|[\s:|-]+\|$/.test(l)).length
  if (tableRows > README_LIMITS.tableRows) {
    findings.push({ rule: 'readme-table-rows', file: 'README.md', line: 1, detail: `${tableRows} 行表格（上限 ${README_LIMITS.tableRows}）` })
  }
  lines.forEach((line, i) => {
    // 抹掉 URL / 链接目标 / 行内代码 / ISO 日期：版本号、badge、状态头日期都不算"正文数字"。
    const prose = line
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\]\([^)]*\)/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    const m = prose.match(/(?<!\d)\d{3,}(?!\d)/)
    if (m) {
      findings.push({ rule: 'readme-big-number', file: 'README.md', line: i + 1, detail: `正文三位数 ${m[0]}（只允许版本号）` })
    }
  })
  return findings
}
