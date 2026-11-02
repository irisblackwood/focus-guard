#!/usr/bin/env node
/**
 * 首次使用自清洁（2026-11-02）
 *
 * ## 为什么需要
 *
 * 发布物里**不该有**运行期私有产物：审计日志、脑索引、卷宗、私有面目录。
 * 现在的事实是「没有」——`npm pack` 出来 153 个文件，一个都不含（见 CHANGELOG）。
 * 但「现在没有」靠的是 `files` 字段写对了，**而 `files` 是可以被改错的**。
 * 这条是第二道闸：万一哪天打包配置被改坏、把开发机的数据带出去了，
 * 下载的人第一次装完就会自动清掉，**从 0 开始，只剩随包分发的法条**。
 *
 * ## 判据：靠 `.git` 分辨"谁的副本"
 *
 * 开发副本（作者自己的仓库）里有 `.git`，那里面的私有产物是**正常数据**，
 * 动了就是删用户的记忆。安装副本（node_modules 里的、解压的 tarball）没有 `.git`，
 * 那里面的私有产物只可能是**误打包**。
 * 所以：**有 `.git` 一律不动，没有才清**。这个判据比"看文件时间"、"看目录名"都硬。
 *
 * 再加两道保险，宁可不动：
 *   ① 只有 `package.json` 的 `name` 确实是本包才动手；
 *   ② 每个待删路径 realpath 之后必须仍在包根之内（防符号链接把删除引到别处）。
 *
 * ## 名字为什么可以写在这里
 *
 * `privacy-guard` 坚持代码里不提私有面目录名，因为它那份清单本身就是秘密。
 * 这里不同：下面这几个名字在 README 与 `brain.mjs` 的用法说明里**已经公开**
 * （`.focus-guard/AUDIT.log`、`.ai/CASE_FILE.md` 就是验证安装是否生效的那两行）。
 * 写在这里不新增任何暴露面，反而少一次"名字藏在配置文件里、哪天配置文件丢了就失效"。
 *
 * 用法：
 *   node packages/core/tools/first-run-sweep.mjs            # 检查并清理
 *   node packages/core/tools/first-run-sweep.mjs --dry      # 只说会删什么
 * 退出码：恒 0（挂在 postinstall 上，清洁失败不该让安装失败）
 */

import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 运行期产物：安装副本里出现即误打包。目录名在 README 中已公开。 */
const DIRS = ['.focus-guard', '.ai', 'self-improvement']
/** 单文件产物：与上面同性质。 */
const FILES = ['HANDOFF.md']

const DRY = process.argv.includes('--dry')

/** 从本文件上溯到包根（含 package.json 的那一层）。 */
function findRoot() {
  let d = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, 'package.json'))) return d
    const up = resolve(d, '..')
    if (up === d) break
    d = up
  }
  return ''
}

/**
 * 三道保险：是本包、是安装副本、路径没逃出包根。
 * 任何一条不满足就整件事不做——**删数据的代码，不确定就等于不做**。
 */
function guarded(root, target) {
  if (!root || !existsSync(target)) return false
  try {
    const rel = relative(realpathSync(root), realpathSync(target))
    return rel !== '' && !rel.startsWith('..')
  } catch {
    return false
  }
}

/**
 * 往上找 `.git`——**不能只看包根**。
 * monorepo 里包根是 `packages/core`，`.git` 在仓库根；
 * 只看包根会把开发副本误判成安装副本，然后删掉作者自己的 `.ai/CASE_FILE.md`。
 * 这条是实测踩出来的：`--dry` 报"会清理 1 项：.ai"，而那一项是真实数据。
 */
function inWorkTree(root) {
  let d = root
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, '.git'))) return true
    const up = resolve(d, '..')
    if (up === d) break
    d = up
  }
  return false
}

function isOurPackage(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'focus-guard'
  } catch {
    return false
  }
}

function main() {
  const root = findRoot()
  if (!root || !isOurPackage(root)) return
  /* 开发副本：作者自己的仓库。这里的私有产物是数据，不是垃圾。 */
  if (inWorkTree(root)) {
    if (!DRY) return
    process.stdout.write('[sweep] 开发副本（祖先目录有 .git），不动\n')
    return
  }
  const hits = [...DIRS, ...FILES].map((n) => join(root, n)).filter((p) => guarded(root, p))
  if (!hits.length) return
  const names = hits.map((p) => relative(root, p).replace(/\\/g, '/'))
  if (!DRY) for (const p of hits) rmSync(p, { recursive: true, force: true })
  process.stdout.write(
    `[sweep] ${DRY ? '会清理' : '已清理'} ${names.length} 项误打包的运行期产物：${names.join(' / ')}\n` +
      '[sweep] 原因：安装副本里不该有开发机的数据。脑会从 0 开始长，法条随文档重新读入。\n',
  )
}

try {
  main()
} catch (e) {
  /* 挂在 postinstall 上：清洁失败不该让用户装不上包。只报，不抛。 */
  process.stdout.write(`[sweep] 跳过（${e.message}）\n`)
}
