import { test } from 'node:test'
import assert from 'node:assert/strict'

// MCP 动词兜底补口（2026-10-29）
// 病根：原正则要求动词后紧跟下划线（`__write_`），于是「工具名 + 动词结尾」的命名
// （`mcp__hindsight__hindsight_write`）全部落成 other —— 真正写库的工具绕过取证闸。
// 本组锁三件事：结尾动词能认出、词内动词不误认、未登记的能被自检报出来。

await import('../src/adapters/dsh/tool-kinds.mjs')
const { isMutating, isInvestigation, toolKindOf } = await import('../src/core/risk.mjs')
const { auditToolKinds, renderToolKindNotice, toolNameOf } = await import('../src/dsh/toolKindAudit.mjs')

test('兜底：动词以字符串结尾也算改动类（原漏判）', () => {
  const names = [
    'mcp__hindsight__hindsight_write',
    'mcp__memory__memory_save',
    'mcp__graphmemory__graph_delete',
    'mcp__fortress__snapshot_create',
    'mcp__db__row_update',
  ]
  for (const n of names) {
    assert.equal(toolKindOf(n), 'mutation', `${n} 应判为 mutation`)
    assert.equal(isMutating(n, {}, false), true, `${n} isMutating 应为 true`)
  }
})

test('兜底不回归：动词后接下划线的仍判改动类', () => {
  for (const n of [
    'mcp__cities2-mcp__write_project_file',
    'mcp__cities2-mcp__build_project',
    'mcp__x__delete_record_by_id',
  ]) {
    assert.equal(toolKindOf(n), 'mutation', `${n} 应判为 mutation`)
  }
})

test('词内动词不误判：overwrite / rewrite 不是 write 动词', () => {
  for (const n of ['mcp__x__overwrite', 'mcp__x__rewrite', 'mcp__x__typewriter']) {
    assert.notEqual(toolKindOf(n), 'mutation', `${n} 不该判成 mutation`)
  }
})

test('只读兜底保持：名字带 search 的 MCP 工具算 read，不算改动', () => {
  assert.equal(toolKindOf('mcp__graphmemory__gm_search'), 'read')
  assert.equal(toolKindOf('mcp__x__web_fetch'), 'read')
  assert.equal(isMutating('mcp__graphmemory__gm_search', {}, false), false)
})

test('mutation 优先于 read：写了又带 search 的名字仍算写', () => {
  assert.equal(toolKindOf('mcp__x__write_search_index'), 'mutation')
  assert.equal(toolKindOf('mcp__x__delete_search_cache'), 'mutation')
})

test('other 的语义：既不判改动也不判侦查（熔断期落 deny、且算执行池）', () => {
  const n = 'mcp__memory_fortress__recall'
  assert.equal(toolKindOf(n), 'other')
  assert.equal(isMutating(n, {}, false), false)
  assert.equal(isInvestigation(n, {}), false)
})

test('自检：未登记的 MCP 工具被报出，已登记的不报', () => {
  const schemas = [
    { name: 'mcp__graphmemory__gm_record' },
    { name: 'mcp__memory_fortress__recall' },
    { name: 'mcp__graphmemory__gm_search' }, // read 兜底 → 已归类
    { name: 'write' }, // 已登记
    { name: 'grep' }, // 已登记
  ]
  const r = auditToolKinds({ schemas })
  assert.deepEqual(r.unknown, ['mcp__graphmemory__gm_record', 'mcp__memory_fortress__recall'])
  assert.equal(r.registered, 1, '只有 gm_search 命中 mcp 前缀且已归类')
})

test('自检：默认只看 mcp__ 前缀，内置工具不进来', () => {
  const schemas = [{ name: 'todo_write' }, { name: 'skill' }, { name: 'mcp__x__recall' }]
  assert.deepEqual(auditToolKinds({ schemas }).unknown, ['mcp__x__recall'])
  // prefix 传空串 = 全表扫（留给调试/测试用）
  const all = auditToolKinds({ schemas, prefix: '' })
  assert.deepEqual(all.unknown, ['mcp__x__recall', 'skill', 'todo_write'])
})

