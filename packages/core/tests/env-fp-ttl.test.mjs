/**
 * 环境指纹的保质期（2026-11-08）。
 *
 * 起因：`.ai/env-fingerprint.json` 停在 2026-10-08，31 天没动过。
 * 生成函数原先只有「不存在才生成」（`if (existsSync(fp)) return`），生成一次即永久冻结。
 * 而这份文件不只是留痕：`hardCheck.mjs` 第 1.5 层的命令映射（`grep→rg` / `find→fd`）
 * **直接读它**。环境变了而规则表不变 → 同一条命令「这边拦、那边放」，且没有任何信号。
 *
 * 本文件只锁一条：过期 / 坏掉的指纹必须被判为「该重探」，不许当成有效规则表继续用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envFpStale, ENV_FP_TTL_MS } from '../src/dsh/seams/session-start.mjs'

const NOW = Date.parse('2026-11-08T12:00:00Z')

function withFp(content) {
  const dir = mkdtempSync(join(tmpdir(), 'fg-envfp-'))
  const p = join(dir, 'env-fingerprint.json')
  writeFileSync(p, content)
  return { p, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('环境指纹保质期', async (t) => {
  await t.test('刚生成的 → 不算过期', () => {
    const { p, done } = withFp(JSON.stringify({ generated_at: new Date(NOW - 3600e3).toISOString() }))
    try {
      assert.equal(envFpStale(p, NOW), false)
    } finally {
      done()
    }
  })

  await t.test('超过 TTL → 判过期（作者机上那份 31 天的就属这条）', () => {
    const { p, done } = withFp(
      JSON.stringify({ generated_at: new Date(NOW - ENV_FP_TTL_MS - 86400e3).toISOString() }),
    )
    try {
      assert.equal(envFpStale(p, NOW), true)
    } finally {
      done()
    }
  })

  await t.test('坏文件 / 缺 generated_at → 判过期，不当作有效规则表', () => {
    const bad = withFp('{ 这不是 json')
    const empty = withFp('{}')
    try {
      assert.equal(envFpStale(bad.p, NOW), true)
      assert.equal(envFpStale(empty.p, NOW), true)
    } finally {
      bad.done()
      empty.done()
    }
  })
})
