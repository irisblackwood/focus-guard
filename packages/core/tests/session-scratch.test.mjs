/**
 * 会话级 scratch 的契约（2026-10-29）。
 *
 * 这层存在的理由只有一条：**状态必须能摆回已知起点**。
 * 所以断言的重点不是"能存能取"，而是"能清干净、清了之后真的回到初始行为"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionSet,
  sessionFlag,
  clearSession,
  clearAllSessions,
  scratchStats,
  SCRATCH_MAX_SESSIONS,
} from '../src/core/sessionScratch.mjs'

test.beforeEach(() => clearAllSessions())

test('会话级 scratch', async (t) => {
  await t.test('s1. 同一会话拿到同一个集合（引用相等）', () => {
    const tbl = sessionSet('s1')
    const a = tbl.of('sess-a')
    a.add('/x')
    assert.equal(tbl.of('sess-a'), a, '同 sid 必须返回同一对象，否则 add 会丢')
    assert.equal(tbl.of('sess-a').has('/x'), true)
  })

  await t.test('s2. 不同会话互不可见（取证隔离的底线）', () => {
    const tbl = sessionSet('s2')
    tbl.of('sess-a').add('/x')
    assert.equal(tbl.of('sess-b').has('/x'), false)
    assert.equal(tbl.sizeOf('sess-a'), 1)
    assert.equal(tbl.sizeOf('sess-b'), 0)
  })

  await t.test('s3. clearSession 同时清掉 set 表与 flag 表', () => {
    const set1 = sessionSet('s3-set')
    const flag1 = sessionFlag('s3-flag')
    set1.of('sess-a').add('/x')
    flag1.add('sess-a')
    set1.of('sess-b').add('/y')

    const cleared = clearSession('sess-a')
    assert.equal(cleared, 2, '两张表各命中一次')
    assert.equal(set1.sizeOf('sess-a'), 0)
    assert.equal(flag1.has('sess-a'), false)
    assert.equal(set1.sizeOf('sess-b'), 1, '别的会话不能被误清')
  })

  await t.test('s4. clearSession 后行为回到初始（这就是修基准串味的能力）', () => {
    const tbl = sessionSet('s4')
    tbl.of('sess-a').add('/read-once')
    assert.equal(tbl.of('sess-a').has('/read-once'), true)

    clearSession('sess-a')
    assert.equal(tbl.of('sess-a').has('/read-once'), false, '清完必须像从没读过')
    assert.equal(tbl.sizeOf('sess-a'), 0)
  })

  await t.test('s5. clearAllSessions 清空所有表', () => {
    sessionSet('s5-a').of('x').add(1)
    sessionFlag('s5-b').add('x')
    clearAllSessions()
    assert.deepEqual(scratchStats()['s5-a'], 0)
    assert.deepEqual(scratchStats()['s5-b'], 0)
  })

  await t.test('s6. 同名表跨模块共享、不同名互不干扰', () => {
    const a1 = sessionSet('shared')
    const a2 = sessionSet('shared')
    const other = sessionSet('other')
    a1.of('s').add('/p')
    assert.equal(a2.of('s').has('/p'), true, '同名必须是同一张表')
    assert.equal(other.of('s').has('/p'), false, '不同名不能串')
  })

  await t.test('s7. flag 的 has/add/clear', () => {
    const f = sessionFlag('s7')
    assert.equal(f.has('s'), false)
    f.add('s')
    assert.equal(f.has('s'), true)
    assert.equal(f.clear('s'), true)
    assert.equal(f.has('s'), false)
    assert.equal(f.clear('s'), false, '重复清返回 false')
  })

  await t.test('s8. 超过上限按插入序删最旧（长驻进程不无限涨）', () => {
    const tbl = sessionSet('s8')
    for (let i = 0; i < SCRATCH_MAX_SESSIONS + 5; i += 1) tbl.of(`s${i}`).add(i)
    assert.equal(tbl.sessions(), SCRATCH_MAX_SESSIONS, '总量必须被压在上限')
    assert.equal(tbl.sizeOf('s0'), 0, '最旧的被剪掉')
    assert.equal(tbl.sizeOf(`s${SCRATCH_MAX_SESSIONS + 4}`), 1, '最新的保留')
  })

  await t.test('s9. scratchStats 反映真实会话数', () => {
    sessionSet('s9').of('a').add(1)
    sessionSet('s9').of('b').add(1)
    assert.equal(scratchStats()['s9'], 2)
  })
})
