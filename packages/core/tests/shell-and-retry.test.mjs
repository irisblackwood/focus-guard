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

const { shellIdForTool, platformBashViolation } = await import('../src/core/env.mjs')
const { preGuardListener } = await import('../src/dsh/preGuard.mjs')
const { preExecuteListener } = await import('../src/dsh/pipeline.mjs')
const { postExecuteListener } = await import('../src/dsh/guard/runtime.mjs')
const { resetRetryGuard } = await import('../src/dsh/guard/retryGuard.mjs')
const { statePath, saveState } = await import('../src/core/state.mjs')

// 2026-11-28：pwsh 与 powershell 分开。原断言把两者压成 'powershell'，丢版本信息，
// 于是 PowerShell 7 支持的 `&&` 被按 5.1 的规则一律禁——实测本机 pwsh 与 DSH 的
// PowerShell 工具都是 7.7.0 Core（`$true && "x"` 正常）。
test('shellIdForTool：pwsh 工具 → pwsh7，powershell 工具 → powershell，bash 工具 → bash', () => {
  assert.equal(shellIdForTool('pwsh'), 'pwsh7')
  assert.equal(shellIdForTool('pwsh7'), 'pwsh7')
  assert.equal(shellIdForTool('PowerShell'), 'powershell')
  assert.equal(shellIdForTool('bash'), 'bash')
  assert.equal(shellIdForTool('shell'), 'bash')
  assert.equal(shellIdForTool('read'), null)
})

test('&& 判据：pwsh7 且本机探测到 pwsh7 才放行；5.1 与未探测到都拦', () => {
  const win = (shellIdKey, shells) => ({ os: 'win32', shellIdKey, shells })
  const ps7 = win('pwsh7', [{ id: 'pwsh7' }, { id: 'powershell' }])
  assert.equal(platformBashViolation(ps7, '$true && "ok"'), null, 'pwsh7 上 && 合法');
  // 工具名叫 pwsh，但本机没探测到 pwsh7（可能只装了 5.1）→ 宁可多拦一次
  assert.ok(platformBashViolation(win('pwsh7', [{ id: 'powershell' }]), '$true && "x"'), '未探测到 pwsh7 必须拦')
  assert.ok(platformBashViolation(win('powershell', [{ id: 'pwsh7' }]), '$true && "x"'), '5.1 必须拦')
  // 其余 PowerShell 规则对 7 同样生效
  assert.ok(platformBashViolation(ps7, 'Get-ChildItem | head -3'), '7 也没有 head')
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
