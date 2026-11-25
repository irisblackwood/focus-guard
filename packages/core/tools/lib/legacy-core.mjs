/**
 * 旧写法扫描的判定核心（3.5.3）。零依赖纯函数，供 CLI 与测试共用。
 *
 * 两类判据，都在回答同一个问题：**这段文字描述的对象还在不在？**
 *
 *   1. `retired-name`：退役台账里记过的旧名字，除 allow 之外不得再出现。
 *      名字不是「猜得到」的——只有台账知道它曾经叫什么，所以必须有一份台账。
 *   2. `stale-anchor`：文档里的 `file.mjs:123` 锚点，文件必须还在、行号不得越界。
 *      行号越界是**可证明的失效**（文件没有那么长），不算推断。
 *
 * 不判：
 *   - `missing-file` 一律只报不拦。它可能是外部包路径（`dsh-tools/lib/index.js`）、
 *     可能是删掉的文件——两者机器分不清，靠人判。判不了的不要假装判得了。
 *   - 历史材料（CHANGELOG / archive / 台账）不改写：改历史等于篡改流水账。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** 扫描面：这些目录外的文件不参与（生成物、临时件、外部依赖）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.focus-guard',
  '.ai',
  '.archify',
  'archive',
  'vault-notes',
  'coverage',
  'dist',
])

const TEXT_EXT = /\.(mjs|js|cjs|json|md|yml|yaml)$/
/** 台账自身：它必须写下旧名，否则它记不住任何东西。 */
const LEDGER_REL = 'packages/core/docs/RETIRED.json'
/** 单文件上限：超过这个体积的多半是生成物（docs/book.html、brain-data.json）。 */
const MAX_BYTES = 2 * 1024 * 1024

export function walkScope(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(full)
        continue
      }
      if (!TEXT_EXT.test(e.name)) continue
      if (e.name.startsWith('.tmp')) continue
      try {
        if (statSync(full).size > MAX_BYTES) continue
      } catch {
        continue
      }
      out.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  return out
}

/** `*` 通配、目录前缀（`a/b` 命中 `a/b/c`）、后缀（`*.md` 命中任意层级）。 */
export function matchesAllow(relPath, pattern) {
  if (pattern === relPath) return true
  if (pattern.endsWith('/')) return relPath.startsWith(pattern)
  if (pattern.endsWith('/*')) return relPath.startsWith(pattern.slice(0, -1))
  if (pattern.startsWith('*.')) return relPath.endsWith(pattern.slice(1))
  if (pattern.includes('*')) {
    const [head, tail] = pattern.split('*')
    return relPath.startsWith(head) && relPath.endsWith(tail)
  }
  return false
}

export function loadLedger(root) {
  const p = join(root, LEDGER_REL)
  const raw = JSON.parse(readFileSync(p, 'utf8'))
  return {
    entries: Array.isArray(raw.entries) ? raw.entries : [],
    anchorAllow: Array.isArray(raw.anchorAllow) ? raw.anchorAllow : [],
  }
}

/**
 * 退役名残留。
 * @returns {{ id, pattern, file, line, text }[]}
 */
export function scanRetired(root, files, entries) {
  const findings = []
  for (const entry of entries) {
    const allow = entry.allow || []
    for (const file of files) {
      // 台账必须写下旧名，否则它记不住任何东西——自豁免是它的定义，不是宽容。
      if (file === LEDGER_REL) continue
      if (allow.some((a) => matchesAllow(file, a))) continue
      let text
      try {
        text = readFileSync(join(root, file), 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(SUPPRESS)) continue
        for (const pattern of entry.patterns || []) {
          if (!lines[i].includes(pattern)) continue
          findings.push({
            id: entry.id,
            pattern,
            file,
            line: i + 1,
            text: lines[i].trim().slice(0, 120),
          })
        }
      }
    }
  }
  return findings
}

const ANCHOR_RE = /[\w./-]+\.(?:mjs|js|cjs|json|md):(\d+)/g
/** 就地豁免：行内含此标记即跳过。写「这里以前是行号」的段落必须自证，否则它自己就成了旧写法。 */
const SUPPRESS = 'legacy:ok'

/**
 * 文档锚点失效。
 * @returns {{ kind: 'line-overflow'|'missing-file', file, anchor, detail }[]}
 */
export function scanAnchors(root, files, anchorAllow = []) {
  const findings = []
  const codeFiles = files.filter((f) => /\.(mjs|js|cjs|json|md)$/.test(f))
  const lineCount = new Map()
  const linesOf = (f) => {
    if (!lineCount.has(f)) {
      try {
        lineCount.set(f, readFileSync(join(root, f), 'utf8').split('\n').length)
      } catch {
        lineCount.set(f, 0)
      }
    }
    return lineCount.get(f)
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue
    if (anchorAllow.some((a) => matchesAllow(file, typeof a === 'string' ? a : a.path))) continue
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(SUPPRESS)) continue
      for (const m of lines[i].matchAll(ANCHOR_RE)) {
        const anchor = m[0]
        const target = anchor.slice(0, anchor.lastIndexOf(':'))
        const line = Number(anchor.slice(anchor.lastIndexOf(':') + 1))
        const cands = codeFiles.filter((f) => f === target || f.endsWith('/' + target))
        if (!cands.length) {
          findings.push({ kind: 'missing-file', file, anchor, detail: '仓内无此文件（可能是外部包路径）' })
          continue
        }
        const max = Math.max(...cands.map(linesOf))
        if (line > max) {
          findings.push({
            kind: 'line-overflow',
            file,
            anchor,
            detail: `${cands[0]} 只有 ${max} 行`,
          })
        }
      }
    }
  }
  return findings
}
