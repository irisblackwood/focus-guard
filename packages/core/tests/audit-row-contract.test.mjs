/**
 * 审计行契约（2026-10-29 重构，依据真实 AUDIT.log 实测）
 *
 * 为什么有这个文件：重构前"造一条审计行"的代码在 5 处各写一遍
 * （`seams/shared.mjs::auditRow`、`postProgress.mjs`、`preGuard.mjs`、`stopGuard.mjs`、
 * `compactionWatch.mjs::row`），五份字段集各不相同。真实日志 7875 行的体检结果：
 *
 *   - 7227 行带 seq，其中 6447 行用 `Math.floor(performance.now())` 当尾数 → **17 组 seq 重复**
 *     （如 `mv2fzh7c.350962` ×2），因果链按 seq 建索引，撞号即丢边；
 *   - `fuse-waste`(11) / `grant`(5) / `grants-swept`(8) / `audit-purge`(1) 缺 trigger/level/pardon；
 *   - 同一份文件里三种形态并存：带 chain/ref 的、不带的、缺字段的。
 *
 * 本文件把契约钉在**写入点**，而不是钉在各个调用点：
 *   ① `buildAuditRow` 是唯一构造点；
 *   ② `appendAudit` 对绕开它的裸行也补齐七字段；
 *   ③ seq 进程内单调，不撞号。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'fg-audit-contract-'))
const FILE = join(SANDBOX, 'AUDIT.log')
process.env.FG_AUDIT_FILE = FILE
process.on('exit', () => rmSync(SANDBOX, { recursive: true, force: true }))

const aw = await import('../src/core/audit-writer.mjs')
const dshAudit = await import('../src/dsh/audit.mjs')
const gate = await import('../src/adapters/dsh/eligibility-gate.mjs')
const shared = await import('../src/dsh/seams/shared.mjs')

function rows() {
  try {
    return readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

function lastRow(action) {
  const all = rows()
  for (let i = all.length - 1; i >= 0; i -= 1) if (all[i].action === action) return all[i]
  return null
}

describe('审计行 · 七字段契约（ARCHITECTURE.md:63）', () => {
  test('buildAuditRow 补齐七字段 + 因果链三字段', () => {
    const row = aw.buildAuditRow('sess-a', 'probe')
    for (const k of aw.AUDIT_REQUIRED_FIELDS) assert.ok(k in row, `缺字段 ${k}`)
    for (const k of ['seq', 'chain', 'ref']) assert.ok(k in row, `缺因果链字段 ${k}`)
    assert.equal(row.trigger, 'probe', 'trigger 缺省应回落到 action')
    assert.equal(row.level, null)
    assert.equal(row.pardon, false)
  })

  test('附加诊断字段原样带入（tool / command / basis / turn …）', () => {
    const row = aw.buildAuditRow('sess-a', 'deny', {
      evidence: 'rm -rf /',
      extra: { tool: 'Bash', command: 'rm -rf /', basis: 'redline', turn: 3, step: 7 },
    })
    assert.equal(row.tool, 'Bash')
    assert.equal(row.command, 'rm -rf /')
    assert.equal(row.basis, 'redline')
    assert.equal(row.turn, 3)
    assert.equal(row.step, 7)
  })

  test('身份字段由位置参数定，附加字段改不动（否则一条 deny 能被改成别的动作）', () => {
    const row = aw.buildAuditRow('sess-a', 'deny', {
      trigger: 'real-trigger',
      level: 4,
      extra: { trigger: 'forged', level: 1, action: 'forged-action', session: 'forged' },
    })
    assert.equal(row.action, 'deny')
    assert.equal(row.session, 'sess-a')
    // 非身份字段：opts 显式值优先于 extra，extra 只补缺
    assert.equal(row.trigger, 'real-trigger')
    assert.equal(row.level, 4)
  })

  test('extra 可在 opts 缺省时供给契约字段（迁移期老调用点的形态）', () => {
    const row = aw.buildAuditRow('sess-a', 'context-overflow', { extra: { evidence: '压缩栈疑似未生效' } })
    assert.equal(row.evidence, '压缩栈疑似未生效', 'extra 里的 evidence 不能被丢掉')
  })

  test('绕开构造点直传裸行，appendAudit 仍补齐七字段与事件号（fuse-waste 那类残行）', () => {
    aw.appendAudit({ session: 'sess-bare', action: 'fuse-waste', evidence: '历史形态' })
    const row = lastRow('fuse-waste')
    assert.ok(row, '未写入')
    for (const k of aw.AUDIT_REQUIRED_FIELDS) assert.ok(k in row, `裸行缺字段 ${k}`)
    assert.ok(row.seq, '裸行也应拿到事件号——否则因果链看不见它')
    assert.equal(row.trigger, 'fuse-waste', 'trigger 应回落到 action')
  })
})

describe('审计行 · 事件号唯一', () => {
  test('连写 1000 条不撞号（重构前用 performance.now() 取整，实测撞了 17 组）', () => {
    const seqs = []
    for (let i = 0; i < 1000; i += 1) seqs.push(aw.nextSeq())
    assert.equal(new Set(seqs).size, seqs.length, `seq 有重复：${seqs.length - new Set(seqs).size} 组`)
  })

  test('seq 结构：<时间戳36>.<单调计数>.<pid36>', () => {
    const s = aw.nextSeq()
    const parts = s.split('.')
    assert.equal(parts.length, 3, `段数不对：${s}`)
    assert.ok(Number.isInteger(Number(parts[1])) && Number(parts[1]) > 0, `计数段非正整数：${s}`)
    assert.equal(parseInt(parts[2], 36), process.pid, `pid 段不对：${s}`)
  })

  test('不同进程不会撞号（宿主与测试子进程同时写同一个日志）', async () => {
    const { execFileSync } = await import('node:child_process')
    const here = new Set([aw.nextSeq(), aw.nextSeq(), aw.nextSeq()])
    const child = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { nextSeq } from ${JSON.stringify(new URL('../src/core/audit-writer.mjs', import.meta.url).href)};
         console.log([nextSeq(), nextSeq(), nextSeq()].join('\\n'))`,
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
    for (const s of child) assert.ok(!here.has(s), `子进程与父进程撞号：${s}`)
  })
})

describe('审计行 · 各写入点都走同一契约', () => {
  const check = (row, label) => {
    assert.ok(row, `${label} 未写入`)
    for (const k of aw.AUDIT_REQUIRED_FIELDS) assert.ok(k in row, `${label} 缺字段 ${k}`)
    assert.ok(row.seq, `${label} 缺事件号 seq`)
  }

  test('auditDeny', () => {
    dshAudit.auditDeny({ sessionId: 'sess-deny' }, 'npm publish', { trigger: 'publish', level: 3 })
    check(lastRow('deny'), 'auditDeny')
  })

  test('auditRedlineExempt', () => {
    dshAudit.auditRedlineExempt({ sessionId: 'sess-red' }, 'echo "rm -rf /"', { redline: 'rm-rf' })
    check(lastRow('redline-exempt'), 'auditRedlineExempt')
  })

  test('auditEligibility（grants-swept 历史缺 level/pardon）', () => {
    gate.auditEligibility({
      session: 'sess-grant',
      action: 'grants-swept',
      trigger: 'ttl:turn',
      evidence: 'Bash,Write',
    })
    check(lastRow('grants-swept'), 'auditEligibility')
  })

  test('seams/shared 的 auditRow', () => {
    shared.auditRow('sess-seam', 'reset-fired', 'prompt:有 kw=3', { level: null })
    check(lastRow('reset-fired'), 'auditRow')
  })

  test('整份日志逐行过契约（累积下来没有一条残行）', () => {
    const all = rows()
    assert.ok(all.length > 0, '日志为空')
    const bad = all.filter((r) => aw.AUDIT_REQUIRED_FIELDS.some((k) => !(k in r)))
    assert.deepEqual(
      bad.map((r) => `${r.action}:${aw.AUDIT_REQUIRED_FIELDS.filter((k) => !(k in r)).join('+')}`),
      [],
      '存在缺字段的行',
    )
  })

  test('五个入口写出来的行形态只有一种（重构前是三种）', () => {
    const shape = (r) =>
      `${r.seq ? 'seq' : '无seq'}/${aw.AUDIT_REQUIRED_FIELDS.every((k) => k in r) ? '7/7' : '残行'}`
    const all = rows()
    const shapes = new Set(all.map(shape))
    assert.deepEqual([...shapes], ['seq/7/7'], `形态未收敛：${[...shapes].join(' , ')}`)
  })
})
