#!/usr/bin/env node
/**
 * registry-check（2026-11-26）—— 「registry 上到底有没有这个版本」，一次探测，不等 npm CLI。
 *
 * ## 起因
 *
 * 3.5.2 那次发布总共 4m36s，其中 **Verify 一步 3m04s**（`gh run view` 的步骤耗时），占 67%。
 * 那一步每 20 秒跑一次 `npm view focus-guard@<v>`：npm CLI 每次冷启动，取的是**整份
 * packument**（所有历史版本，几百 KB）；每轮还固定 sleep 20 秒，粗粒度到 3.5.1 那次
 * 「差一秒放弃（10:19:19 放弃，registry 10:19:20 生效）」。
 *
 * ## 但「秒级可读」是错的（2026-11-26 实测推翻自己）
 *
 * 本工具第一版的前提是「版本文档秒级可读，慢的只是 packument 缓存」。实测不成立：
 *
 *   run 45842083164 —— `npm publish` 14:46:14 拿到 201；14:48:13 查 `/focus-guard/3.5.3`
 *   仍是 404，加 `?bust=<时间戳>` 穿透缓存也是 404。**写入已确认、读取滞后两分钟以上**，
 *   这是 npm 官方复制管线的行为，与 2026-11-17 记的「还要过两三分钟」一致。
 *
 * 所以判据换了位置，而不是把窗口放宽：
 *
 *   - **判「发成功」用 201 回执**：`npm publish` 只有在 registry 写入后才打印
 *     `+ pkg@ver`，publish.yml 用它判绿（见那里的 Publish 步）。
 *   - **本工具负责「可读性」这个独立事实**：`--once` 给发布守卫（1~2 秒，不必冷启动 npm），
 *     带窗口的轮询给人事后复核（`release:status`）。
 *   - **不判红**：把 npm 的复制延迟记成自己的失败，就是一条每发一版必红的闸门——
 *     与 `schema:verify`、`lint` 上踩过的同一个坑。要红得起来，只能是 `--strict`。
 *
 * ## 用法
 *
 *   node packages/core/tools/registry-check.mjs                 # 等 90 秒；到点没有则 exit 1
 *   node packages/core/tools/registry-check.mjs --once          # 只探一次（在 → 0 / 不在 → 1）
 *   node packages/core/tools/registry-check.mjs --wait 300      # 自定义窗口（秒）
 *   node packages/core/tools/registry-check.mjs --version 3.5.2 --json
 *   node packages/core/tools/registry-check.mjs --strict        # packument 视图滞后也算失败
 *
 * 版本号默认取 `packages/core/package.json`（单一真源），不在这里另立一份。
 * registry 默认 `https://registry.npmjs.org`，可用 `FG_NPM_REGISTRY` 覆盖（镜像/内网源）。
 *
 * 退出码：0 已在；1 窗口内没等到（或 `--once` 时不存在）；2 参数错误 / 网络不可用。
 * 1 与 2 必须分开：前者是「还没发出去」，后者是「查不了」——发布守卫靠这个区别决定
 * 是继续发还是停下（查不了就发，会撞 npm 的 EEXISTS 红）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')

/** 轮询节奏（毫秒）：新版本文档通常 10 秒内可读，前几圈贴紧；之后退到 10 秒，不做请求洪流。 */
export function nextDelay(attempt) {
  return [1000, 2000, 3000, 5000, 8000, 10000][Math.min(attempt, 5)]
}

/** 源地址：`FG_NPM_REGISTRY` > 用户 npm 配置 > 官方。末尾斜杠去掉，避免拼出 `//`。 */
export function registryBase(env = process.env) {
  const raw = env.FG_NPM_REGISTRY || env.npm_config_registry || 'https://registry.npmjs.org'
  return String(raw).replace(/\/+$/, '')
}

/** 一次 GET，只关心「有 / 没有 / 查不了」三种结果，不关心响应体大小。 */
async function getJson(url, accept = 'application/json') {
  const res = await fetch(url, { cache: 'no-store', headers: { accept } })
  if (res.status === 404) return { state: 'absent', status: 404 }
  if (!res.ok) return { state: 'error', status: res.status }
  return { state: 'ok', status: res.status, body: await res.json() }
}

/** 版本文档：存在即「registry 收下了这个版本」，这是发布的判据。 */
export async function probeVersion(base, name, version) {
  const r = await getJson(`${base}/${name}/${version}`)
  if (r.state !== 'ok') return r
  const body = r.body || {}
  if (body.version !== version) return { state: 'absent', status: r.status, detail: `版本文档写的是 ${body.version}` }
  return { state: 'present', status: r.status, tarball: body.dist?.tarball || null, shasum: body.dist?.shasum || null }
}

