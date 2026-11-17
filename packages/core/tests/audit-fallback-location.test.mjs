/**
 * 审计落点：`appendAudit` 必须按 `row.session` 的会话工作区走，不能落包安装位置。
 *
 * 病根（2026-11-16）：`AUDIT_FILE` 是按包安装位置上溯 4 级算的。开发仓里上溯正好是仓库根，
 * 看着对；插件装到 `~/.dsh/plugins/<name>` 时上溯就是插件目录，审计全部写进安装位置，
 * 用户在自己项目里永远看不到 `.focus-guard/AUDIT.log`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendAudit,
  buildAuditRow,
  setAuditProjectDirProvider,
  resolveProjectDir,
} from '../src/core/audit-writer.mjs'

test('appendAudit 落会话工作区，不落包安装位置', () => {
  const ws = mkdtempSync(join(tmpdir(), 'fg-audit-ws-'))
  const savedEnv = process.env.FG_AUDIT_FILE
  delete process.env.FG_AUDIT_FILE
  try {
    setAuditProjectDirProvider((sid) => (sid === 'sess-probe' ? ws : ''))

    assert.equal(resolveProjectDir('sess-probe'), ws, 'provider 应按 sid 给出工作区')

    const ok = appendAudit(buildAuditRow('sess-probe', 'probe'))
    assert.equal(ok, true, '写入应成功')

    const target = join(ws, '.focus-guard', 'AUDIT.log')
    assert.ok(existsSync(target), `应写进会话工作区：${target}`)
    assert.match(readFileSync(target, 'utf8'), /"session":"sess-probe"/)
  } finally {
    setAuditProjectDirProvider(null)
    if (savedEnv === undefined) delete process.env.FG_AUDIT_FILE
    else process.env.FG_AUDIT_FILE = savedEnv
    rmSync(ws, { recursive: true, force: true })
  }
})
