#!/usr/bin/env node
/**
 * 安装自检（2026-11-18）
 *
 * ## 起因
 *
 * 3.5.1 及以前，包里带着 `postinstall`。pnpm 10 起对未批准的构建脚本报
 * `ERR_PNPM_IGNORED_BUILDS` 并**非零退出**；而 `dsh plugin` 是 pnpm 的薄转发器，
 * pnpm 一失败，它后面「把声明了 `dsh.bundle` 的依赖对账进 `dsh.profile.bundles`」
 * 那一步就被整段跳过。结果是包躺在 `dependencies` 里、却进不了 loader 清单——
 * **装上了，不加载**。
 *
 * 三条路都碰不到这个缺陷，所以它活了很久：
 *   ① 开发机用 `link:` 装，pnpm 对链接依赖不跑构建脚本；
 *   ② 文档在 3.5.1 之前一直教 `github:…#path:` 或本地路径；
 *   ③ CI 只跑源码树，从不执行「装进 profile → 起 dsh → 看清单」。
 * 最后是第三方验证平台报 `L5.4 not-found` 才发现的。
 *
 * ## 判据
 *
 * 静态（默认跑，CI 也跑；都不需要 dsh）：
 *   A `lifecycle-free`  package.json 不得含 install 系脚本（preinstall / install /
 *                       postinstall / prepare / prepublish）——**这条就是根因的回归防线**
 *   B `patch-exists`    `dsh.bundle.patch` 指向的文件必须在包内
 *   C `entry-shape`     入口必须导出 `name` 与 `apply`（cordis 插件形态）
 *   D `engines-dsh`     兼容声明必须写在 `engines.dsh`（dsh 只认这个位置，见下）
 *
 * 安装（`--install`，需要 dsh）：
 *   E `bundles-registered`  把**本地 tarball**装进一次性 profile，断言
 *                           `dsh.profile.bundles` 里出现本包，然后拆掉现场
 *
 * D 的由来（2026-11-19）：dsh 0.2 的 `unmetRequirements` 是「有 `engines.dsh` 就只看它，
 * `peerDependencies` 全部忽略；没有才退回去扫 `@deepseek-ai/dsh*` 的 peer」。我们一直只写了
 * peer（3.0.6 起），判定其实一直在生效——但**外部验证平台只认 `engines.dsh`**，于是页面显示
 * 「作者未声明 dsh 版本要求」。约束存在而不可见，等于半个没有。
 *
 * 缺 `dsh` 时 D 记 **skip 并明说**，不静默通过——「没查」与「查过没问题」
 * 必须能分开（本仓为此栽过：判据缺失静默返回空）。
 *
 * 用法：
 *   node tools/install-check.mjs              # 静态四项
 *   node tools/install-check.mjs --install    # 再加一次真装
 *   node tools/install-check.mjs --strict     # 有任何 finding 即 exit 1
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const STRICT = process.argv.includes('--strict')
const WITH_INSTALL = process.argv.includes('--install')
if (process.env.FG_TRACE) {
  process.stderr.write(
    `[trace] pid=${process.pid} ppid=${process.ppid} lifecycle=${process.env.npm_lifecycle_event || '-'} argv=${process.argv.slice(1).join(' ')}\n`,
  )
}
/**
 * 防重入（2026-11-19）：跑 `--install` 时会**再起一个本脚本**（pid 不同、profile 名不同），
 * 两个进程各建一套现场；内层那套装成功了却没被拆掉，于是每次自检在 `~/.dsh/profiles`
 * 里留一个 `fg-selfcheck-<pid>`。
 *
 * 先试过环境变量，**不生效**——内层进程看不到外层设的 `FG_INSTALL_CHECK`（那条链中间
 * 有人重置了环境）。改成系统临时目录里的锁文件：不依赖环境继承，只看「有没有人在跑」。
 * 持有者 pid 已死则接管，避免崩溃留下死锁。
 */
const LOCK = join(tmpdir(), 'fg-install-check.lock')

function acquireLock() {
  const me = JSON.stringify({ pid: process.pid, ppid: process.ppid, at: Date.now(), argv: process.argv.slice(1) })
  try {
    writeFileSync(LOCK, me, { flag: 'wx' })
    return true
  } catch {
    let holder = null
    try {
      holder = JSON.parse(readFileSync(LOCK, 'utf8'))
    } catch {
      holder = null
    }
    if (holder && typeof holder.pid === 'number') {
      try {
        process.kill(holder.pid, 0)
        // 持有者还活着：把双方身份都记下来，冲突才有据可查。
        notes.push(`锁被 pid ${holder.pid}（父 ${holder.ppid}）持有，本人 pid ${process.pid}（父 ${process.ppid}）`)
        return false
      } catch {
        /* 持有者已死，接管 */
      }
    }
    try {
      writeFileSync(LOCK, me)
      return true
    } catch {
      return false
    }
  }
}

