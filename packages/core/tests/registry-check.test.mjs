/**
 * registry-check 的边界（2026-11-26）。
 *
 * 为什么要测：`publish.yml` 的守卫**按退出码分流**——0 有 / 1 没有 / 2 查不了。
 * 这三个码分不开，就只有两种结局：明明没发过却跳过发布（假绿），或者网络抖一下就当「没发过」
 * 直接 publish、撞 npm 的 EEXISTS 红。所以这里锁的是**退出码契约**，不是「工具能跑」。
 *
 * 不起外网：本地起一个 http 服务当 registry，用 `FG_NPM_REGISTRY` 指过去——与
 * `FG_REPO_ROOT` 同一思路（测试必须能把被测对象指到别处）。
 *
 * 用异步 `execFile` 而不是 `spawnSync`：同步执行会堵死事件循环，本地那个 http 服务
 * 连请求都收不到，于是「服务端 500」这条用例永远测不出来（只会看到超时）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nextDelay, registryBase, probeVersion, probePackument } from '../tools/registry-check.mjs'

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '../tools/registry-check.mjs')
const run = promisify(execFile)

/** 起一个假 registry：`routes` 是 `路径 → [状态码, 响应体]`。 */
async function fakeRegistry(routes) {
  const server = createServer((req, res) => {
    const hit = routes[req.url]
    if (!hit) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"Not found"}')
      return
    }
    res.writeHead(hit[0], { 'content-type': 'application/json' })
    res.end(JSON.stringify(hit[1]))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => new Promise((done) => server.close(done)) }
}

/** 跑一次 CLI，返回退出码（不因非零退出而抛）。 */
async function cli(args, env) {
  try {
    const r = await run('node', [TOOL, ...args], { env: { ...process.env, ...env } })
    return { code: 0, out: r.stdout, err: r.stderr }
  } catch (err) {
    return { code: err.code, out: err.stdout || '', err: err.stderr || '' }
  }
}

// ───────────────────────── 纯函数：节奏与源地址 ─────────────────────────

test('轮询节奏：前几圈贴紧、之后封顶，不会退化成 20 秒一跳', () => {
  const seq = [0, 1, 2, 3, 4, 5, 12].map(nextDelay)
  assert.deepEqual(seq, [1000, 2000, 3000, 5000, 8000, 10000, 10000])
  for (let i = 1; i < seq.length; i += 1) assert.ok(seq[i] >= seq[i - 1], '间隔不得变短')
})

test('源地址：FG_NPM_REGISTRY 优先，末尾斜杠去掉（否则拼出 //）', () => {
  assert.equal(registryBase({ FG_NPM_REGISTRY: 'https://mirror.example/npm/' }), 'https://mirror.example/npm')
  assert.equal(registryBase({ npm_config_registry: 'http://127.0.0.1:1/' }), 'http://127.0.0.1:1')
  assert.equal(registryBase({}), 'https://registry.npmjs.org')
})

// ───────────────────────── 探测：三种状态必须分开 ─────────────────────────

test('probeVersion：版本文档在 → present，带 tarball', async () => {
  const reg = await fakeRegistry({ '/pkg/1.2.3': [200, { version: '1.2.3', dist: { tarball: 'https://x/pkg-1.2.3.tgz' } }] })
  try {
    const r = await probeVersion(reg.base, 'pkg', '1.2.3')
    assert.equal(r.state, 'present')
    assert.equal(r.tarball, 'https://x/pkg-1.2.3.tgz')
  } finally {
    await reg.close()
  }
})

test('probeVersion：404 是 absent，500 是 error——两者绝不能混', async () => {
  const reg = await fakeRegistry({ '/pkg/9.9.9': [500, { error: 'boom' }] })
  try {
    assert.equal((await probeVersion(reg.base, 'pkg', '1.2.3')).state, 'absent')
    assert.equal((await probeVersion(reg.base, 'pkg', '9.9.9')).state, 'error')
  } finally {
    await reg.close()
  }
})

test('probeVersion：文档里的版本对不上（镜像串号）算 absent，不算 present', async () => {
  const reg = await fakeRegistry({ '/pkg/1.2.3': [200, { version: '1.2.2' }] })
  try {
    assert.equal((await probeVersion(reg.base, 'pkg', '1.2.3')).state, 'absent')
  } finally {
    await reg.close()
  }
})

test('probePackument：缩略文档里有这个版本才算 present；latest 单独给出', async () => {
  const reg = await fakeRegistry({ '/pkg': [200, { versions: { '1.2.3': {} }, 'dist-tags': { latest: '1.2.3' } }] })
  try {
    const r = await probePackument(reg.base, 'pkg', '1.2.3')
    assert.equal(r.state, 'present')
    assert.equal(r.latest, '1.2.3')
    assert.equal((await probePackument(reg.base, 'pkg', '1.2.4')).state, 'absent')
  } finally {
    await reg.close()
  }
})

// ───────────────────────── 退出码契约（发布守卫靠它分流） ─────────────────────────

test('CLI：--once 时「在 → 0 / 不在 → 1 / 查不了 → 2」，三者互不覆盖', async () => {
  const reg = await fakeRegistry({
    '/pkg/1.2.3': [200, { version: '1.2.3' }],
    '/pkg/9.9.9': [500, { error: 'boom' }],
  })
  try {
    const env = { FG_NPM_REGISTRY: reg.base }
    assert.equal((await cli(['--once', '--name', 'pkg', '--version', '1.2.3'], env)).code, 0)
    assert.equal((await cli(['--once', '--name', 'pkg', '--version', '1.2.4'], env)).code, 1)
    assert.equal((await cli(['--once', '--name', 'pkg', '--version', '9.9.9'], env)).code, 2)
  } finally {
    await reg.close()
  }
})

test('CLI：--wait 收到负数直接拒绝（不猜、不静默当 0）', async () => {
  const r = await cli(['--version', '1.2.3', '--wait', '-1'])
  assert.equal(r.code, 2)
  assert.match(r.err, /--wait/)
})

test('CLI：窗口耗尽后 exit 1，且把等待轮数写进输出（别让人以为工具没转）', async () => {
  const reg = await fakeRegistry({})
  try {
    const r = await cli(['--version', '1.2.3', '--wait', '2'], { FG_NPM_REGISTRY: reg.base })
    assert.equal(r.code, 1)
    assert.match(r.err, /2s 内未出现/)
  } finally {
    await reg.close()
  }
})
