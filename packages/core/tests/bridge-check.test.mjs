/**
 * 官方桥版本核验（2026-11-22）：区间内静默，区间外给升级/回退命令。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { bridgeSupported, checkBridge, SUPPORTED_BRIDGE_RANGE } = await import('../src/dsh/bridgeCheck.mjs')

test('区间内：0.2.1-rc.1 / 0.2.2-rc.5 都支持', () => {
  assert.equal(bridgeSupported('0.2.1-rc.1'), true)
  assert.equal(bridgeSupported('0.2.2-rc.5'), true)
  const r = checkBridge('0.2.2-rc.5')
  assert.equal(r.supported, true)
  assert.equal(r.message, '')
})

test('区间外：0.2.0 / 0.3.0 / 垃圾串', () => {
  for (const v of ['0.2.0', '0.3.0', '0.3.0-rc.1', 'not-a-version']) {
    assert.equal(bridgeSupported(v), false, v)
    const r = checkBridge(v)
    assert.equal(r.supported, false)
    assert.match(r.message, /升级/)
    assert.match(r.message, /回退/)
    assert.match(r.message, /官方仓库/)
  }
})

test('读不到版本时不报警（不制造假阳性）', () => {
  const r = checkBridge('')
  assert.equal(r.version, '')
  assert.equal(r.supported, true)
  assert.equal(r.message, '')
})

test('支持区间是可读字符串', () => {
  assert.match(SUPPORTED_BRIDGE_RANGE, /0\.2\.1/)
})
