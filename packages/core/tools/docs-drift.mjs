#!/usr/bin/env node
/**
 * docs:drift（2026-11-22）
 *
 * 文档漂移扫描器：把「文档里写死的事实」拿代码对一遍，出清单而不是靠人眼。
 * 三类判据（都只认可机器验证的）：
 *   1. `npm run <script>`：package.json 的 scripts 里必须存在；
 *   2. 反引号里的仓库相对路径：文件/目录必须存在（占位符与通配符跳过）；
 *   3. `FG_*` 环境变量：`packages/core/src` 里必须出现过。
 *
 * 不判：示例里的外部 URL、<占位符>、执行结果、版本号（版本面已由 docs:lint / version.mjs 管）。
 *
 * 用法：
 *   node packages/core/tools/docs-drift.mjs            # 人读清单
 *   node packages/core/tools/docs-drift.mjs --json     # 机器读
 *   node packages/core/tools/docs-drift.mjs --strict   # 有漂移则退出码 1（默认 0，只报告）
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const strict = args.includes('--strict')

/** 扫描范围：docs 树 + 入口文档；归档与 vault 笔记不扫（历史材料，改了也不该被当前事实约束）。 */
function walkDocs(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'archive' || e.name === 'vault-notes' || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walkDocs(p, out)
    else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}

const FILES = [
  ...walkDocs(join(ROOT, 'docs')),
  ...walkDocs(join(ROOT, 'packages/core/docs')),
  join(ROOT, 'README.md'),
  join(ROOT, 'INSTALL.md'),
  join(ROOT, 'packages/core/README.md'),
  join(ROOT, 'packages/core/README.zh-CN.md'),
].filter((f) => existsSync(f) && !/HANDOFF-/.test(f))

const scripts = Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts || {})

/** FG_* 变量名集合：从 src 全量收集（只读，不猜）。 */
function collectEnvNames() {
  const names = new Set()
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(mjs|js)$/.test(e.name)) {
        const text = readFileSync(p, 'utf8')
        for (const m of text.matchAll(/\bFG_[A-Z0-9_]+\b/g)) names.add(m[0])
      }
    }
  }
  walk(join(ROOT, 'packages/core'))
  return names
}
const ENV_NAMES = collectEnvNames()

const SKIP_PATH = /\s|<|>|\*|\?|\{|\}|\.\.\.|…|^https?:|^file:|^[A-Za-z]:|^~|^\$|^%|^you$|^\.\.$/

/** 运行期产物目录：文档里写它们只在说「会生成到哪」，不该被要求当前就存在。 */
const RUNTIME_PREFIX = /^(?:\.focus-guard|\.ai|\.stryker-tmp|reports|\.dsh|library|notes|output|archive)\//

/** 只认本仓自己的目录前缀；`memory-core/`、`plugins/` 这类是外部项目引用，不归本仓查。 */
const REPO_PREFIX = /^(?:packages|docs|\.ai|\.githooks|\.github|\.claude-plugin|\.zcode-plugin|src|tests|tools|hooks|skills|presets|assets|scripts)\//
const PATHISH = /^(?:packages|docs|\.ai|\.githooks|\.github|\.claude-plugin|\.zcode-plugin)\//
const EXT = /\.(?:md|mjs|js|json|yml|yaml|html|css|txt|sh|ps1|bat)$/

const rows = []
function report(file, line, rule, snippet, detail) {
  rows.push({ file: relative(ROOT, file).replace(/\\/g, '/'), line, rule, snippet, detail })
}

function checkScript(file, line, name) {
  const head = name.split(/\s+/)[0]
  if (!head || head.startsWith('-')) return
  if (scripts.includes(head)) return
  report(file, line, 'npm-script', `npm run ${head}`, `package.json scripts 里没有 ${head}`)
}

function checkPath(file, line, token, lineText = '') {
  const t = token.trim()
  if (!t || SKIP_PATH.test(t)) return
  const bare = t.replace(/[.,;:）)】]+$/, '').replace(/^['"]|['"]$/g, '')
  if (!REPO_PREFIX.test(bare) && !PATHISH.test(bare)) return
  if (RUNTIME_PREFIX.test(bare)) return
  if (!EXT.test(bare) && !bare.endsWith('/')) return
  if (bare.includes('*')) return
  // 文档里的路径有三种写法，逐一试：仓库根相对、文档同目录相对、包内相对（packages/core/…）。
  const candidates = [
    join(ROOT, bare),
    resolve(dirname(file), bare),
    resolve(dirname(file), '..', bare),
    join(ROOT, 'packages/core', bare),
    join(ROOT, 'packages/core/src', bare),
    join(ROOT, 'packages/core/src/dsh', bare),
  ]
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c)) return
    } catch {
      /* keep trying */
    }
  }
  // 计划/设计类段落里的路径是「将来要建」，不是当前事实；只报告已建成文档里的死路径。
  if (/计划|待做|未做|目标|将|拟|设计/.test(lineText)) return
  report(file, line, 'repo-path', bare, '文件或目录不存在')
}

function checkEnv(file, line, name) {
  if (ENV_NAMES.has(name)) return
  report(file, line, 'fg-env', name, 'packages/core/src 里没有这个环境变量')
}

for (const file of FILES) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((text, i) => {
    const line = i + 1
    for (const m of text.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) checkScript(file, line, m[1])
    for (const m of text.matchAll(/\bFG_[A-Z0-9_]+\b/g)) checkEnv(file, line, m[0])
    // 只查反引号包裹的路径；代码块里没有反引号，靠行内格式，避免把命令参数当路径。
    for (const m of text.matchAll(/`([^`\n]+)`/g)) checkPath(file, line, m[1], text)
  })
}

rows.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))

if (asJson) {
  console.log(JSON.stringify({ scanned: FILES.length, issues: rows.length, rows }, null, 2))
} else {
  console.log(`[docs:drift] 扫描 ${FILES.length} 份文档 → 漂移 ${rows.length} 条`)
  let last = ''
  for (const r of rows) {
    if (r.file !== last) {
      console.log(`\n${r.file}`)
      last = r.file
    }
    console.log(`  :${r.line} [${r.rule}] ${r.snippet} — ${r.detail}`)
  }
  if (!rows.length) console.log('  无漂移。')
}
process.exit(strict && rows.length ? 1 : 0)