test('自检：allow 清单豁免（大小写不敏感）', () => {
  const schemas = [{ name: 'mcp__x__recall' }]
  assert.deepEqual(auditToolKinds({ schemas, allow: ['MCP__X__RECALL'] }).unknown, [])
})

test('自检：工具名两种形状都取得到（name / function.name）', () => {
  assert.equal(toolNameOf({ name: 'mcp__a__b' }), 'mcp__a__b')
  assert.equal(toolNameOf({ function: { name: 'mcp__c__d' } }), 'mcp__c__d')
  assert.equal(toolNameOf({}), '')
  assert.equal(toolNameOf(null), '')
})

test('自检：脏输入不抛（null / 非数组 / 缺名字的元素）', () => {
  assert.deepEqual(auditToolKinds({ schemas: null }).unknown, [])
  assert.deepEqual(auditToolKinds({ schemas: [null, 1, 'x', {}] }).unknown, [])
  assert.deepEqual(auditToolKinds().unknown, [])
})

test('自检：报告文案——有未登记才出声，且点出两个后果', () => {
  assert.equal(renderToolKindNotice({ unknown: [], scanned: 3 }), '', '干净时不出声')
  const text = renderToolKindNotice({ unknown: ['mcp__x__recall'], scanned: 4 })
  assert.match(text, /1\/4/)
  assert.match(text, /mcp__x__recall/)
  assert.match(text, /熔断期/)
  assert.match(text, /执行池/)
  assert.match(text, /tool-kinds\.mjs/)
})

test('自检：超过 6 个只列前 6 个 + 总数', () => {
  const unknown = Array.from({ length: 9 }, (_, i) => `mcp__x__t${i}`)
  const text = renderToolKindNotice({ unknown, scanned: 9 })
  assert.match(text, /9\/9/)
  assert.match(text, /等 9 个/)
  assert.doesNotMatch(text, /mcp__x__t8/, '第 9 个不该出现在列表里')
})

// ===== 存量登记（2026-10-29）：cities2-mcp 的只读工具曾全落成 other =====
// 病根与上面的正则无关：`get_*` / `list_*` / `query_*` / `analyze_*` 不在任何兜底表里。
// 后果是熔断期被当改动类拒掉、调用算执行池——自检上线第一天就会报这 7 条。

const CITIES2_READ = [
  'mcp__cities2-mcp__analyze_project',
  'mcp__cities2-mcp__get_encyclopedia_entry',
  'mcp__cities2-mcp__get_page',
  'mcp__cities2-mcp__get_snippets',
  'mcp__cities2-mcp__list_project_tree',
  'mcp__cities2-mcp__query_reference',
  'mcp__cities2-mcp__source_status',
]

test('存量登记：cities2-mcp 的只读工具判 read，不再落成 other', () => {
  for (const n of CITIES2_READ) {
    assert.equal(toolKindOf(n), 'read', `${n} 应登记为 read`)
    assert.equal(isMutating(n, {}, false), false, `${n} 不该判改动类`)
    assert.equal(isInvestigation(n, {}), true, `${n} 应算侦查（熔断期放行、进侦查池）`)
  }
})

test('存量登记后：当前 13 个 MCP 工具自检零未登记（上线不吵）', () => {
  const schemas = [
    'analyze_project',
    'build_project',
    'get_encyclopedia_entry',
    'get_page',
    'get_snippets',
    'list_project_tree',
    'package_project',
    'query_reference',
    'scaffold_project',
    'search',
    'search_encyclopedia',
    'source_status',
    'write_project_file',
  ].map((s) => ({ name: `mcp__cities2-mcp__${s}` }))
  const r = auditToolKinds({ schemas })
  assert.deepEqual(r.unknown, [], `仍有未登记：${r.unknown.join('、')}`)
  assert.equal(r.registered, 13)
  assert.equal(renderToolKindNotice(r), '', '干净时不该出声')
})

test('存量登记不影响写盘判定：同服务器的写/构建工具仍是 mutation', () => {
  for (const n of [
    'mcp__cities2-mcp__write_project_file',
    'mcp__cities2-mcp__build_project',
    'mcp__cities2-mcp__package_project',
    'mcp__cities2-mcp__scaffold_project',
  ]) {
    assert.equal(toolKindOf(n), 'mutation', `${n} 应判 mutation`)
  }
})
