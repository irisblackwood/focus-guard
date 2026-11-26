#!/usr/bin/env node
/**
 * release（2026-11-26）—— 发版单一入口：检查 → 打标签 → 建 Release →（工作流）发 npm。
 *
 * ## 起因
 *
 * 3.5.3 推到 GitHub 之后，tag 停在 `v3.5.2`、Release 没有、npm 也停在 3.5.2。
 * 链路本身是通的（`.github/workflows/publish.yml` 由 `release: published` 触发，
 * OIDC 受信发布 + provenance），**断在没人去做那三步**：仓库里连一条 `release:*`
 * 脚本都没有，全靠人记。人记的事就会漏，漏了还不会有任何闸门报红。
 *
 * ## 四个阶段，各有判据
 *
 * | 阶段 | 命令 | 判据 |
 * |---|---|---|
 * | 检查 | `npm run release` | 版本面一致 / CHANGELOG 有段 / `PUBLISHED_MAX` 等于上一发 / 工作区干净且与远端齐 / tag 不存在 / 文档 ack 新鲜 |
 * | 发版 | `npm run release -- --go` | 建附注标签 + 推 tag + `gh release create`（正文取 CHANGELOG 该段） |
 * | 回写 | `npm run release:sync` | 把 `PUBLISHED_MAX` 改成新版本，并列出仍需人工改的文案 |
 * | 核对 | `npm run release:status` | tag / Release / registry / 工作流四面各一个真值，8 秒给结论 |
 *
 * ## 为什么 `--status` 是独立的第四步
 *
 * `--go` 跑完就结束，不管 `publish.yml` 要跑多久。以前最后一句是「应已在跑：gh run list …」，
 * 等于把人晾在 Actions 页面上——而 3.5.2 那次整体 4m36s，其中 **3m04s 只是确认步骤在等 CDN**。
 * 「发了没」本该是一秒钟能答的问题，所以拆成一条随时可跑、只读、不打乱工作区的核对命令：
 * 发版结束后什么时候想起就什么时候问，不用守着页面，也不用重跑那 7 项前置检查
 * （那时 `release:sync` 刚改过常量，工作区本来就不干净）。
 *
 * ## 为什么默认 dry-run
 *
 * 发版是**不可撤销**的公开动作：npm 版本推上去基本收不回，Release 通知会发到 watcher。
 * 检查是只读的，所以默认只检查；`--go` 要人显式打，且检查不全绿就拒绝执行。
 *
 * ## 为什么 `PUBLISHED_MAX` 要单独回写
 *
 * 它是「已分发最高版」的唯一真值（`changelog-audience.test.mjs:34`），`docs-lint` 的
 * `version-claim-stale`、`version-face-stale` 两条规则都读它。发完版不改它，第二天
 * 所有「当前版本」断言都会指向旧号——而且**没人会报红**，因为闸门拿旧号当真值比对。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { checkAckFreshness } from './lib/docs-ack.mjs'
// 发完之后「到底发出去没」的判据与 publish.yml 的 Verify 是同一段代码——
// 两处各写一份，迟早一个说发了一个说没发（本仓在审计日志上踩过同类）。
import { probeVersion, registryBase } from './registry-check.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const argv = process.argv.slice(2)
const GO = argv.includes('--go')
const SYNC = argv.includes('--sync')
const STATUS = argv.includes('--status')
const OFFLINE = argv.includes('--offline')
const NOTE = (() => {
  const i = argv.indexOf('--note')
  return i >= 0 ? argv[i + 1] : null
})()

// `stdio: 'inherit'` 时 execFileSync 返回 null（不捕 stdout），别对 null 调 trim——
// 2026-11-26 首次 `--go` 就栽在这里：tag 推成功了，脚本在下一步崩掉，Release 没建。
const git = (args, opts = {}) => (execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts }) || '').trim()
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** 版本面：三份清单 + 引擎常量。少一处就会「装上去的号」与「跑起来的号」不一致。 */
function versionFaces() {
  const pkg = (rel) => JSON.parse(read(rel)).version
  const engine = (read('packages/core/src/core/constants.mjs').match(/ENGINE_VERSION\s*=\s*["']([^"']+)["']/) || [])[1]
  return {
    'package.json': pkg('package.json'),
    'packages/core/package.json': pkg('packages/core/package.json'),
    'packages/extended/package.json': pkg('packages/extended/package.json'),
    ENGINE_VERSION: engine || '(未找到)',
  }
}

