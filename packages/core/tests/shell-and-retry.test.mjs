/**
 * 2026-11-22 两个修复的验收：
 *   ① 执行体按工具判（pwsh 不再被认成 bash，合法 cmdlet 不被平台规则误拦）；
 *   ② 重复命令闸（同工具+同参数失败 2 次后，第 3 次原样重试被拒）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'fg-shell-retry-'))
process.env.FG_AUDIT_FILE = join(HOME, 'AUDIT.log')
process.env.DSH_HOME = HOME
process.env.FG_ENV_FP_FILE = join(HOME, 'env-fingerprint.json')
writeFileSync(process.env.FG_ENV_FP_FILE, JSON.stringify({ map: {} }))
delete process.env.FG_MODE
delete process.env.FG_RETRY_GUARD

const { shellIdForTool } = await import('../src/core/env.mjs')
const { preGuardListener } = await import('../src/dsh/preGuard.mjs')
const { preExecuteListener } = await import('../src/dsh/pipeline.mjs')
const { postExecuteListener } = await import('../src/dsh/guard/runtime.mjs')
const { resetRetryGuard } = await import('../src/dsh/guard/retryGuard.mjs')
const { statePath, saveState } = await import('../src/core/state.mjs')

test('shellIdForTool：pwsh 工具 → powershell，bash 工具 → bash', () => {
  assert.equal(shellIdForTool('pwsh'), 'powershell')
  assert.equal(shellIdForTool('PowerShell'), 'powershell')
  assert.equal(shellIdForTool('bash'), 'bash')
  assert.equal(shellIdForTool('shell'), 'bash')
  assert.equal(shellIdForTool('read'), null)
})

test('pwsh 工具 + 会话指纹写的是 bash：合法 cmdlet 不被平台规则拦', async () => {
  const sid = `shell-${process.pid}`
  const cwd = mkdtempSync(join(tmpdir(), 'fg-shell-cwd-'))
  saveState(statePath(sid), {
    fused: false,
    probation: false,
    readSet: {},
    caseCache: {},
    envCache: { os: 'win32', osLabel: 'Windows', shellIdKey: 'bash', caseSensitive: false, shells: [{ id: 'bash' }] },
  })
  const listener = preGuardListener({ warn: () => {} })
  const exec = {
    sessionId: sid,
    name: 'pwsh',
    arguments: { command: 'Get-ChildItem | Select-Object -First 3' },
    agent: { session: { header: { id: sid, cwd } } },
  }
  const decision = await listener(exec, () => ({ kind: 'allow' }))
  assert.ok(!decision || decision.kind !== 'deny', `不应 deny：${decision && decision.reason}`)
})

test('重复命令闸：失败 2 次后，第 3 次同参数调用被拒', async () => {
  resetRetryGuard()
  const sid = `retry-${process.pid}`
  const cwd = mkdtempSync(join(tmpdir(), 'fg-retry-cwd-'))
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {}, envCache: null })
  const exec = {
    sessionId: sid,
    name: 'bash',
    arguments: { command: 'node --version' },
    agent: { session: { header: { id: sid, cwd } } },
  }
  const post = postExecuteListener({ warn: () => {} })
  await post(exec, { isError: true, text: 'Error: exit code 1' }, () => undefined)
  await post(exec, { isError: true, text: 'Error: exit code 1' }, () => undefined)

  const pre = preExecuteListener({ warn: () => {} })
  const decision = await pre({ ...exec }, () => ({ kind: 'allow' }))
  assert.equal(decision && decision.kind, 'deny')
  assert.match(String(decision.reason), /重复命令闸/)
})
