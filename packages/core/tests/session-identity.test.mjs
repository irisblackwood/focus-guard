import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// 3.5.3：会话标识只能有一处实现。
//
// 为什么值得一条判据：`|| 'dsh-native'` 在 7 个模块里各写过一遍，其中 `eligibility-gate`、
// `authz`、`pipeline`、`tools` 那四份**漏了 `agent.session.header.id`**——于是所有会话退化成
// 同一个桶（真实 AUDIT.log 里 439 条记在哨兵名下），红线豁免凭据在会话之间共用。
// 同一段逻辑写五遍，漏的那几遍会安静地错很久。判据盯的就是「别再写第六遍」。
const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

/** 去掉注释但保留字符串——注释里引用这个字面量是说明，不是实现。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name)
    if (e.isDirectory()) walk(f, out)
    else if (f.endsWith('.mjs')) out.push(f)
  }
  return out
}

test('会话哨兵只在定义处与一处取值点出现', () => {
  // 允许清单要写理由，不写就等于给未来的重复预留藏身处。
  const ALLOWED = new Map([
    ['adapters/dsh/session.mjs', '定义处：哨兵值本身'],
    ['memory/workspace.mjs', '取值点：读宿主缝写的 state 文件，键必须与写方一致'],
  ])
  const hits = []
  for (const abs of walk(SRC)) {
    const rel = relative(SRC, abs).split('\\').join('/')
    const code = stripComments(readFileSync(abs, 'utf8'))
    if (/'dsh-native'|"dsh-native"/.test(code)) hits.push(rel)
  }
  assert.deepEqual(hits.sort(), [...ALLOWED.keys()].sort(), `哨兵值出现在：${hits.join(', ')}`)
})

test('解析链只有一处：src 内不得再手拼 header.id 链', () => {
  // 这个形状是「漏读 header.id」那一族 bug 的指纹——只要有人重新手写一遍，就会再漏一次。
  const BAD = /sessionId\s*\|\|\s*\(?\s*(?:\w+\.)?(?:agent\.)?(?:agent\.)?id\b/
  const offenders = []
  for (const abs of walk(SRC)) {
    const rel = relative(SRC, abs).split('\\').join('/')
    if (rel === 'core/session.mjs') continue
    const code = stripComments(readFileSync(abs, 'utf8'))
    if (BAD.test(code)) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], `手拼会话链：${offenders.join(', ')}`)
})
