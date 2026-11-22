/**
 * 模块台账的归属对账（2026-11-19）
 *
 * 为什么要有这个文件：`lib/modules.mjs` 为了把「16 个模块 × 5 次 git」压成 3 次，
 * 自己实现了 git pathspec 的匹配（`matches()`），而不是让 git 去筛。**这就是在重写 git 的解析器**，
 * 而它已经错了两次，两次都静默：
 *
 *   ① `p.slice(3, -1)` 本想把 `:(exclude)foo` 切成 `foo`，实际切出 `xclude)fo`。
 *      排除项从此一条都没生效：`dsh` 把 `guard`/`seams` 的提交算进自己（101 次，git 的答案是 98），
 *      `core` 把 `prefixStability` 算进自己（68，实为 64）。表照常生成、照常好看。
 *   ② 用 `--name-only` 取文件列表，改名只输出新路径。
 *      `69dea4c` 把一个文件从 adapters **移出**到 hooks，那次提交对 adapters 的删除被整条漏掉。
 *
 * 两次都不是「报错」，是**数字偏小**——比崩溃危险得多。所以这里不测「函数返回什么」，
 * 而是拿 **git 自己的答案** 当基准逐模块对账：末次提交 hash 与累计提交数必须一字不差。
 * 判据来自 git，不来自我的理解。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MODULES, collectModules } from '../tools/lib/modules.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 直接问 git，不经任何自研匹配。没装 git 或不在仓库里就返回 null，由调用方跳过。 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

const hasGit = Boolean(git(['rev-parse', 'HEAD']))

test('每个模块的末次提交与累计提交数，必须与 git pathspec 的结果一致', { skip: !hasGit && '本机没有 git 或不在仓库里' }, () => {
  const rows = collectModules(ROOT, MODULES).rows
  const bad = []
  for (const m of MODULES) {
    const row = rows.find((r) => r.id === m.id)
    const wantHash = git(['log', '-1', '--format=%h', '--', ...m.paths])
    const wantTouches = Number(git(['rev-list', '--count', 'HEAD', '--', ...m.paths]))
    if (row.hash !== wantHash || row.touches !== wantTouches) {
      bad.push(`${m.id}: 末次 ${row.hash} / git ${wantHash}；累计 ${row.touches} / git ${wantTouches}`)
    }
  }
  assert.deepEqual(bad, [], `模块归属与 git 不一致：\n${bad.join('\n')}`)
})
