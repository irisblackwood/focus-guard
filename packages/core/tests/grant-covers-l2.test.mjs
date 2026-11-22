/**
 * 手机端 bug 修复验证（ARCH-MAP #11/#12，2026-11-21）：
 *   #12 fg_apply 授权后，第 2 层判定不得再 ask（授权闭环）；
 *   #11 ask 必须落审计（needApproval），不再只有 deny 有痕迹。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'fg-grant-'))
const AUDIT = join(HOME, 'AUDIT.log')
process.env.FG_AUDIT_FILE = AUDIT
process.env.DSH_HOME = HOME
delete process.env.FG_MODE

const { preExecuteListener } = await import('../src/dsh/pipeline.mjs')
const { grantsFor, resetGrants } = await import('../src/adapters/dsh/eligibility-gate.mjs')

const header = (sid) => ({ agent: { session: { header: { id: sid, cwd: process.cwd() } } } })
const execOf = (sid, cmd) => ({ sessionId: sid, name: 'bash', arguments: { command: cmd }, ...header(sid) })
const next = () => ({ kind: 'allow' })
const throwingJudge = () => {
  throw new Error('judge unavailable')
}

test('#12 已授权工具：第 2 层不再 ask', async () => {
  const sid = `grant-${process.pid}-a`
  resetGrants(sid)
  grantsFor(sid).grant('bash', { ttl: 'turn', reason: 'test' })
  const listener = preExecuteListener({ warn: () => {}, riskOf: throwingJudge })
  const decision = await listener(execOf(sid, 'pwd'), next)
  assert.notEqual(decision && decision.kind, 'ask')
})

test('#11 未授权且判定失败：ask 落 needApproval 审计', async () => {
  const sid = `grant-${process.pid}-b`
  resetGrants(sid)
  const listener = preExecuteListener({ warn: () => {}, riskOf: throwingJudge })
  const decision = await listener(execOf(sid, 'pwd'), next)
  assert.equal(decision && decision.kind, 'ask')
  const text = existsSync(AUDIT) ? readFileSync(AUDIT, 'utf8') : ''
  assert.match(text, /"action":"needApproval"/)
  assert.match(text, new RegExp(sid))
})
