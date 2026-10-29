import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// 工具 schema 漂移判定（2026-10-29）
// 病根：原判定只有「hash 相等 = PASS」「不等 = 漂移」两档，于是「整批工具因为某个 MCP
// 服务器没连上而消失」被当成漂移，红得没有信息量。本组锁五种结局互不串档。

const { serverOf, groupByServer, topServers, suspectPluginGone, judgeDrift } = await import(
  '../src/core/schemaDrift.mjs'
)

const reaTools = (n = 170) => Array.from({ length: n }, (_, i) => `mcp__rea__t${i}`)
const coreTools = (n = 84) => Array.from({ length: n }, (_, i) => `tool_${i}`)

describe('serverOf：MCP 服务器名解析', () => {
  test('普通名与带横杠的名都能取到', () => {
    assert.equal(serverOf('mcp__rea__address_name'), 'rea')
    assert.equal(serverOf('mcp__cities2-mcp__get_page'), 'cities2-mcp')
    assert.equal(serverOf('mcp__x__a__b'), 'x', '只截到第二个 __ 为止')
  })

  test('非 MCP 与脏输入返回空串', () => {
    for (const n of ['read', 'write', 'mcp_rea_x', '', null, undefined, 123]) {
      assert.equal(serverOf(n), '', `${String(n)} 不该解析出服务器名`)
    }
  })
})

describe('groupByServer / topServers', () => {
  test('按服务器计数，非 MCP 不计入', () => {
    const m = groupByServer([...reaTools(3), 'mcp__cities2-mcp__a', 'mcp__cities2-mcp__b', 'read', 'write'])
    assert.equal(m.get('rea'), 3)
    assert.equal(m.get('cities2-mcp'), 2)
    assert.equal(m.has(''), false, '非 MCP 不该出现空串键')
  })

  test('topServers 按数量降序并截断', () => {
    const m = new Map([
      ['a', 1],
      ['b', 9],
      ['c', 5],
    ])
    assert.deepEqual(topServers(m, 2), [
      ['b', 9],
      ['c', 5],
    ])
  })
})

describe('suspectPluginGone：整批同源消失', () => {
  test('170 个全来自同一服务器 → 命中', () => {
    const r = suspectPluginGone({ removed: reaTools(170) })
    assert.deepEqual(r, { server: 'rea', count: 170, share: 1 })
  })

  test('数量太少不判（零星改名说明不了什么）', () => {
    assert.equal(suspectPluginGone({ removed: reaTools(9) }), null)
  })

  test('散落在多个服务器 → 不判（那是真漂移）', () => {
    const mixed = [
      ...Array.from({ length: 6 }, (_, i) => `mcp__a__t${i}`),
      ...Array.from({ length: 6 }, (_, i) => `mcp__b__t${i}`),
    ]
    assert.equal(suspectPluginGone({ removed: mixed }), null)
  })

  test('同源但占比不到 80% → 不判', () => {
    const mostly = [...reaTools(10), ...Array.from({ length: 6 }, (_, i) => `mcp__b__t${i}`)]
    assert.equal(suspectPluginGone({ removed: mostly }), null)
  })

  test('空列表不判', () => {
    assert.equal(suspectPluginGone({ removed: [] }), null)
  })
})

describe('judgeDrift：五种结局', () => {
  test('hash 相等 → match', () => {
    const v = judgeDrift({ baseHash: 'abc', baseTools: 3, baseNames: ['a', 'b', 'c'], curHash: 'abc', curNames: ['a', 'b', 'c'] })
    assert.equal(v.kind, 'match')
  })

  test('缺 tools_map + 数量骤降 → suspect-plugin-gone（按数量粗判）', () => {
    const v = judgeDrift({ baseHash: 'old', baseTools: 254, baseNames: [], curHash: 'new', curNames: coreTools(86) })
    assert.equal(v.kind, 'suspect-plugin-gone')
    assert.equal(v.server, undefined, '没有工具名表，不能指名是哪个服务器')
    assert.ok(v.ratio < 0.6)
  })

  test('缺 tools_map + 数量接近 → unknown-baseline（不假装判断）', () => {
    const v = judgeDrift({ baseHash: 'old', baseTools: 100, baseNames: [], curHash: 'new', curNames: coreTools(95) })
    assert.equal(v.kind, 'unknown-baseline')
  })

  test('零交集 → environment-switch（换宿主不是漂移）', () => {
    const v = judgeDrift({
      baseHash: 'old',
      baseTools: 3,
      baseNames: ['x', 'y', 'z'],
      curHash: 'new',
      curNames: ['a', 'b', 'c'],
    })
    assert.equal(v.kind, 'environment-switch')
    assert.equal(v.overlap, 0)
  })

  test('整批同源消失 → suspect-plugin-gone，并指名服务器', () => {
    const base = [...reaTools(170), ...coreTools(84)]
    const cur = [...coreTools(84), 'tool_new_a', 'tool_new_b']
    const v = judgeDrift({ baseHash: 'old', baseTools: base.length, baseNames: base, curHash: 'new', curNames: cur })
    assert.equal(v.kind, 'suspect-plugin-gone')
    assert.equal(v.server, 'rea')
    assert.equal(v.serverCount, 170)
    assert.equal(v.removed.length, 170)
    assert.equal(v.added.length, 2, '新增 2 个不该让它变成漂移')
  })

  test('零星消失 → drift（真漂移）', () => {
    const base = [...coreTools(84), 'mcp__a__t1', 'mcp__a__t2']
    const cur = [...coreTools(84)]
    const v = judgeDrift({ baseHash: 'old', baseTools: base.length, baseNames: base, curHash: 'new', curNames: cur })
    assert.equal(v.kind, 'drift')
    assert.equal(v.removed.length, 2)
  })

  test('只增不减 → drift（新装插件也可能是真漂移，必须人看一眼）', () => {
    const base = coreTools(84)
    const cur = [...coreTools(84), ...Array.from({ length: 20 }, (_, i) => `mcp__new__t${i}`)]
    const v = judgeDrift({ baseHash: 'old', baseTools: base.length, baseNames: base, curHash: 'new', curNames: cur })
    assert.equal(v.kind, 'drift')
    assert.equal(v.added.length, 20)
    assert.equal(v.removed.length, 0)
  })

  test('参数键变了但工具名没变 → drift（hash 变、名单不变）', () => {
    const names = coreTools(10)
    const v = judgeDrift({ baseHash: 'old', baseTools: 10, baseNames: names, curHash: 'new', curNames: names })
    assert.equal(v.kind, 'drift', 'hash 不同但名单相同 = 参数键漂移，正是要抓的那种')
    assert.deepEqual(v.added, [])
    assert.deepEqual(v.removed, [])
  })

  test('servers 字段始终给出当前 MCP 分布（供打印用）', () => {
    const v = judgeDrift({
      baseHash: 'old',
      baseTools: 10,
      baseNames: coreTools(10),
      curHash: 'new',
      curNames: [...coreTools(10), 'mcp__x__a', 'mcp__x__b', 'mcp__y__c'],
    })
    assert.deepEqual(v.servers[0], ['x', 2])
    assert.deepEqual(v.servers[1], ['y', 1])
  })

  test('脏输入不抛（空对象 / 缺字段）', () => {
    // 两边都没 hash 时不能假装 PASS（缺 hash 的坏基线静默通过比报红更危险），
    // 但也不能判漂移——只能说"无法判断"。
    assert.notEqual(judgeDrift({}).kind, 'drift', '空输入不该判漂移')
    assert.equal(judgeDrift({ curHash: 'a', curNames: [] }).kind, 'unknown-baseline')
  })
})
