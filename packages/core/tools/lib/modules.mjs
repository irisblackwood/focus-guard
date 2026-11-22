import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODULES, META_FILES } from './modules-list.mjs'
import { MODULES_DOC, renderModules } from './modules-doc.mjs'

// 渲染器住在 modules-doc.mjs，清单住在 modules-list.mjs，这里只管「怎么算」。
export { MODULES, META_FILES, MODULES_DOC, renderModules }

/**
 * 模块修订台账（tools/lib/modules.mjs，2026-11-19）
 *
 * ## 它防的是什么
 *
 * 不是「代码坏了」，是「**某块地方很久没人看，也没人记得它存在**」。
 * 这类腐化没有报错、没有红测试，只是慢慢和其余部分脱节：
 * 别人重构了调用方，它还按旧契约写着；接口变了，它还在按老假设兜底。
 *
 * ## 为什么一个日期都不存
 *
 * `docs/INDEX.md` 手抄过一份「适用版本 / 最后核对」，实测 **18 处与文档自身状态头不符**，
 * 分叉二十多天无人发现——手写的真值一定会腐化，且没有判据能发现。
 * 所以这里全部现算 git。手写的只有一样：**哪些路径算一个模块**（`modules-list.mjs`）。
 *
 * ## 判据为什么用「其后全仓提交」而不是天数
 *
 * 初版按「距今 120 天 / 400 次提交」判定，跑出 13 个模块全绿；收紧到 30 天仍全绿。
 * 因为这个仓只有 51 天（397 次提交、日均 7.6 次）——照「几年的仓」设的天数线，
 * 等于永远量不到东西。第二版改用「模块自身提交间隔的中位数」，更糟：多数模块是被
 * 一批连续 commit 引入的，中位数被压到 0.0x 天；而提交不足 3 次的模块算不出中位数、
 * 退回宽松兜底，**越该被提醒的越绿**——方向是反的。
 *
 * 最终用：**该文件最后一次修订之后，全仓又提交了多少次**。
 * 它随仓库节奏自伸缩（日更十次的仓里 30 次是三天，月更的仓里是半年）、单调、动一次归零，
 * 而且不需要给任何模块配数字——没有第二份手写真值。
 *
 * ## 为什么按「中位文件」判，不按「最新文件」
 *
 * 2026-11-19 第二处返工。模块整体取最新，等于**只统计最勤快的那一个文件**：
 * 实测 `tools` 最新文件 0 天、中位文件 16 天；`src/core` 最新 0 天、中位 21 天。
 * 一个 61 文件的目录里 2 个在动，整块就显示「活跃」——正是「个别文件活跃，其余很少动」
 * 被遮住的地方。所以判定看**该模块所有文件「其后提交数」的中位数**：
 * 一半以上的文件多久没动，才是这块真实的陈旧程度。最新与最久照列，供人看分布。
 *
 * ## 判定不拦构建
 *
 * 「久未动」不等于「坏了」。设成硬红就是一个永远红的闸门——「永久红会训练人忽略告警」。
 * 所以表里加粗提示，`--strict` 也不因它 exit 1。真正会红的是**确定是错**的三件事：
 * 清单路径不存在、两个模块抢同一个文件、有功能文件没被任何模块认领。
 */

/** 等级由高到低。排序用它，`无法定位` 排最前——路径在 git 里找不到任何提交，本身就要看。 */
export const LEVEL_RANK = { 无法定位: 4, 久未动: 3, 临期: 2, 偏冷: 1, 活跃: 0 }

/**
 * 阈值：**中位文件「其后全仓提交」的次数**。
 *
 * `30` 的意思是「仓库又往前走了三十步，这块一半以上的文件一步没挪」。
 * 定这个值时的仓况：51 天 / 397 次提交 / 日均 7.6 次，所以 30 次 ≈ 四天。
 * 仓的节奏变了不必急着调——它是相对量，会跟着一起伸缩。
 */
const SINCE = { cold: 30, due: 80, stale: 150 }

/** 累计提交少于此数视为「历史浅」：样本不足以谈节奏，本身也是遗忘风险。 */
const THIN = 3

const DAYS = 86400

/** `git` 调用统一出口：失败一律返回 null，**不抛**——没装 git 的机器不该因此炸掉。 */
function git(repo, args) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * 一次读完整部历史：新 → 旧，每条带时间戳、短 hash、标题、触及的文件。
 *
 * 用 `--name-status` 而非 `--name-only`：改名会输出 `R100\t旧\t新`，只取新路径就会
 * 漏掉「某文件被移出本模块」那次提交（实测 adapters 少算 1 次）。文件名那栏可能有
 * 两个字段，所以 `parts.slice(1)` 全收。
 */
function scanHistory(repo) {
  const raw = git(repo, ['log', '--format=%x00%ct%x00%h%x00%s', '--name-status'])
  if (!raw) return []
  const out = []
  let cur = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('\u0000')) {
      const [, ts, hash, subject] = line.split('\u0000')
      cur = { ts: Number(ts), hash, subject, files: new Set() }
      out.push(cur)
      continue
    }
    if (!cur || !line) continue
    for (const f of line.split('\t').slice(1)) cur.files.add(f)
  }
  return out
}

