/**
 * 变异算子与生成/应用（2026-11-27，3.5.4 从 tools/mutate.mjs 抽出）。
 *
 * 抽出的理由：`tools/mutate.mjs` 到 484 行，撞上结构异味阈值 400。
 * 而这一段的边界是干净的——**纯函数，只依赖 `stripLiterals`**，不碰文件系统、不碰进程。
 * 编排（副本、跑测试、报分）留在 mutate.mjs，算子在这里。
 */
import { stripLiterals } from './source-text.mjs'

/**
 * 变异算子。每个算子：正则 + 替换规则。
 *
 * 全部作用在 `stripLiterals` 之后的文本上——否则 `'== 分布 =='` 这种字符串里的运算符
 * 会被当成代码变异，跑出来的"存活"全是假的。去字面量保留长度与换行，
 * 所以 `plain` 里的下标可以直接映射回原文件（下面有长度断言兜底）。
 */
const OPERATORS = [
  { id: 'comparison', re: /(?<![<>=!])(<=|>=|<|>)(?![=<>])/g, flip: { '<': '<=', '<=': '<', '>': '>=', '>=': '>' } },
  { id: 'equality', re: /(?<![=!<>])(===|!==)(?!=)/g, flip: { '===': '!==', '!==': '===' } },
  { id: 'boolean', re: /(?<![\w$.])(&&|\|\|)(?![\w$])/g, flip: { '&&': '||', '||': '&&' } },
  { id: 'literal-bool', re: /(?<![\w$.])(true|false)(?![\w$])/g, flip: { true: 'false', false: 'true' } },
  { id: 'nullish', re: /(?<![\w$.])\?\?(?![\w$])/g, flip: { '??': '||' } },
  // 去掉一个 `!`：`if (!reason)` → `if (reason)`。闸门类代码里这条最能暴露"没人断言"。
  // 捕获组不能省：`m[1]` 取的是 token，没有捕获组时是 undefined，整条算子会**静默失效**
  // （这个 bug 是 `mutate.test.mjs` 抓出来的——自己写的算子也会犯"看起来跑了"的错）。
  { id: 'negation', re: /(?<![!=<>])(!)(?!=)/g, flip: { '!': '' } },
]

/** 生成变异体：{ op, index, token, replacement, line } */
export function generateMutants(src) {
  const plain = stripLiterals(src)
  if (plain.length !== src.length) {
    throw new Error(`stripLiterals 改变了长度（${src.length} → ${plain.length}），下标无法映射，拒绝变异`)
  }
  const lineStarts = [0]
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') lineStarts.push(i + 1)
  const lineOf = (idx) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= idx) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  const out = []
  for (const op of OPERATORS) {
    for (const m of plain.matchAll(op.re)) {
      const token = m[1]
      const replacement = op.flip[token]
      if (replacement === undefined) continue
      out.push({ op: op.id, index: m.index, token, replacement, line: lineOf(m.index) })
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

/** 把第 i 个变异体应用到源码上，返回新源码。 */
export function applyMutant(src, mutant) {
  return src.slice(0, mutant.index) + mutant.replacement + src.slice(mutant.index + mutant.token.length)
}
