/**
 * `FG_MODE=lite`（2026-11-21）：只保留红线 / 环境硬校验 / 资格闸。
 *
 * 目的：日常使用不付"语义判定 → 拦/问 → 重试"的步数成本；危险红线不放松。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 审计必须重定向到临时文件——否则红线用例会把测试行写进真实 AUDIT.log（audit-isolation 会判红）。
const HOME = mkdtempSync(join(tmpdir(), 'fg-lite-home-'))
process.env.FG_AUDIT_FILE = join(HOME, 'AUDIT.log')
process.env.DSH_HOME = HOME

const { preExecuteListener, isLiteMode } = await import('../src/dsh/pipeline.mjs')

function execOf(cmd, sid = 'lite-1') {
  return {
    sessionId: sid,
    name: 'bash',
    arguments: { command: cmd },
    agent: { session: { header: { id: sid, cwd: process.cwd() } } },
  }
}

const next = () => ({ kind: 'allow' })

test('lite 模式不调用第 2 层判官（说明 risk 段被跳过）', async () => {
  process.env.FG_MODE = 'lite'
  assert.equal(isLiteMode(), true)
  let called = false
  const listener = preExecuteListener({
    warn: () => {},
    riskOf: () => {
      called = true
      throw new Error('judge unavailable')
    },
  })
  const decision = await listener(execOf('pwd', 'lite-a'), next)
  assert.equal(called, false, 'lite 下不应调用 riskOf')
  assert.notEqual(decision && decision.kind, 'ask')
})

test('full 模式仍调用判官；判官失败 → 保守 ask', async () => {
  delete process.env.FG_MODE
  assert.equal(isLiteMode(), false)
  const listener = preExecuteListener({
    warn: () => {},
    riskOf: () => {
      throw new Error('judge unavailable')
    },
  })
  const decision = await listener(execOf('pwd', 'lite-b'), next)
  assert.equal(decision && decision.kind, 'ask')
})

test('lite 模式红线仍然拒绝', async () => {
  process.env.FG_MODE = 'lite'
  const listener = preExecuteListener({ warn: () => {}, riskOf: () => ({ risk: 0, category: 'benign', reasons: [] }) })
  const decision = await listener(execOf('rm -rf /', 'lite-c'), next)
  assert.equal(decision && decision.kind, 'deny')
})

test('没有环境变量时，$DSH_HOME/focus-guard-mode.txt 也能开启 lite', async () => {
  delete process.env.FG_MODE
  writeFileSync(join(HOME, 'focus-guard-mode.txt'), 'lite\n')
  assert.equal(isLiteMode(), true)
})
