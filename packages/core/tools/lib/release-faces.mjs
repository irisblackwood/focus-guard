/**
 * 产物面：`npm run release:status` 要问的四个独立真值。
 *
 * 为什么单列一个文件：这四面的探测各有各的坑（gh 的字段名、jq 输出为空、一次发布横跨多个运行），
 * 注释比代码长，塞在 `release.mjs` 里把它顶到 402 行、越了 400 的行数阈值。
 * 按仓库规矩**只许拆不许抬**，于是拆出来。
 *
 * 从 `release.mjs` 拆出的原因记录在 CHANGELOG（`refactor(tools)`），这里只保留机制说明。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeVersion, registryBase } from '../registry-check.mjs'

const git = (root, args) => (execFileSync('git', args, { cwd: root, encoding: 'utf8' }) || '').trim()

/** 包名：探 registry 用，与版本同源（`packages/core/package.json`）。 */
export function packageName(root) {
  return JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).name
}

/**
 * 最近一次 publish 运行；没装 gh / 未登录 / 从没跑过都返回 null。
 *
 * 2026-11-26 修两处，都是「认领哪一次运行」的坑：
 * 1. `gh workflow run --ref main` 手动补发时 displayTitle 只有「publish」、headBranch 是 main，
 *    按 tag 名怎么都认不出来——旧实现于是退到上一次历史运行，`--status` 永远指着那条失败报红。
 * 2. 一次版本发布可能横跨多个 run（先跑失败 → 重跑成功 → 补 Release 又一条），
 *    按 tag 名 `find` 拿到的是**最早**那条。现在取时间最新的一条，另给 `related` 标明它是否与
 *    这个 tag 精确对应；不对应就只是线索，不当判据。
 */
export function publishRun(root, tag, sinceMs = 0, commit = null) {
  try {
    const out = execFileSync('gh', ['run', 'list', '--workflow=publish.yml', '--limit', '20', '--json', 'displayTitle,headBranch,headSha,status,conclusion,url,createdAt'], {
      cwd: root,
      encoding: 'utf8',
    })
    // gh 按时间倒序；`sinceMs` 用来排除同一 tag 的历史运行（失败重跑时最容易被误当成「刚触发的」）。
    const fresh = (r) => !sinceMs || Date.now() - new Date(r.createdAt).getTime() <= sinceMs
    const runs = JSON.parse(out).filter(fresh)
    const latest = runs[0]
    if (!latest) return null
    const related = (r) => (r.displayTitle || '').includes(tag) || r.headBranch === tag || Boolean(commit && r.headSha === commit)
    return { ...latest, related: related(latest), everRelated: runs.some(related) }
  } catch {
    return null
  }
}

/** tag 的本地 / 远端 / Release / 是否 Latest 四个值，各自独立取，缺哪个说哪个。 */
export function githubFace(root, tag) {
  const tryGit = (args) => {
    try {
      return git(root, args)
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
    release = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--json', 'tagName,createdAt,isDraft,isPrerelease'], { cwd: root, encoding: 'utf8' }))
    // `gh api` 返回的是**原始** API 字段（snake_case），与 `gh release view --json` 的驼峰不同；
    // 且本机 gh 的 `--jq` 输出为空（实测只有换行），所以自己解析、认 `tag_name`。
    const latest = JSON.parse(execFileSync('gh', ['api', 'repos/{owner}/{repo}/releases/latest'], { cwd: root, encoding: 'utf8' }))
    release.isLatest = latest?.tag_name === tag
  } catch {
    release = null
  }
  return { head, local, commit, remote, atHead: Boolean(commit && head && commit === head), release }
}

const mark = (ok) => (ok ? '✅' : '❌')

/**
 * 四个真值各取一次，返回可直接打印的行与结论。
 * 结论只看 **tag / Release / registry** 三面——workflow 面只作线索（它能红在发布之后的确认步骤上，
 * 也可能一次发布横跨多个 run，拿它判红会每发一版留一条假红）。
 */
export async function productStatus({ root, version, tag }) {
  // 先把 registry 探测发出去（异步），再跑几个 execFileSync 的活——它们的等待正好被 fetch 用掉。
  // `elapsed` 只算探测本身（从发出到拿回），不含被 gh 那几条命令占用的时间。
  const t0 = Date.now()
  const registryProbe = probeVersion(registryBase(), packageName(root), version)
    .then((r) => ({ ...r, elapsed: Date.now() - t0 }))
    .catch((err) => ({ state: 'error', detail: err.message, elapsed: Date.now() - t0 }))
  const gh = githubFace(root, tag)
  const run = publishRun(root, tag, 0, gh.commit)
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
  // workflow 面只作线索，不参与结论。理由：它能红在「发布之后」的确认步骤上（3.5.3 那次就是
  // ——npm 已收下、Release 已建，红在 Verify 的判据），而一次版本发布又可能横跨多个 run
  // （失败 → 重跑成功 → 补 Release）。所以这一行说清「哪条运行、跟这个 tag 对不对应」，
  // 让结论由前三面给，不拿运行记录去覆盖产物事实。
  let workflowLine
  if (!run) workflowLine = '  workflow ℹ （没有 gh 或没跑过——跳过）'
  else {
    const state = run.status === 'completed' ? run.conclusion : run.status
    const icon = run.status !== 'completed' ? '⏳' : 'ℹ'
    const how = run.related ? '与 tag 精确对应' : run.everRelated ? '最新一条；同版本另有更早的运行' : '最新一条；与 tag 无对应关系'
    workflowLine = `  workflow ${icon} ${state} · ${run.url}\n           ${how}：${run.displayTitle || '(无标题)'} @ ${String(run.headSha || '').slice(0, 7)}`
  }
  lines.push(workflowLine)
  let verdict
  // 「查不了」与「没有」必须分开说。合并成一句「未发布」是最坏的一种——2026-11-26 本机一次
  // 网络瞬断就让它报了「还没有 publish 运行」，而三面其实齐平。查不了不等于没发过。
  if (published && gh.release && tagOk) verdict = '已发布：tag / Release / npm 三面齐平'
  else if (published) verdict = 'npm 上有了，但 GitHub 面不齐——按上面 ❌ 补'
  else if (registry.state === 'error') verdict = `查不了：registry 不可达（${registry.detail}）——这不等于没发布，联网后重跑本命令`
  else if (run && run.status !== 'completed') verdict = `发布中（${run.status}），不用守着：稍后重跑本命令`
  else if (run && run.conclusion === 'failure') verdict = '未发布：工作流失败，先看日志再重跑'
  else verdict = '未发布：还没有 publish 运行'
  return { lines, verdict, published, tagOk }
}
