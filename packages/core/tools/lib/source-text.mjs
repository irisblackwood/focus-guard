/**
 * 源码文本预处理（tools/lib/source-text.mjs，2026-10-27）——工具链共用件，零依赖。
 *
 * 为什么单独抽出来：`lint.mjs` 与 `smells.mjs` 都要"把字面量与注释抹掉，只留代码"。
 * 第一版各写一份，结果 `smells.mjs` 那份**忘了处理正则字面量**——`/['"]/` 里的引号被当成
 * 字符串开头，一直吞到下一个引号，把中间的 `export function preExecuteListener` 整段抹平，
 * 于是那个 398 行的函数没被量出来（量成了"不存在"）。
 * **同一段逻辑写两遍，就一定会分叉。** 现统一到此。
 *
 * 处理对象：行注释、块注释、单/双引号字符串、模板字符串、正则字面量。
 * 一律替换成**等长空格**（换行保留），因此行号、列号与原文件一致，可直接用于报告。
 */

/**
 * 判断某个 `/` 是正则起点还是除号。
 * 启发式：前一个非空白字符是 `=` `(` `,` `:` `!` `&` `|` `?` `{` `}` `;` `[` `+` `-` 或行首 → 正则。
 * 这是各家 linter 通用的做法，不完美（`a = b / c` 里 `b` 后是 `/`，前面是标识符 → 判除号，正确）。
 */
function isRegexStart(src, i) {
  let k = i - 1
  while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) k -= 1
  if (k < 0) return true
  return '=(,:!&|?{};[+-\n'.includes(src[k])
}

/**
 * 抹掉字面量与注释，返回等长文本。
 * @param {string} src
 * @returns {string} 同长度、同换行位置的"只剩代码"文本
 */
function blankSpan(out, from, to) {
  for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '
}

/** 引号/模板字符串的结束下标（不含）；未闭合的单行字符串停在换行处，不吞后面代码。 */
function scanQuoted(src, start, n, quote) {
  let j = start + 1
  while (j < n) {
    if (src[j] === '\\') {
      j += 2
      continue
    }
    if (src[j] === quote) return j + 1
    if (src[j] === '\n' && quote !== '`') return j
    j += 1
  }
  return j
}

/** 正则字面量的结束下标（不含）；未闭合返回 -1（按除号处理，不吞半行）。 */
function scanRegex(src, start, n) {
  let j = start + 1
  let inClass = false
  while (j < n) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) return j + 1
    else if (c === '\n') return -1
    j += 1
  }
  return -1
}

export function stripLiterals(src) {
  const out = src.split('')
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]

    if (c === '/' && next === '/') {
      const j = src.indexOf('\n', i)
      const end = j < 0 ? n : j
      blankSpan(out, i, end)
      i = end
      continue
    }

    if (c === '/' && next === '*') {
      const j = src.indexOf('*/', i + 2)
      const end = j < 0 ? n : j + 2
      blankSpan(out, i, end)
      i = end
      continue
    }

    if (c === '"' || c === "'" || c === '`') {
      const end = scanQuoted(src, i, n, c)
      blankSpan(out, i, end)
      i = end
      continue
    }

    if (c === '/' && next !== '/' && next !== '*' && isRegexStart(src, i)) {
      const end = scanRegex(src, i, n)
      if (end > 0) {
        blankSpan(out, i, end)
        i = end
        continue
      }
    }

    i += 1
  }
  return out.join('')
}