function releaseLock() {
  try {
    rmSync(LOCK, { force: true })
  } catch {
    /* 释放失败不影响判定 */
  }
}
/** Windows 上 `dsh` / `npm` 是 .cmd 垫片，不经 shell 调用就得补后缀（走 shell 会被静态扫描判为注入面）。 */
const BIN = (n) => (process.platform === 'win32' ? `${n}.cmd` : n)

/** pnpm 会拦的构建脚本。`prepare` 也在内：本地安装时同样会跑。 */
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']

const findings = []
const notes = []

function readPkg() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
}

/** A：install 系脚本一律不许有。 */
function checkLifecycle(pkg) {
  const hit = LIFECYCLE.filter((k) => pkg.scripts && pkg.scripts[k])
  if (!hit.length) return
  findings.push({
    rule: 'lifecycle-script',
    detail: `package.json 含 install 系脚本 ${hit.join(' / ')}——pnpm 会报 ERR_PNPM_IGNORED_BUILDS 并非零退出，dsh 的 bundles 对账随之被跳过`,
  })
}

/** B：`dsh.bundle.patch` 必须是包内真实文件（字符串或数组都认）。 */
function checkPatch(pkg) {
  const declared = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  if (declared === undefined) {
    findings.push({ rule: 'patch-missing', detail: 'package.json 没有 dsh.bundle.patch——dsh 不会把它当 profile bundle' })
    return
  }
  const list = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : null
  if (!list) {
    findings.push({ rule: 'patch-missing', detail: 'dsh.bundle.patch 既不是字符串也不是数组' })
    return
  }
  for (const rel of list) {
    if (!existsSync(join(ROOT, rel))) findings.push({ rule: 'patch-missing', detail: `dsh.bundle.patch 指向的 ${rel} 不存在` })
  }
}

/** C：入口得是 cordis 认的形状（`name` + `apply`）。读源码而不 import——不为了检查去执行副作用。 */
function checkEntry(pkg) {
  const entry = pkg.main || (pkg.exports && pkg.exports['.'])
  const rel = typeof entry === 'string' ? entry : entry && entry.default
  if (!rel) {
    findings.push({ rule: 'entry-shape', detail: 'package.json 没有 main/exports，dsh 无从加载' })
    return
  }
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) {
    findings.push({ rule: 'entry-shape', detail: `入口 ${rel} 不存在` })
    return
  }
  const src = readFileSync(abs, 'utf8')
  for (const need of [/export\s+(?:const|let)\s+name\s*=/, /export\s+(?:async\s+)?function\s+apply\s*\(/]) {
    if (!need.test(src)) findings.push({ rule: 'entry-shape', detail: `入口 ${rel} 缺 ${need.source}——不是 cordis 插件形态` })
  }
}

/** D：兼容范围得写在 `engines.dsh`——那是 dsh 唯一「说了算」的位置。 */
function checkEnginesDsh(pkg) {
  const range = pkg.engines && pkg.engines.dsh
  if (typeof range !== 'string' || !range.trim()) {
    findings.push({
      rule: 'engines-dsh',
      detail: 'package.json 没有 engines.dsh——版本约束只写在 peerDependencies 里时，dsh 仍会校验（退路），但外部平台与读者都看不见，等于半个声明',
    })
    return
  }
  // dsh 的 `workspace:` 特例只对 peer 生效；写进 engines 会被当成普通范围，永不满足。
  if (range.includes('workspace:')) {
    findings.push({
      rule: 'engines-dsh',
      detail: `engines.dsh 写成了 ${range}——workspace: 只在 peerDependencies 里被解析，放进 engines 等于永不满足`,
    })
  }
}

/** profile 目录可能落在 DSH_HOME（指向 .dsh 本身或它的父目录）或默认 ~/.dsh。 */
function findProfile(name) {
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  const cands = []
  for (const h of homes) {
    cands.push(join(h, 'profiles', name), join(h, '.dsh', 'profiles', name))
  }
  return cands.find((p) => existsSync(join(p, 'package.json')))
}