/**
 * 排除项的两种写法：`:(exclude)path` 与 `:!path`。**必须按整段前缀切**。
 *
 * 2026-11-19 首版写成 `p.slice(3, -1)`，本想把 `:(exclude)foo` 切成 `foo`，
 * 实际切出 `xclude)fo`——排除项从此一条都没生效：`dsh` 把 `guard`/`seams` 的提交
 * 算进自己（101 次，git 的答案是 98），`core` 把 `prefixStability` 算进自己（68，实为 64）。
 * 手工复刻 git 的 pathspec 就是在重写它的解析器，**任何一处差一点都会静默算错**，
 * 所以 `tests/modules-attribution.test.mjs` 拿 git 自己的结果当基准比对。
 */
const EXCLUDE = /^:(?:\(exclude\)|!)/

/** 路径是否落在某组 pathspec 里（含排除项）。目录按 `/` 边界匹配，防 `tools-x` 误配 `tools`。 */
function matches(paths, file) {
  let hit = false
  for (const p of paths) {
    const neg = EXCLUDE.exec(p)
    const raw = neg ? p.slice(neg[0].length) : p
    const inside = file === raw || file.startsWith(`${raw}/`)
    if (!inside) continue
    if (neg) return false
    hit = true
  }
  return hit
}

/** 中位数（偶数取偏上）。空数组返回 null。 */
function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export function collectModules(repo, modules = MODULES, now = new Date()) {
  const commits = scanHistory(repo)
  const head = commits[0]?.hash ?? null
  const first = commits[commits.length - 1]?.ts ?? null
  const age = first ? Math.floor((now.getTime() / 1000 - first) / DAYS) : null
  // 每个文件最后一次被碰的**提交下标**（0 = HEAD）。下标本身就是「其后全仓提交数」。
  const lastAt = new Map()
  for (let i = 0; i < commits.length; i += 1) for (const f of commits[i].files) if (!lastAt.has(f)) lastAt.set(f, i)
  const tracked = (git(repo, ['ls-files']) || '').split('\n').filter(Boolean)
  const dirtySet = new Set(
    (git(repo, ['status', '--porcelain', '-uall']) || '')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).replace(/^.* -> /, '')),
  )
  // 台账的「适用版本」要填**产品版本号**，不是 commit hash——hash 进不了版本面比较，
  // 在 `docs/STATUS.md` 里会被当成「无版本面」。hash 放在正文里就够定位。
  let version = null
  try {
    version = JSON.parse(readFileSync(join(repo, 'packages/core/package.json'), 'utf8')).version
  } catch {
    version = null
  }
  const ago = (i) => (commits[i] ? Math.floor((now.getTime() / 1000 - commits[i].ts) / DAYS) : null)
  const rows = []
  for (const m of modules) {
    const files = tracked.filter((f) => matches(m.paths, f))
    const idxs = files.map((f) => lastAt.get(f)).filter((v) => v !== undefined).sort((a, b) => a - b)
    // 提交归属按 pathspec 语义逐条判，不看文件是否还存在——git 的 `log -- path`
    // 连已删除/改名的旧路径也算，只拿现存文件比对会让累计数比 `rev-list --count` 少。
    let touches = 0
    let hit = null
    for (let i = 0; i < commits.length; i += 1) {
      if (![...commits[i].files].some((f) => matches(m.paths, f))) continue
      touches += 1
      if (hit === null) hit = i
    }
    const mid = median(idxs)
    rows.push({
      id: m.id,
      name: m.name,
      note: m.note,
      files: files.length,
      latest: idxs.length ? idxs[0] : null,
      median: mid,
      oldest: idxs.length ? idxs[idxs.length - 1] : null,
      latestDays: idxs.length ? ago(idxs[0]) : null,
      medianDays: mid === null ? null : ago(mid),
      oldestDays: idxs.length ? ago(idxs[idxs.length - 1]) : null,
      since: hit,
      touches,
      hash: hit === null ? null : commits[hit].hash,
      date: hit === null ? null : new Date(commits[hit].ts * 1000).toISOString(),
      dirty: files.some((f) => dirtySet.has(f)),
      level:
        mid === null
          ? '无法定位'
          : mid >= SINCE.stale
            ? '久未动'
            : mid >= SINCE.due
              ? '临期'
              : mid >= SINCE.cold
                ? '偏冷'
                : '活跃',
    })
  }
  // 按风险排，不按「有没有未提交改动」排——那个只该是标记。
  // 首版把 dirty 排最前，结果前两行全是「有未提交改动」，后面一片绿，看着像全活跃。
  rows.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || (b.median ?? -1) - (a.median ?? -1))
  return { head, version, age, total: commits.length, rows }
}

