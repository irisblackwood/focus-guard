// FocusGuard · 压缩损失度量（2026-11-16）
//
// 覆盖 `compactionWatch.mjs::auditLoss` 的两条出口：
//   有原文 + 有摘要 → `compaction-loss`（计数差）
//   无原文          → `compaction-loss-skip`（每会话一次，自证降级）
//
// 纪律：审计重定向到一次性沙箱目录，绝不碰真实工作区，也绝不散落在 tmpdir 根。
// 运行：node --test packages/core/tests/compaction-loss.test.mjs
//
// 2026-11-16 修正：原实现把 `fg-compaction-loss-<pid>-<ts>.log` 直接拼在 `tmpdir()` 根，
// 且只在**每条用例开头**删自己——跑完最后一个用例文件留在磁盘上，而文件名带 pid+时间戳，
// 下次跑又是新名字，于是**每跑一次必留一个，永不回收**。`staleCleanup` 也认不出它
// （`TEMP_ENTRY_RE` 只匹配 `focus-guard-*` 前缀 + `.json`/`-AUDIT.log`/`.tmp` 后缀）。
// 改为一次性目录 + `after` 整目录删除：漏删也只是少一个目录，不再散落成片。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'fg-cl-'))
const AUDIT_TMP = join(SANDBOX, 'AUDIT.log')
process.env.FG_AUDIT_FILE = AUDIT_TMP

after(() => rmSync(SANDBOX, { recursive: true, force: true }))

const { compactionEventListener } = await import('../src/dsh/compactionWatch.mjs')

const noop = () => {}
const auditRows = () =>
  existsSync(AUDIT_TMP)
    ? readFileSync(AUDIT_TMP, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

const evStart = (id, seq = 100, time = 1_000) => ({
  type: 'compaction/start',
  seq,
  time,
  data: { compactionId: id, turn: 7 },
})

const evSummary = (startSeq, endSeq, sourceSeqs, text) => ({
  type: 'user/message',
  seq: endSeq + 1,
  time: 1_100,
  data: { content: [{ type: 'text', text }] },
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: sourceSeqs,
})

const evEnd = (id, seq = 200, time = 1_500) => ({
  type: 'compaction/end',
  seq,
  time,
  data: { compactionId: id },
})

test('有原文有摘要 → 记一条 compaction-loss，只报计数', () => {
  rmSync(AUDIT_TMP, { force: true })
  const listen = compactionEventListener({ warn: noop })
  const session = {
    id: 'cl-ok',
    header: { id: 'cl-ok' },
    messages: [
      // content 为字符串（人类/工具文本）
      { content: '看 src/auth/token.mjs:147 的 REFRESH_SKEW_MS，报 E4012' },
      // content 为块数组（模型消息）
      { content: [{ type: 'text', text: 'src/auth/guard.mjs 里 CACHE_MAX 是 12' }] },
    ],
  }

  listen(session, evStart('c-1'))
  listen(session, evSummary(14, 40, [14, 15], '问题在 guard 的缓存顺序，E4012 由验签失败抛出'))
  listen(session, evEnd('c-1'))

  const loss = auditRows().filter((r) => r.action === 'compaction-loss')
  assert.equal(loss.length, 1, '应写一条 compaction-loss')
  const ev = String(loss[0].evidence)
  assert.match(ev, /锚点 6→1/, `原文 6 个锚点、摘要 1 个，实际：${ev}`)
  assert.match(ev, /丢 5/)
  assert.equal(loss[0].before_total, 6)
  assert.equal(loss[0].after_total, 1)
  // 只报计数：evidence 里不该出现原文片段
  assert.ok(!ev.includes('src/auth/token.mjs'), 'evidence 不得带原文路径')
})

test('session 无 messages → 记一条 skip，且只记一次', () => {
  rmSync(AUDIT_TMP, { force: true })
  const listen = compactionEventListener({ warn: noop })
  const session = { id: 'cl-nomsg', header: { id: 'cl-nomsg' } }

  listen(session, evStart('c-2'))
  listen(session, evSummary(10, 20, [10], 'summary'))
  listen(session, evEnd('c-2'))

  // 第二轮压缩：skip 不该再报
  listen(session, evStart('c-3', 300, 2_000))
  listen(session, evSummary(30, 40, [30], 'summary'))
  listen(session, evEnd('c-3', 400, 2_500))

  const rows = auditRows()
  assert.equal(rows.filter((r) => r.action === 'compaction-loss').length, 0, '拿不到原文时不该写 loss')
  assert.equal(rows.filter((r) => r.action === 'compaction-loss-skip').length, 1, 'skip 每会话只报一次')
})
