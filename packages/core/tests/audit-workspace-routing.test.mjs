/**
 * 审计落点按会话分流：provider 拿到 sid 后，两个会话各写各的工作区。
 *
 * 2026-11-15 新增。原来 `auditTarget()` 是「进程级单值缓存」——第一次解析完就锁死，
 * 兜底路径里却带 sid。一个进程只服务一个工作区时看不出来；DSH 这种并发多会话的宿主里，
 * **第二个会话会写进第一个的文件**。改成按 sid 缓存后，这条用例钉住三件事：
 *   ① 已登记的会话落在自己的工作区；
 *   ② 两个会话互不串；
 *   ③ 没登记的会话退临时目录，而不是猜一个工作区。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditTarget, setProjectDirProvider } from '../src/core/audit.mjs'
import { rememberWorkspace, workspaceOf } from '../src/dsh/seams/shared.mjs'

test('审计落点：按会话登记的工作区分流，未登记退临时目录', () => {
  // 显式重定向优先级最高，会把本用例短路掉；套件里可能被外层设上，先摘下来再放回去。
  const saved = process.env.FG_AUDIT_FILE
  delete process.env.FG_AUDIT_FILE
  // 与 `src/dsh/index.js` 里注册的 provider 同形——被测的正是「宿主侧怎么接」。
  setProjectDirProvider((sid) => workspaceOf(sid) || process.env.FG_PROJECT_DIR || '')
  const a = mkdtempSync(join(tmpdir(), 'fg-audit-a-'))
  const b = mkdtempSync(join(tmpdir(), 'fg-audit-b-'))
  const sidA = `ws-a-${process.pid}-${Date.now()}`
  const sidB = `ws-b-${process.pid}-${Date.now()}`
  try {
    rememberWorkspace({ session: { header: { id: sidA, cwd: a } } })
    rememberWorkspace({ session: { header: { id: sidB, cwd: b } } })
    assert.equal(auditTarget(sidA), join(a, '.focus-guard', 'AUDIT.log'))
    assert.equal(auditTarget(sidB), join(b, '.focus-guard', 'AUDIT.log'), '第二个会话不得复用第一个的路径')
    // 未登记：必须落临时目录。猜一个工作区比落临时目录更坏——那是把别人的日志写脏。
    const orphan = auditTarget(`orphan-${process.pid}-${Date.now()}`)
    assert.ok(orphan.includes('.focus-guard') === false, '未登记会话不应落到任何工作区')
    assert.match(orphan, /focus-guard-orphan-.*-AUDIT\.log$/)
  } finally {
    setProjectDirProvider(null)
    if (saved !== undefined) process.env.FG_AUDIT_FILE = saved
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})
