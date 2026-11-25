/**
 * 退役惯用法规则表（3.5.3）。零依赖纯函数。
 *
 * 收什么、不收什么，判据只有一条：**新写法必须可证明更优**，不是"更时髦"。
 *
 *   收：API 已被标准移除（substr / new Buffer / url.parse）
 *   收：新写法在复杂度或正确性上严格更好（filter()[0] → find()、split('').reverse() → [...s]）
 *   收：少一次分配或多一次拷贝，可指出具体省掉了什么（+new Date() → Date.now()）
 *   不收：纯风格（for 下标 → for...of、var → let 已由房规管、括号位置、引号）
 *
 * 为什么不引 eslint-plugin-unicorn：
 *   它是这条路的标准答案（约 100 条规则），但本仓刻意零 npm 依赖，且 `tools/lint.mjs`
 *   的头部记着当初为什么自己写——ESLint 的评分模型把本仓房规（curly 589 条）算成缺陷，
 *   "一个把房规算成缺陷的尺子，量出来的是尺子自己"。为一个规则表把 ESLint 请回来，
 *   等于把已经踩过的坑重挖一遍。规则表照抄思路，不抄依赖。
 *
 * 与 `legacy-audit` 的分工：
 *   - 本文件管**惯用法**（写法本身过时，替换关系是通用知识，不需要台账）
 *   - `legacy-audit` 管**名字与位置**（旧名、旧路径、旧锚点，替换关系只有台账知道）
 */

/**
 * 从 `(` 开始找配对的 `)`，返回其后一位的下标。找不到返回 -1。
 * filter()[0] 这类规则必须靠它——正则数不清嵌套括号，`l.trim().length` 会被误当成
 * `.filter(...).length`，本仓 2026-11-25 首次试跑就这么误报过一条。
 */
export function callSpan(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** 规则表：`re` 在去字面量后的代码上跑；`better` 是替换式；`why` 说清省了什么。 */
export const IDIOMS = [
  {
    id: 'legacy-substr',
    re: /\.substr\(/g,
    better: '.slice()',
    why: 'substr 已从 ECMA-262 移除（仅 Annex B 保留），slice 是标准写法',
  },
  {
    id: 'legacy-deep-clone',
    re: /JSON\.parse\(\s*JSON\.stringify\(/g,
    better: 'structuredClone()',
    why: '原生深拷贝：不经过字符串，保留 Date/Map/Set/RegExp，大对象快一个量级',
  },
  {
    id: 'legacy-buffer-ctor',
    re: /new Buffer\(/g,
    better: 'Buffer.from()',
    why: 'new Buffer 自 Node 6 废弃、8 起运行时告警，且有未初始化内存风险',
  },
  {
    id: 'legacy-url-parse',
    re: /(?<![\w.$])url\.parse\(/g,
    better: 'new URL()',
    why: 'url.parse 自 Node 11 标记 legacy，WHATWG URL 是标准且解析更快',
  },
  {
    id: 'legacy-split-reverse',
    re: /\.split\(\s*(['"])\1\s*\)\s*\.reverse\(/g,
    better: '[...s].reverse()',
    why: 'split("") 按 UTF-16 码元切分，会切断 emoji 与 CJK 扩展区字符——这是正确性 bug，不只是风格',
    // 引号会被 stripLiterals 抹成空格，只能在原文上跑；命中后再确认这段不是注释（见 scanIdioms）。
    raw: true,
  },
  {
    id: 'readfile-tostring',
    re: /readFileSync\([^)\n]{0,200}\)\.toString\(\)/g,
    better: "readFileSync(p, 'utf8')",
    why: '少一次 Buffer → String 的全量拷贝',
  },
  {
    id: 'plus-new-date',
    re: /\+new Date\(\)/g,
    better: 'Date.now()',
    why: '不构造 Date 对象，少一次分配',
  },
  {
    id: 'object-assign-copy',
    re: /Object\.assign\(\s*\{\s*\}\s*,/g,
    better: '{ ...o }',
    why: '展开运算符是语法层操作，不经过函数调用与属性描述符拷贝',
  },
  {
    id: 'indexof-exists',
    re: /\.indexOf\([^;\n]{0,120}?\)\s*(?:!==?|===?)\s*-1/g,
    better: '.includes()',
    why: 'includes 表达意图且对 NaN 正确（indexOf 找不到 NaN）',
  },
  {
    id: 'parseint-radix',
    re: /parseInt\(\s*[^,()\n]{1,80}\s*\)/g,
    better: 'parseInt(x, 10)',
    why: '无基数时前导 0 在老引擎按八进制解析；显式 10 是唯一可移植写法',
  },
]

/** filter()[0] 与 filter().length：靠 callSpan 精确配对，不靠正则数括号。 */
const FILTER_RE = /\.filter\(/g

/**
 * 扫描一段代码。`plain` 是去字面量后的文本（注释与字符串被抹成空格，长度不变）；
 * `src` 只在带 `raw` 标记的规则里用到——那类规则必须看引号，而引号已被抹掉。
 * @returns {{ rule: string, line: number, detail: string }[]}
 */
export function scanIdioms(plain, src = plain) {
  const out = []
  const lineAt = (idx) => {
    let n = 1
    for (let i = 0; i < idx; i++) if (plain[i] === '\n') n++
    return n
  }

  for (const rule of IDIOMS) {
    const text = rule.raw ? src : plain
    rule.re.lastIndex = 0
    let m
    while ((m = rule.re.exec(text))) {
      // raw 规则跑在原文上，注释里的同形文字要剔掉：这一段在 plain 里应当全是空格。
      if (rule.raw && plain.slice(m.index, m.index + m[0].length).trim() === '') continue
      out.push({ rule: rule.id, line: lineAt(m.index), detail: `${m[0].trim().slice(0, 60)} → ${rule.better}` })
      if (m[0].length === 0) rule.re.lastIndex++
    }
  }

  FILTER_RE.lastIndex = 0
  let f
  while ((f = FILTER_RE.exec(plain))) {
    const open = f.index + '.filter'.length
    const end = callSpan(plain, open)
    if (end < 0) continue
    const rest = plain.slice(end, end + 40)
    if (/^\s*\[\s*0\s*\]/.test(rest)) {
      out.push({ rule: 'filter-first', line: lineAt(f.index), detail: '.filter(...)[0] → .find(...)' })
    } else if (/^\s*\.length\s*(?:>\s*0|!==?\s*0|===?\s*0|>=\s*1)/.test(rest)) {
      out.push({ rule: 'filter-length', line: lineAt(f.index), detail: '.filter(...).length → .some(...) / .every(...)' })
    }
  }

  return out.sort((a, b) => a.line - b.line)
}