/** D：真装一次。用**本地 tarball**，不是 registry 上那个已发布版本——检查的是这一棵树。 */
function checkInstall(pkg) {
  // Windows 上 `dsh` / `npm` 是 .cmd 垫片，Node 不经 shell 无法执行它们（CVE-2024-27980 之后的限制）。
  // 这里敢开 shell：**参数全是内部常量**——profile 名只有 pid，tarball 用文件名 + cwd 定位，
  // 仓库路径走 spawn 的 cwd 选项而不进命令行。没有一处来自环境变量或用户输入。
  const WIN = process.platform === 'win32'
  const dsh = spawnSync(BIN('dsh'), ['--version'], { encoding: 'utf8', shell: WIN })
  if (dsh.status !== 0) {
    notes.push('skip 安装档：本机没有可用的 dsh 命令（静态四项已覆盖根因）')
    return
  }
  // 现场放系统临时目录，不放包内 node_modules：pnpm 对「另一个包 node_modules 下的 tarball」
  // 有额外语义（实测会装成空 bundle），把测量工具自己的位置变成一个变量。
  const tmp = join(tmpdir(), `fg-install-check-${process.pid}`)
  const name = `fg-selfcheck-${process.pid}`
  let packed = ''
  /** 现场目录在 finally 里拆——**任何提前 return 都不能留下 profile**。 */
  let profileDir = ''
  try {
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const pack = spawnSync(BIN('npm'), ['pack'], { cwd: ROOT, encoding: 'utf8', shell: WIN })
    if (pack.status !== 0) {
      findings.push({ rule: 'install-skip', detail: `npm pack 失败：${(pack.stderr || '').trim().slice(0, 200)}` })
      return
    }
    packed = readdirSync(ROOT).find((f) => f.endsWith('.tgz')) || ''
    if (!packed) {
      findings.push({ rule: 'install-skip', detail: 'npm pack 没有产出 .tgz' })
      return
    }
    // 仓库与系统临时目录可能不在同一个盘，rename 会 EXDEV——复制后删原件。
    copyFileSync(join(ROOT, packed), join(tmp, packed))
    rmSync(join(ROOT, packed), { force: true })
    // 必须用**绝对路径**：`dsh plugin` 会把 pnpm 的 cwd 切到 profile 目录，
    // 相对路径的 tarball 在那里解析不到——pnpm 静默装了个空，bundles 自然没有。
    // Windows 上走 shell，路径要自己加引号（Node 在 shell 模式下不做转义）。
    const tgzAbs = join(tmp, packed)
    const spec = WIN ? `"${tgzAbs}"` : tgzAbs
    const add = spawnSync(BIN('dsh'), ['plugin', '--profile', name, 'add', spec], {
      cwd: tmp,
      encoding: 'utf8',
      shell: WIN,
    })
    profileDir = findProfile(name) || ''
    if (!profileDir) {
      findings.push({
        rule: 'install-profile',
        detail: `装完找不到 profile 目录（dsh exit ${add.status}）：${(add.stdout || add.stderr || '').trim().slice(0, 200)}`,
      })
      return
    }
    const installed = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const bundles = (installed.dsh && installed.dsh.profile && installed.dsh.profile.bundles) || []
    if (!bundles.includes(pkg.name)) {
      findings.push({
        rule: 'bundles-registered',
        detail: `装完 dsh.profile.bundles 里没有 ${pkg.name}（现有：${bundles.join(' / ') || '空'}）——装上了但不会加载`,
      })
    }
  } finally {
    // 清理失败不改变判定，但也不能吞得无声无息：留一行 note，下次才知道地上有垃圾。
    if (profileDir) {
      try {
        rmSync(profileDir, { recursive: true, force: true })
      } catch (e) {
        notes.push(`profile 现场未拆净（${profileDir}）：${e.code || e.message}`)
      }
    }
    rmSync(tmp, { recursive: true, force: true })
    if (packed && existsSync(join(ROOT, packed))) rmSync(join(ROOT, packed), { force: true })
  }
}

const pkg = readPkg()
checkLifecycle(pkg)
checkPatch(pkg)
checkEntry(pkg)
checkEnginesDsh(pkg)
if (WITH_INSTALL) {
  // 拿不到锁时 acquireLock 已把冲突双方写进 notes，这里不重复记。
  if (acquireLock()) {
    try {
      checkInstall(pkg)
    } finally {
      releaseLock()
    }
  }
}

const head = `安装自检：${WITH_INSTALL ? '静态 4 项 + 安装档' : '静态 4 项'}`
if (!findings.length) {
  process.stdout.write(`[install-check] ${head}，问题 0 条${notes.length ? `；${notes.join('；')}` : ''}\n`)
} else {
  process.stdout.write(`[install-check] ${head}，问题 ${findings.length} 条\n`)
  for (const f of findings) process.stdout.write(`  ✗ [${f.rule}] ${f.detail}\n`)
  if (notes.length) process.stdout.write(`  · ${notes.join('；')}\n`)
  if (STRICT) process.exit(1)
}