/** packument 视图：`npm view` 读的就是它。慢半拍属正常，默认只观察。 */
export async function probePackument(base, name, version) {
  // 缩略 packument（npm 自己安装时用的那份）：比全量小一个数量级，判定等价。
  const r = await getJson(`${base}/${name}`, 'application/vnd.npm.install-v1+json')
  if (r.state !== 'ok') return r
  const body = r.body || {}
  return { state: body.versions && body.versions[version] ? 'present' : 'absent', latest: body['dist-tags']?.latest || null }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 仓库里的版本：真源是 `packages/core/package.json`，与 release.mjs 同一处。 */
function localVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8')).version
  } catch {
    return null
  }
}

function parseArgs(argv) {
  const opt = (flag, fallback) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
  }
  return {
    name: opt('--name', 'focus-guard'),
    version: opt('--version', null),
    wait: Number(opt('--wait', argv.includes('--once') ? '0' : '90')),
    packumentWait: Number(opt('--packument-wait', '30')),
    json: argv.includes('--json'),
    once: argv.includes('--once'),
    strict: argv.includes('--strict'),
  }
}

/** 等版本文档出现；到点仍 absent 返回最后一次探测结果（不抛）。 */
async function waitForVersion(base, name, version, waitSec) {
  const started = Date.now()
  let last = { state: 'absent', status: 0 }
  for (let attempt = 0; ; attempt += 1) {
    try {
      last = await probeVersion(base, name, version)
    } catch (err) {
      last = { state: 'error', status: 0, detail: err.message }
    }
    if (last.state === 'present' || waitSec <= 0) return { ...last, elapsed: Date.now() - started }
    const spent = (Date.now() - started) / 1000
    if (spent >= waitSec) return { ...last, elapsed: Date.now() - started }
    await sleep(nextDelay(attempt))
  }
}

/** packument 视图追赶：只等一小段，追不上就如实说（`--strict` 时才判红）。 */
async function waitForPackument(base, name, version, waitSec) {
  const started = Date.now()
  let last = { state: 'absent' }
  for (let attempt = 0; ; attempt += 1) {
    try {
      last = await probePackument(base, name, version)
    } catch (err) {
      last = { state: 'error', detail: err.message }
    }
    if (last.state !== 'absent') return { ...last, elapsed: Date.now() - started }
    if ((Date.now() - started) / 1000 >= waitSec) return { ...last, elapsed: Date.now() - started }
    await sleep(nextDelay(attempt))
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const version = opts.version || localVersion()
  if (!version) {
    console.error('[registry] 读不到版本：用 --version 指定，或确认 packages/core/package.json 存在')
    return 2
  }
  if (!Number.isFinite(opts.wait) || opts.wait < 0) {
    console.error(`[registry] --wait 需要非负秒数，收到 ${opts.wait}`)
    return 2
  }

  const base = registryBase()
  const hit = await waitForVersion(base, opts.name, version, opts.wait)

  if (opts.json) {
    const packument = hit.state === 'present' && !opts.once ? await waitForPackument(base, opts.name, version, opts.packumentWait) : null
    console.log(JSON.stringify({ name: opts.name, version, registry: base, versionDoc: hit, packument }, null, 2))
    if (hit.state === 'present') return 0
    return hit.state === 'error' ? 2 : 1
  }

  if (hit.state === 'present') {
    const secs = (hit.elapsed / 1000).toFixed(1)
    console.log(`[registry] ${opts.name}@${version} 已在 registry（版本文档 200，${secs}s）`)
    if (hit.tarball) console.log(`[registry] tarball：${hit.tarball}`)
    if (!opts.once) {
      const pk = await waitForPackument(base, opts.name, version, opts.packumentWait)
      if (pk.state === 'present') console.log(`[registry] packument 视图已含该版本（${(pk.elapsed / 1000).toFixed(1)}s，npm view 读得到）`)
      else {
        // 观察项：视图滞后是 CDN 的事，包本身已经发出去了。永久红会训练人忽略告警。
        const tail = opts.strict ? '按 --strict 判失败' : '不判失败（--strict 可要求视图同步）'
        console.log(`[registry] packument 视图尚未含该版本（latest=${pk.latest ?? '?'}）：${tail}`)
        if (opts.strict) return 1
      }
    }
    return 0
  }

  if (hit.state === 'error') {
    console.error(`[registry] 探测失败（${hit.detail || `HTTP ${hit.status}`}）：查不了，不等于没发出去`)
    return 2
  }
  const detail = hit.detail || `HTTP ${hit.status}`
  const where = opts.wait > 0 ? `${opts.wait}s 内` : '本次探测中'
  console.error(`[registry] ${opts.name}@${version} ${where}未出现在 ${base}（${detail}）`)
  return 1
}

// 只在直接执行时跑：`release.mjs --status` 要 import 这里的探测函数，不能顺手跑一遍 main。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
