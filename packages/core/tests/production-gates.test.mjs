/**
 * 关闭型开关的立法锁（2026-10-29）。
 *
 * 立法：**不允许关闭任何一个功能**。四个关闭型开关
 * （`FG_EVIDENCE_GATE` / `FG_VALUE_GATE` / `FG_RANDOM_FUSE` / `FG_RESULT_ADMIT_BUDGET`）
 * 只在测试运行时生效，生产环境恒为「开」。
 *
 * 为什么单独一个文件：这四条锁的不是某个闸的行为，而是**闸能被关掉这件事本身**。
 * 它们红了说明有人在生产路径上重新开了关闭口，跟功能回归是两类问题。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTestRuntime, gateSwitch, gateThreshold } from '../src/dsh/testRuntime.mjs'
import { EVIDENCE_GATE } from '../src/dsh/guard/evidence.mjs'

/** 摘掉测试标记模拟生产；返回恢复函数（调用方负责 finally）。 */
function asProduction() {
  const ctx = process.env.NODE_TEST_CONTEXT
  const mode = process.env.FG_TEST_MODE
  delete process.env.NODE_TEST_CONTEXT
  delete process.env.FG_TEST_MODE
  return () => {
    if (ctx !== undefined) process.env.NODE_TEST_CONTEXT = ctx
    if (mode !== undefined) process.env.FG_TEST_MODE = mode
  }
}

/** 在指定变量取值下跑一段断言，结束后还原。 */
function withEnv(name, value, fn) {
  const prev = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  }
}

const OFF_SWITCHES = ['FG_EVIDENCE_GATE', 'FG_VALUE_GATE', 'FG_RANDOM_FUSE']

test('立法锁', async (t) => {
  await t.test('p1. 当前 runner 被识别为测试运行时（锁跑法：不是 node --test 就会红）', () => {
    assert.equal(isTestRuntime(), true, 'npm test / test:all 都走 node --test，NODE_TEST_CONTEXT 应存在')
  })

  await t.test('p2. 生产环境：三个布尔关闭开关设成关闭值也关不掉', () => {
    const restore = asProduction()
    try {
      for (const name of OFF_SWITCHES) {
        withEnv(name, '0', () => {
          assert.equal(gateSwitch(name), true, `${name}=0 在生产必须无效`)
        })
      }
    } finally {
      restore()
    }
  })

  await t.test('p3. 生产环境：设成任何值都是开（不是只忽略 "0"）', () => {
    const restore = asProduction()
    try {
      for (const name of OFF_SWITCHES) {
        for (const value of ['1', 'false', 'off', '']) {
          withEnv(name, value, () => {
            assert.equal(gateSwitch(name), true, `${name}=${JSON.stringify(value)} 在生产必须无效`)
          })
        }
        withEnv(name, undefined, () => {
          assert.equal(gateSwitch(name), true, `${name} 未设时为开`)
        })
      }
    } finally {
      restore()
    }
  })

  await t.test('p4. 测试运行时：同样的关闭值仍然有效（关闭能力没被删掉）', () => {
    for (const name of OFF_SWITCHES) {
      withEnv(name, '0', () => {
        assert.equal(gateSwitch(name), false, `${name}=0 在测试里必须能关`)
      })
    }
  })

  await t.test('p5. FG_TEST_MODE=1 可显式进入测试语义（给不走 node --test 的夹具）', () => {
    const restore = asProduction()
    try {
      process.env.FG_TEST_MODE = '1'
      assert.equal(isTestRuntime(), true)
      withEnv('FG_EVIDENCE_GATE', '0', () => {
        assert.equal(gateSwitch('FG_EVIDENCE_GATE'), false)
      })
    } finally {
      restore()
    }
  })

  await t.test('p6. gateThreshold：生产下限 1，测试保留 0', () => {
    const restore = asProduction()
    try {
      withEnv('FG_RESULT_ADMIT_BUDGET', '0', () => {
        assert.equal(gateThreshold('FG_RESULT_ADMIT_BUDGET', 3), 1, '0 在生产被兜到 1')
      })
      withEnv('FG_RESULT_ADMIT_BUDGET', '-5', () => {
        assert.equal(gateThreshold('FG_RESULT_ADMIT_BUDGET', 3), 1, '负数同样兜到 1')
      })
      withEnv('FG_RESULT_ADMIT_BUDGET', '5', () => {
        assert.equal(gateThreshold('FG_RESULT_ADMIT_BUDGET', 3), 5, '只禁关闭，不禁调大')
      })
      withEnv('FG_RESULT_ADMIT_BUDGET', 'abc', () => {
        assert.equal(gateThreshold('FG_RESULT_ADMIT_BUDGET', 3), 3, '脏值回落缺省')
      })
    } finally {
      restore()
    }
    withEnv('FG_RESULT_ADMIT_BUDGET', '0', () => {
      assert.equal(gateThreshold('FG_RESULT_ADMIT_BUDGET', 3), 0, '测试里 0 仍表示关闭')
    })
  })

  await t.test('p7. 真实模块的常量默认是开（模块级求值，改了变量也不动——这是设计）', () => {
    // EVIDENCE_GATE 在 import 时求值，后续改环境变量不会影响它。
    // 这条锁的是「默认开」，不是「响应变量」——响应能力由 p2/p4 在函数层覆盖。
    assert.equal(EVIDENCE_GATE.effective, true)
  })
})