/** 已分发最高版：唯一真值在测试常量里，别在这里另立一份。 */
function publishedMax() {
  const m = read('packages/core/tests/changelog-audience.test.mjs').match(/PUBLISHED_MAX\s*=\s*["']([^"']+)["']/)
  return m ? m[1] : null
}

/** 取 CHANGELOG 该版本的整段正文（release notes 直接用，不另写一份）。 */
function changelogSection(version) {
  const lines = read('CHANGELOG.md').split(/\r?\n/)
  const start = lines.findIndex((l) => new RegExp(`^## ${version.replace(/\./g, '\\.')} · `).test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i
      break
    }
  }
  return { title: lines[start], body: lines.slice(start + 1, end).join('\n').trim() }
}

const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  return 0
}

// ── `--status`：发完之后的四个真值 ──
// 为什么要有它：`--go` 建完 Release 就把人晾在 Actions 页面上等两三分钟，而「发了没」
// 本来是一秒钟能答的问题（见 registry-check.mjs 的文件头：3.5.2 那次 Verify 占 3m04s/4m36s）。
// 四面各自一个独立真值，缺哪面就点名哪面——而不是让人从四张页面里自己拼。

/** 包名：探 registry 用，与版本同源（`packages/core/package.json`）。 */
function packageName() {
  return JSON.parse(read('packages/core/package.json')).name
}

