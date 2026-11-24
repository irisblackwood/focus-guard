/**
 * 工具预算闸（2026-11-24）：shell / node -e 过密时只拦一次，下回合重置。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.FG_AUDIT_FILE = (await import('node:path')).join(
  (await import('node:os')).tmpdir(),
  `fg-budget-${process.pid}.log`,
)
delete process.env.FG_TOOL_BUDGET

const { toolBudgetCheck, resetToolBudget } = await import('../src/dsh/guard/toolBudget.mjs')
const { noteTracePosition } = await import('../src/dsh/traceMeta.mjs')

function exec(sid, cmd) {
  const header = { id: sid, cwd: process.cwd() }
  return { sessionId: sid, name: 'pwsh', arguments: { command: cmd }, agent: { session: { header } } }
}

test('node -e 超限：第 5 次拦一次，第 6 次放行', () => {
  resetToolBudget()
  const sid = `budget-node-${process.pid}`
  noteTracePosition({ session: { header: { id: sid } } }, 1, 1)
  for (let i = 1; i <= 4; i += 1) {
    assert.equal(toolBudgetCheck(exec(sid, `node -e "console.log(${i})"`), `node -e "console.log(${i})"`), null, `第 ${i} 次不该拦`)
  }
  const fifth = toolBudgetCheck(exec(sid, 'node -e "console.log(5)"'), 'node -e "console.log(5)"')
  assert.equal(fifth && fifth.kind, 'deny')
  assert.match(fifth.reason, /工具预算/)
  const sixth = toolBudgetCheck(exec(sid, 'node -e "console.log(6)"'), 'node -e "console.log(6)"')
  assert.equal(sixth, null, '只提醒一次，之后放行')
})

test('shell 超限：第 51 次拦一次', () => {
  resetToolBudget()
  const sid = `budget-shell-${process.pid}`
  noteTracePosition({ session: { header: { id: sid } } }, 1, 1)
  for (let i = 1; i <= 50; i += 1) {
    assert.equal(toolBudgetCheck(exec(sid, 'echo x'), 'echo x'), null, `第 ${i} 次不该拦`)
  }
  const over = toolBudgetCheck(exec(sid, 'echo x'), 'echo x')
  assert.equal(over && over.kind, 'deny')
  assert.match(over.reason, /合并/)
})

test('换回合后重新计数', () => {
  resetToolBudget()
  const sid = `budget-turn-${process.pid}`
  const agent = { session: { header: { id: sid } } }
  noteTracePosition(agent, 1, 1)
  for (let i = 1; i <= 50; i += 1) toolBudgetCheck(exec(sid, 'echo x'), 'echo x')
  assert.equal(toolBudgetCheck(exec(sid, 'echo x'), 'echo x').kind, 'deny')
  noteTracePosition(agent, 2, 1)
  assert.equal(toolBudgetCheck(exec(sid, 'echo x'), 'echo x'), null, '新回合从 0 计')
})
