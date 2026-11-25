import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 3.5.3：legacy:audit 是「旧写法」的唯一判据，它自己必须先被证明会红。
// 活仓库零残留不等于检查有效——这是本仓反复吃亏的那一条（docs-lint.test.mjs 同款理由）。
const { scanRetired, scanAnchors, matchesAllow } = await import('../tools/lib/legacy-core.mjs')

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'fg-legacy-'))
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const ENTRY = {
  id: 'old-name',
  from: '3.5.3',
  why: '测试用',
  patterns: ['oldThing'],
  allow: ['CHANGELOG.md'],
}

test('退役名：该报的必须报；台账自豁免；allow 与 legacy:ok 就地豁免', () => {
  const { root, cleanup } = fixture({
    'packages/core/docs/RETIRED.json': '{"entries":[]}',
    'src/a.mjs': 'const x = oldThing()\n',
    'src/b.mjs': 'const y = oldThing() // legacy:ok 就地豁免\n',
    'CHANGELOG.md': '旧名 oldThing 改成了 newThing\n',
  })
  try {
    const files = ['packages/core/docs/RETIRED.json', 'src/a.mjs', 'src/b.mjs', 'CHANGELOG.md']
    const found = scanRetired(root, files, [ENTRY])
    const where = found.map((f) => `${f.file}:${f.line}`)
    assert.deepEqual(where, ['src/a.mjs:1'], '只应报 src/a.mjs:1')
  } finally {
    cleanup()
  }
})

test('行号锚点：越界必报，未越界不报，missing-file 单列', () => {
  const { root, cleanup } = fixture({
    'src/short.mjs': 'a\nb\nc\n',
    'docs/x.md': ['`short.mjs:2` 有效', '`short.mjs:99` 越界', '`gone.mjs:5` 找不到', '`short.mjs:99` 讲历史 legacy:ok'].join('\n'),
  })
  try {
    const files = ['src/short.mjs', 'docs/x.md']
    const found = scanAnchors(root, files)
    assert.deepEqual(
      found.map((f) => `${f.kind}:${f.anchor}`),
      ['line-overflow:short.mjs:99', 'missing-file:gone.mjs:5'],
    )
  } finally {
    cleanup()
  }
})

test('allow 模式：精确、目录前缀、通配后缀', () => {
  assert.ok(matchesAllow('docs/archive/a.md', 'docs/archive/*'))
  assert.ok(matchesAllow('CHANGELOG.md', 'CHANGELOG.md'))
  assert.ok(!matchesAllow('docs/CHANGELOG.md', 'CHANGELOG.md'), '精确模式不得命中同名的其它路径')
  assert.ok(matchesAllow('a/b/c.md', '*.md'))
})
