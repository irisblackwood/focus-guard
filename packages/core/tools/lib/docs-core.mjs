/**
 * 文档口径内核（3.3 D5）：版本面 + 相对链接可达性。纯函数，零依赖。
 *
 * 只做两件事，因为这两件能机械判定：
 *  1) **版本面**：七处清单 + `ENGINE_VERSION` 必须等于 CHANGELOG 最新版本段；
 *  2) **相对链接**：仓库内 `.md` 的 `[text](path)` 目标文件必须存在（http/mailto/锚点跳过）。
 *
 * 不做的（各自有理由）：README 硬指标属于 3.4 D1 的验收、数字单点属于 D4、状态头属于 D2。
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

const SKIP_SEGMENTS = new Set(['node_modules', '.git', '.focus-guard', '.ai', 'self-improvement', 'archived', 'backup'])

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

/** 相对链接目标存在性（跳过 http(s)/mailto/锚点/空链接）。 */
export function checkRelativeLinks(root, files = listMarkdownFiles(root)) {
  const findings = []
  const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, '/')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      for (const m of line.matchAll(LINK)) {
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
