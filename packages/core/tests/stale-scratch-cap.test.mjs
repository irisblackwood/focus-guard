// FocusGuard · tmpdir 根临时产物数量兜底（2026-11-16）
//
// 起因：手动跑单个测试（`node --test tests/xxx.mjs`）绕过 `audit-isolation` 的沙箱，
// 而这类测试的文件名带 `pid + Date.now()`，每次都是新名字、跑完必留；`staleCleanup`
// 的原正则只认 `focus-guard-*` 前缀 + `.json`/`-AUDIT.log`/`.tmp` 后缀，`fg-*` + `.log`
// 两条都不匹配——实测堆到 6000+。
//
// 本条锁四件事：超限按 mtime 删最旧 / 1 小时内不碰 / 非 FG 命名不碰 / 目录不动。
// 只写一条用例：这些保护是同一个判据的四个分支，拆开写只是重复证明。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { capScratchRoot } from '../src/core/staleCleanup.mjs'

test('超上限按 mtime 删最旧；1 小时内 / 非 FG 命名 / 目录一律不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-scratch-'))
  // `capScratchRoot` 在沙箱里直接返回 0（整个 tmpdir 都是临时的），测试必须临时摘掉守卫。
  const saved = process.env.FG_STATE_DIR
  delete process.env.FG_STATE_DIR
  try {
    const old = new Date(Date.now() - 2 * 3600e3)
    for (let i = 0; i < 5; i++) {
      const f = join(dir, `fg-old-${i}.log`)
      writeFileSync(f, 'x')
      utimesSync(f, old, old) // 全部拨到 2 小时前，越过 EVICT_FLOOR_MS
    }
    writeFileSync(join(dir, 'fg-fresh.log'), 'x') // 1 小时内 → 不删
    writeFileSync(join(dir, 'notes.txt'), 'x') // 后缀不在白名单 → 不删
    writeFileSync(join(dir, 'other.log'), 'x') // 前缀不是 FG → 不删
    mkdirSync(join(dir, 'fg-dir')) // 目录 → 不动

    const removed = capScratchRoot(dir, 2) // 6 个匹配文件，上限 2 → 删 4
    const left = readdirSync(dir)

    assert.equal(removed, 4, '6 个匹配文件按 cap=2 应删 4 个')
    assert.equal(left.length, 5, '剩 2 个匹配 + fg-fresh + notes.txt + other.log + fg-dir')
    assert.ok(!left.includes('fg-old-0.log'), '最旧的必须被删')
    assert.ok(left.includes('fg-old-4.log'), '最新的老文件应保留')
    assert.ok(left.includes('fg-fresh.log'), '1 小时内写的不许删')
    assert.ok(left.includes('notes.txt'), '后缀不在白名单的不许删')
    assert.ok(left.includes('other.log'), '前缀不是 FG 的不许删')
    assert.ok(left.includes('fg-dir'), '目录不动')
  } finally {
    if (saved === undefined) delete process.env.FG_STATE_DIR
    else process.env.FG_STATE_DIR = saved
    rmSync(dir, { recursive: true, force: true })
  }
})
