#!/usr/bin/env node
/**
 * 损害面守卫（2026-11-01，红队渗透后补）
 *
 * 威胁模型不是"有人攻击这个插件"（本地单用户，攻击者本就能改任何文件），
 * 而是**插件会不会把用户的机器/数据弄坏**。以下三条都是实测抓到的真事：
 *
 *   · A2 每次会话启动都无条件删 `%TEMP%` 根下 `focus-guard-*`，连不是它写的也删；
 *   · A3 卷宗重写时把用户在【三】/【四】附近手写的内容整段吃掉；
 *   · R3 上限淘汰只保护当前 sid，505 个新文件就能删掉别人的活会话状态。
 *
 * 每条只留**一条能红的路径**（不堆用例）：这三件事只要再发生一次，就该有人知道。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = mkdtempSync(join(tmpdir(), 'fg-damage-'))
process.env.FG_AUDIT_FILE = join(base, 'AUDIT.log')

const { cleanStaleTemp, saveState, saveCaseRecords, saveLedger } = await import('../src/core/state.mjs')
const { CASE_TEMPLATE } = await import('../src/core/constants.mjs')

test('A2：旧平铺位置只清一次，第二次不碰别人的文件', () => {
  const fakeTmp = join(base, 'tmp')
  mkdirSync(fakeTmp, { recursive: true })
  delete process.env.FG_STATE_DIR
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = fakeTmp
  try {
    const victim = join(fakeTmp, 'focus-guard-notes.json')
    writeFileSync(victim, '{}')
    cleanStaleTemp('a2') // 首次迁移：清一次
    assert.equal(existsSync(victim), false, '首次迁移应清掉旧平铺位置')

    writeFileSync(victim, '{}')
    cleanStaleTemp('a2') // 之后永不再扫
    assert.equal(existsSync(victim), true, '迁移标记之后不得再删 tmpdir 根的文件')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('A3：卷宗重写不得吃掉用户在【三】/【四】手写的内容', () => {
  const proj = join(base, 'proj')
  mkdirSync(join(proj, '.ai'), { recursive: true })
  const file = join(proj, '.ai', 'CASE_FILE.md')
  writeFileSync(file, CASE_TEMPLATE.replace('### 【四】', '用户手写的一段\n\n### 【四】') + '\n尾部备注\n')

  saveCaseRecords(proj, { '/a/b.txt': { path: '/a/b.txt', readAt: Date.now(), mtime: 1, size: 2, sha: 'x' } })
  saveLedger(proj, { taskBudget: 10, effectiveCalls: 2 })

  const after = readFileSync(file, 'utf8')
  assert.match(after, /用户手写的一段/, '【三】【四】之间的用户内容被删了')
  assert.match(after, /尾部备注/, '【四】之后的用户内容被删了')
  assert.match(after, /\/a\/b\.txt/, '表格本身还得照常写')
})

test('A1：备份走白名单——源码备份，密钥与未知类型跳过', async () => {
  const { backupBeforeEdit } = await import('../src/core/backup.mjs')
  const proj = join(base, 'bproj')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'app.js'), 'x')
  writeFileSync(join(proj, 'credentials.json'), '{"k":"secret"}')
  writeFileSync(join(proj, 'blob.xyz'), 'x')

  backupBeforeEdit(join(proj, 'app.js'), proj)
  backupBeforeEdit(join(proj, 'credentials.json'), proj)
  backupBeforeEdit(join(proj, 'blob.xyz'), proj)

  const names = readdirSync(join(proj, '.ai', 'backup'), { recursive: true })
    .map(String)
    .filter((n) => n.endsWith('.bak'))
  assert.ok(names.some((n) => n.includes('app.js')), '源码应照常备份')
  assert.ok(!names.some((n) => n.includes('credentials')), 'credentials.json 不得落明文副本')
  assert.ok(!names.some((n) => n.includes('blob')), '白名单外类型应跳过')
  assert.equal(existsSync(join(proj, '.ai', '.gitignore')), true, '应落 .ai/.gitignore 防止副本入库')
})

test('R3：上限淘汰不得删掉 1 小时内写过的活会话状态', () => {
  const d = join(base, 'state')
  mkdirSync(d, { recursive: true })
  process.env.FG_STATE_DIR = d
  const victim = join(d, 'focus-guard-victim.json')
  saveState(victim, { fused: true })
  const past = (Date.now() - 60e3) / 1000
  utimesSync(victim, past, past) // 1 分钟前：没过期，可能还活着

  for (let i = 0; i < 505; i++) writeFileSync(join(d, `focus-guard-x${i}.json`), '{}')
  saveState(join(d, 'focus-guard-self.json'), { fused: false })
  cleanStaleTemp('self')

  assert.equal(existsSync(victim), true, '活会话状态被上限淘汰删掉了')
  rmSync(base, { recursive: true, force: true })
})
