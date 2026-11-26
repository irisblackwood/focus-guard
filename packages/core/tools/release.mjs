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
 * ## 三个阶段，各有判据
 *
 * | 阶段 | 命令 | 判据 |
 * |---|---|---|
 * | 检查 | `npm run release` | 版本面一致 / CHANGELOG 有段 / `PUBLISHED_MAX` 等于上一发 / 工作区干净且与远端齐 / tag 不存在 / 文档 ack 新鲜 |
 * | 发版 | `npm run release -- --go` | 建附注标签 + 推 tag + `gh release create`（正文取 CHANGELOG 该段） |
 * | 回写 | `npm run release:sync` | 把 `PUBLISHED_MAX` 改成新版本，并列出仍需人工改的文案 |
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

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const argv = process.argv.slice(2)
const GO = argv.includes('--go')
const SYNC = argv.includes('--sync')
const OFFLINE = argv.includes('--offline')
const NOTE = (() => {
  const i = argv.indexOf('--note')
  return i >= 0 ? argv[i + 1] : null
})()

const git = (args, opts = {}) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()
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

// ── 检查 ──
const faces = versionFaces()
const version = faces['packages/core/package.json']
const tag = `v${version}`
const published = publishedMax()
const section = changelogSection(version)
const ok = []
const bad = []

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
if (tagExists) bad.push(`tag ${tag} 已存在——同一版本不重打；确要重打先 \`git tag -d ${tag}\``)
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

git(['tag', '-a', tag, '-m', note])
console.log(`[release] 已建标签 ${tag}`)
git(['push', 'origin', tag], { stdio: 'inherit' })
console.log(`[release] 已推送 ${tag}`)

const notesFile = join(tmpdir(), `fg-release-${version}.md`)
writeFileSync(notesFile, `${section.body}\n`)
execFileSync('gh', ['release', 'create', tag, '--title', `${tag} · ${new Date().toISOString().slice(0, 10)}`, '--notes-file', notesFile], {
  cwd: ROOT,
  stdio: 'inherit',
})
// 补建历史版本时，`gh release create` 会把最后创建的那个标成 Latest——所以每次显式钉一次。
execFileSync('gh', ['release', 'edit', tag, '--latest'], { cwd: ROOT, stdio: 'inherit' })
console.log(`[release] 已建 Release ${tag}（已钉 Latest）；publish.yml 应已在跑：gh run list --workflow=publish.yml --limit 3`)
console.log('[release] 发完记得回写：npm run release:sync')