/** 最近一次针对该 tag 的 publish 运行；没装 gh / 未登录 / 从没跑过都返回 null。 */
function publishRun(tag, sinceMs = 0) {
  try {
    const out = execFileSync('gh', ['run', 'list', '--workflow=publish.yml', '--limit', '20', '--json', 'displayTitle,headBranch,status,conclusion,url,createdAt'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    // gh 按时间倒序；`sinceMs` 用来排除同一 tag 的历史运行（失败重跑时最容易被误当成「刚触发的」）。
    const fresh = (r) => !sinceMs || Date.now() - new Date(r.createdAt).getTime() <= sinceMs
    return JSON.parse(out).find((r) => ((r.displayTitle || '').includes(tag) || r.headBranch === tag) && fresh(r)) || null
  } catch {
    return null
  }
}

/** GitHub 面：tag 在不在、本地与远端是否同一个、是否指向 HEAD；Release 是否已建。 */
function githubFace(tag) {
  const tryGit = (args) => {
    try {
      return git(args)
    } catch {
      return null
    }
  }
  const head = tryGit(['rev-parse', 'HEAD'])
  const local = tryGit(['rev-parse', `refs/tags/${tag}`])
  const commit = tryGit(['rev-parse', `refs/tags/${tag}^{commit}`])
  const remote = (() => {
    const all = tryGit(['ls-remote', '--tags', 'origin'])
    if (!all) return null
    const line = all.split('\n').find((l) => l.endsWith(`refs/tags/${tag}`))
    return line ? line.split(/\s+/)[0] : null
  })()
  let release = null
  try {
    // 不用 `--json isLatest`：gh 的字段随版本增减，2.6x 上根本没有它（实测报 Unknown JSON field）。
    // 「是不是 Latest」另走一个权威口：`releases/latest`，那是 GitHub 自己认的那一个。
    release = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--json', 'tagName,createdAt,isDraft,isPrerelease'], { cwd: ROOT, encoding: 'utf8' }))
    // `gh api` 返回的是**原始** API 字段（snake_case），与 `gh release view --json` 的驼峰不同；
    // 且本机 gh 的 `--jq` 输出为空（实测只有换行），所以自己解析、认 `tag_name`。
    const latest = JSON.parse(execFileSync('gh', ['api', 'repos/{owner}/{repo}/releases/latest'], { cwd: ROOT, encoding: 'utf8' }))
    release.isLatest = latest?.tag_name === tag
  } catch {
    release = null
  }
  return { head, local, commit, remote, atHead: Boolean(commit && head && commit === head), release }
}

const mark = (ok) => (ok ? '✅' : '❌')

async function productStatus(version, tag) {
  // 先把 registry 探测发出去（异步），再跑几个 execFileSync 的活——它们的等待正好被 fetch 用掉。
  const registryProbe = probeVersion(registryBase(), packageName(), version).catch((err) => ({ state: 'error', detail: err.message }))
  const gh = githubFace(tag)
  const run = publishRun(tag)
  const registry = await registryProbe
  const published = registry.state === 'present'
  // 「tag 合格」只要求**本地与远端是同一个对象**。是否指向 HEAD 单独说：
  // 发完之后必然还要回填 README / `PUBLISHED_MAX` 那几处（政策 §四 第 8 步），
  // 于是 tag 正常会落后 HEAD 一两个提交——把它算成 ❌，等于每发一版就留一条假红。
  const tagOk = Boolean(gh.local && gh.remote && gh.local === gh.remote)
  const lines = []
  lines.push(`  tag      ${mark(tagOk)} ${tag}${tagOk ? '（本地＝远端）' : ''}`)
  if (!tagOk) {
    if (!gh.local) lines.push('           本地没有这个 tag')
    else if (!gh.remote) lines.push(`           远端没有这个 tag——\`git push origin ${tag}\``)
    else lines.push('           远端与本地不是同一个对象——同版本不重打，先确认该保留哪个')
  } else if (gh.commit && !gh.atHead) {
    lines.push(`           ℹ tag 指向 ${String(gh.commit).slice(0, 7)}，HEAD 是 ${String(gh.head).slice(0, 7)}（发布后回填文档属正常）`)
  }
  lines.push(`  Release  ${mark(Boolean(gh.release))} ${gh.release ? `${gh.release.tagName}${gh.release.isLatest ? '（Latest）' : ''}` : '没有'}`)
  lines.push(
    `  registry ${mark(published)} ${
      published ? `${version} 已发布（${(registry.elapsed / 1000).toFixed(1)}s 读到版本文档）` : registry.state === 'error' ? `查不了（${registry.detail}）` : `未见 ${version}`
    }`,
  )
  lines.push(
    `  workflow ${run ? `${mark(run.conclusion === 'success')} ${run.status === 'completed' ? run.conclusion : run.status} · ${run.url}` : '（没有 gh 或没跑过——跳过）'}`,
  )
  let verdict
  if (published && gh.release && tagOk) verdict = '已发布：tag / Release / npm 三面齐平'
  else if (published) verdict = 'npm 上有了，但 GitHub 面不齐——按上面 ❌ 补'
  else if (run && run.status !== 'completed') verdict = `发布中（${run.status}），不用守着：稍后重跑本命令`
  else if (run && run.conclusion === 'failure') verdict = '未发布：工作流失败，先看日志再重跑'
  else verdict = '未发布：还没有 publish 运行'
  return { lines, verdict, published, tagOk }
}

// ── 检查 ──
const faces = versionFaces()
const version = faces['packages/core/package.json']
const tag = `v${version}`
const published = publishedMax()
const section = changelogSection(version)
const ok = []
const bad = []

// `--status` 只读产物面，不跑那 7 项前置检查：它是发完之后回头核对的命令，
// 那时工作区多半已经不干净（`release:sync` 刚改过常量），用检查项挡人等于逼人去开浏览器。
if (STATUS) {
  const status = await productStatus(version, tag)
  console.log(`[release] 产物面 ${version}（真源 packages/core/package.json）`)
  for (const line of status.lines) console.log(line)
  console.log(`  结论     ${status.verdict}`)
  process.exit(status.published && status.tagOk ? 0 : 1)
}

const facesSame = Object.values(faces).every((v) => v === version)
if (facesSame) ok.push(`版本面一致：${version}（3 份清单 + ENGINE_VERSION）`)
else bad.push(`版本面不一致：${Object.entries(faces).map(([k, v]) => `${k}=${v}`).join(' / ')}`)

if (section) ok.push(`CHANGELOG 有 ${version} 段：${section.title}`)
else bad.push(`CHANGELOG 缺 \`## ${version} · <日期>\` 段——发出去的版本在记录里不存在`)

// 已发布常量应停在**上一个**版本：等于当前版本说明 tag 早该存在；低于上一个 tag 说明漏回写。
if (!published) bad.push('读不到 PUBLISHED_MAX（changelog-audience.test.mjs）')
else if (published === version) bad.push(`PUBLISHED_MAX 已是 ${version}：要么早发过（tag 应存在），要么常量提前改了`)
else ok.push(`PUBLISHED_MAX = ${published}（上一个已发布版本，符合预期）`)

const tagExists = (() => {
  try {
    git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`])
    return true
  } catch {
    return false
  }
})()
// 续跑而不是重打：tag 已在且指向当前 HEAD 时，只剩 Release 没建（或建失败）。
// 政策原文就写了「漏了 Release 也能补建」，脚本没理由逼人先删标签。
const tagAtHead = tagExists && git(['rev-list', '-n', '1', tag]) === git(['rev-parse', 'HEAD'])
if (tagExists && tagAtHead) ok.push(`tag ${tag} 已存在且指向 HEAD——本次只补 Release，不重打标签`)
else if (tagExists) bad.push(`tag ${tag} 已存在但不在 HEAD——同一版本不重打；确要重打先 \`git tag -d ${tag}\` 并删远端`)
else ok.push(`tag ${tag} 不存在（可以打）`)

const dirty = git(['status', '--porcelain'])
if (dirty) bad.push(`工作区不干净：\n${dirty.split('\n').slice(0, 8).join('\n')}`)
else ok.push('工作区干净')

try {
  const behind = Number(git(['rev-list', '--count', '@{u}..HEAD']))
  if (behind === 0) ok.push('与上游同步（没有未推送的提交）')
  else bad.push(`有 ${behind} 个提交未推送——先推再发，否则 tag 指不到公开的树`)
} catch {
  bad.push('当前分支没有上游——先 `git push -u origin <branch>`')
}

const ack = checkAckFreshness(ROOT)
if (ack.length) bad.push(`文档状态头过期 ${ack.length} 条：\n${ack.slice(0, 5).map((f) => `  ${f.file}: ${f.detail}`).join('\n')}`)
else ok.push('文档状态头新鲜（权威文档的最后核对都不早于最后提交）')

if (!OFFLINE) {
  try {
    const exists = execFileSync('npm', ['view', `focus-guard@${version}`, 'version'], { cwd: ROOT, encoding: 'utf8' }).trim()
    if (exists === version) bad.push(`registry 已有 focus-guard@${version}——重发会被 npm 拒绝`)
    else ok.push(`registry 上没有 ${version}（可以发）`)
  } catch {
    ok.push(`registry 上没有 ${version}（可以发）`)
  }
}

// ── 回写：发版之后 ──
if (SYNC) {
  const target = 'packages/core/tests/changelog-audience.test.mjs'
  const text = read(target)
  if (!published) {
    console.error('[release] 读不到 PUBLISHED_MAX，无法回写')
    process.exit(2)
  }
  if (cmp(published, version) >= 0) {
    console.log(`[release] PUBLISHED_MAX 已是 ${published}（≥ ${version}），无需回写。`)
  } else {
    writeFileSync(join(ROOT, target), text.replace(/(PUBLISHED_MAX\s*=\s*["'])[^"']+(["'])/, `$1${version}$2`))
    console.log(`[release] PUBLISHED_MAX：${published} → ${version}`)
  }
  // 文案里的旧号不自动改：写成「已发 3.5.2」还是「当前 3.5.2」要看句子，机器判断不了。
  const stale = []
  for (const rel of ['README.md', 'INSTALL.md', 'packages/core/docs/ARCH-MAP.md', 'packages/core/docs/RELEASE-POLICY.md']) {
    read(rel)
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (line.includes(published)) stale.push(`${rel}:${i + 1}\t${line.trim().slice(0, 90)}`)
      })
  }
  if (stale.length) {
    console.log(`\n[release] 以下 ${stale.length} 处仍写着旧号 ${published}，需人工判断该改成 ${version} 还是保留为历史：`)
    for (const s of stale) console.log(`  ${s}`)
  }
  console.log('\n[release] 改完跑 `npm run gate:fast`；`docs:lint` 会用新常量重算所有版本面。')
  process.exit(0)
}

// ── 输出 ──
console.log(`[release] 树里版本 ${version}；已分发最高 ${published ?? '(未读到)'}；目标 tag ${tag}`)
for (const line of ok) console.log(`  ✅ ${line}`)
for (const line of bad) console.log(`  ❌ ${line}`)

if (bad.length) {
  console.log(`\n[release] ${bad.length} 项未通过，未做任何改动。`)
  process.exit(1)
}

const note = NOTE || `v${version} · ${new Date().toISOString().slice(0, 10)}：见 CHANGELOG 段`
console.log('\n[release] 将要执行（--go 才真做）：')
console.log(`  git tag -a ${tag} -m "${note}"`)
console.log(`  git push origin ${tag}`)
console.log(`  gh release create ${tag} --title "${tag}" --notes-file <CHANGELOG 该段>`)
console.log('  随后 GitHub Actions `publish.yml` 由 release:published 触发 → npm publish（OIDC + provenance）')

if (!GO) {
  console.log('\n[release] 这是 dry-run。确认无误后：npm run release -- --go')
  process.exit(0)
}

if (tagAtHead) {
  console.log(`[release] 跳过打标签：${tag} 已在 HEAD`)
} else {
  git(['tag', '-a', tag, '-m', note])
  console.log(`[release] 已建标签 ${tag}`)
  git(['push', 'origin', tag], { stdio: 'inherit' })
  console.log(`[release] 已推送 ${tag}`)
}

const notesFile = join(tmpdir(), `fg-release-${version}.md`)
writeFileSync(notesFile, `${section.body}\n`)
// Release 也可能已经存在（上次 `create` 失败、或补建历史版本）：那就只更新正文，不重建。
const releaseExists = (() => {
  try {
    execFileSync('gh', ['release', 'view', tag], { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
if (releaseExists) {
  execFileSync('gh', ['release', 'edit', tag, '--notes-file', notesFile], { cwd: ROOT, stdio: 'inherit' })
  console.log(`[release] Release ${tag} 已存在，正文已刷新`)
} else {
  execFileSync('gh', ['release', 'create', tag, '--title', `${tag} · ${new Date().toISOString().slice(0, 10)}`, '--notes-file', notesFile], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  console.log(`[release] 已建 Release ${tag}`)
}
// 补建历史版本时，`gh release create` 会把最后创建的那个标成 Latest——所以每次显式钉一次。
execFileSync('gh', ['release', 'edit', tag, '--latest'], { cwd: ROOT, stdio: 'inherit' })
console.log(`[release] 已钉 Latest`)

// 2026-11-26：**不在这里等发布跑完**。以前最后一句是「应已在跑：gh run list …」，等于把人
// 晾在 Actions 页面上——而 3.5.2 那次整体 4m36s，其中 3m04s 只是确认步骤在等 CDN 缓存。
// 现在只把 run 的地址交出来（3~8 秒就能拿到），结论用 `--status` 一秒查。
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let run = null
for (let i = 0; i < 10 && !run; i += 1) {
  run = publishRun(tag, 5 * 60 * 1000)
  if (!run) await sleep(2000)
}
if (run) console.log(`[release] publish.yml 已触发：${run.url}\n          结论：npm run release:status（不用守页面）`)
else console.log('[release] publish.yml 尚未出现在运行列表——稍后用 npm run release:status 查')
console.log('[release] 发完记得回写：npm run release:sync')
