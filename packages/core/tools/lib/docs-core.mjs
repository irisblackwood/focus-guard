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
const SKIP_SEGMENTS = new Set(['node_modules', '.git', '.focus-guard', '.ai', 'self-improvement', 'archived', 'backup', 'HANDOFF.md'])

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
  const latest = changelogLatest(root)
  versions.push({ where: 'CHANGELOG.md 最新段', value: latest })

  const bad = versions.filter((v) => v.value !== latest)
  for (const v of bad) {
    findings.push({
      rule: 'version-mismatch',
      file: v.where,
      line: 1,
      detail: `${v.value} ≠ CHANGELOG 最新段 ${latest}`,
    })
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