/**
 * 覆盖情况：有没有功能文件没被任何模块认领。
 *
 * 这是「全活跃」那次翻车的真正原因——清单里少了整个 `packages/extended`（外接三包），
 * 而它 43 天没动、史上只有 5 次提交，**最该被提醒的那块根本不在表里**。
 * 仓根那些 LICENSE / package.json / CI 配置列在 `META_FILES` 里，是「本来就不归属」，
 * 不算漏；除它们之外还有文件没归属，就是清单真的漏了。
 */
export function collectCoverage(repo, modules = MODULES) {
  const tracked = (git(repo, ['ls-files']) || '').split('\n').filter(Boolean)
  const unowned = tracked.filter((f) => !matches(META_FILES, f) && !modules.some((m) => matches(m.paths, f)))
  return { total: tracked.length, meta: tracked.filter((f) => matches(META_FILES, f)).length, unowned: unowned.length, sample: unowned.slice(0, 5) }
}

/**
 * 判据①：清单里的路径必须存在。
 *
 * 这是**真错**：目录搬走/改名而清单没跟着改，表就成了假话，而且看起来一切正常。
 * 与「久未动」不同——久未动是信息，路径不存在是缺陷。
 */
export function checkModulePaths(repo, modules = MODULES) {
  const findings = []
  for (const m of modules) {
    for (const p of m.paths) {
      if (EXCLUDE.test(p)) continue // 排除项不是路径，别拿它去 existsSync
      if (!existsSync(join(repo, p))) {
        findings.push({ rule: 'modules-path-missing', file: 'packages/core/tools/lib/modules-list.mjs', line: 1, detail: `${m.id} 的路径不存在：${p}` })
      }
    }
  }
  return findings
}

/** 判据②：模块 `id` 不许重复——重复会让 `--json` 的消费方拿到两条同 id 的记录。 */
export function checkModuleIds(modules = MODULES) {
  const seen = new Map()
  const findings = []
  for (const m of modules) {
    if (seen.has(m.id)) {
      findings.push({ rule: 'modules-id-duplicate', file: 'packages/core/tools/lib/modules-list.mjs', line: 1, detail: `id \`${m.id}\` 重复（${seen.get(m.id)} 与 ${m.name}）` })
    } else {
      seen.set(m.id, m.name)
    }
  }
  return findings
}

/**
 * 判据③：一个文件只能属于一个模块。
 *
 * 重叠的后果是同一份改动同时点亮两行，看着像「两块都在动」，判定就假了。
 * 三十个模块全手写路径，重叠是很容易犯的错——所以由机器查。
 */
export function checkModuleOverlap(repo, modules = MODULES) {
  const tracked = (git(repo, ['ls-files']) || '').split('\n').filter(Boolean)
  const owner = new Map()
  const findings = []
  for (const m of modules) {
    for (const f of tracked) {
      if (!matches(m.paths, f)) continue
      if (owner.has(f) && owner.get(f) !== m.id) {
        findings.push({ rule: 'modules-path-overlap', file: 'packages/core/tools/lib/modules-list.mjs', line: 1, detail: `${f} 同时属于 ${owner.get(f)} 与 ${m.id}` })
      } else {
        owner.set(f, m.id)
      }
    }
  }
  return findings
}

/** 判据④：不能有功能文件落在所有模块之外——漏掉一块，那块就永远不会被提醒。 */
export function checkModuleCoverage(repo, modules = MODULES) {
  const { unowned, sample } = collectCoverage(repo, modules)
  if (!unowned) return []
  return [
    {
      rule: 'modules-unowned-path',
      file: 'packages/core/tools/lib/modules-list.mjs',
      line: 1,
      detail: `${unowned} 个文件不属于任何模块：${sample.join('、')}${unowned > sample.length ? ' 等' : ''}`,
    },
  ]
}

/**
 * 台账是否与现算一致。
 *
 * **刻意不进 `docs:lint`**：这张表的「其后提交」每次提交都会变，一旦当成硬闸，
 * 每次 commit 都会红一次——那正是「永久红的闸门等于没有闸门」。
 * 改为由 `.githooks/pre-commit` 自动重新生成并 `git add`，人不用记着跑。
 */
export function checkModulesDoc(repo) {
  const want = renderModules(collectModules(repo), collectCoverage(repo))
  let got = ''
  try {
    got = readFileSync(join(repo, MODULES_DOC), 'utf8')
  } catch {
    return [{ rule: 'modules-doc-stale', file: MODULES_DOC, line: 1, detail: '台账不存在，跑 `npm run modules:sync` 生成' }]
  }
  // 只比结构指纹，不比逐字：表里全是会随「现在」变的量，逐字比对会让开发中途的 check 无故变红。
  const keyOf = (t) => (t.match(/<!-- modules-key[^\n]*\n([\s\S]*?)\n-->/) || [, ''])[1]
  if (keyOf(got) !== keyOf(want)) {
    return [{ rule: 'modules-doc-stale', file: MODULES_DOC, line: 1, detail: '台账与模块清单不一致（清单改了没重生成），跑 `npm run modules:sync`' }]
  }
  return []
}
