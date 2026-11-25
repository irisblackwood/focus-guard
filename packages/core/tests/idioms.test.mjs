import { test } from 'node:test'
import assert from 'node:assert/strict'

// 3.5.3：退役惯用法规则表。零命中不等于规则有效——每条都必须有能红的样本。
// 本仓 2026-11-25 首次试跑就出过一次误报：`l.trim().length > 0` 在 filter 回调**内部**，
// 正则数不清嵌套括号，把它当成了 `.filter(...).length`。故 filter 两规则必须用 callSpan。
const { scanIdioms, callSpan, IDIOMS } = await import('../tools/lib/idioms.mjs')

const ruleIds = (code, src = code) => scanIdioms(code, src).map((h) => h.rule)

test('每条规则都能命中自己的样本', () => {
  const samples = {
    'legacy-substr': 'const a = s.substr(1, 2)',
    'legacy-deep-clone': 'const c = JSON.parse(JSON.stringify(o))',
    'legacy-buffer-ctor': 'const b = new Buffer(10)',
    'legacy-url-parse': 'const u = url.parse(req.url)',
    'legacy-split-reverse': "const r = s.split('').reverse().join('')",
    'readfile-tostring': "const t = readFileSync(p).toString()",
    'plus-new-date': 'const t = +new Date()',
    'object-assign-copy': 'const c = Object.assign({}, o)',
    'indexof-exists': 'if (a.indexOf(x) !== -1) {}',
    'parseint-radix': 'const n = parseInt(s)',
    'filter-first': 'const a = list.filter((x) => x.ok)[0]',
    'filter-length': 'if (list.filter((x) => x.ok).length > 0) {}',
  }
  for (const rule of IDIOMS.map((r) => r.id).concat(['filter-first', 'filter-length'])) {
    assert.ok(samples[rule], `样本表缺 ${rule}`)
    assert.ok(ruleIds(samples[rule]).includes(rule), `${rule} 未命中：${samples[rule]}`)
  }
})

test('不误报：length 在回调内部、已有基数、已用新写法', () => {
  assert.deepEqual(ruleIds('const body = txt.split("\\n").filter((l) => l.trim().length > 0)'), [])
  assert.deepEqual(ruleIds('const n = parseInt(v.id.slice(1), 10)'), [])
  assert.deepEqual(ruleIds('const a = list.find((x) => x.ok)'), [])
  assert.deepEqual(ruleIds('const c = { ...o }'), [])
})

test('注释与字符串里的同形文字不算代码', () => {
  // plain 由 stripLiterals 生成：注释与字符串被抹成空格，长度不变。
  const src = '// 别写 s.substr(1)\nconst t = "a.substr(b)"\nconst ok = 1'
  const plain = src.replace('// 别写 s.substr(1)', ' '.repeat('// 别写 s.substr(1)'.length)).replace('"a.substr(b)"', ' '.repeat('"a.substr(b)"'.length))
  assert.deepEqual(ruleIds(plain, src), [])
})

test('callSpan 配对嵌套括号', () => {
  const s = 'filter(a(b), c)X'
  assert.equal(s.slice(6, callSpan(s, 6)), '(a(b), c)')
  assert.equal(callSpan('filter(a', 6), -1)
})
