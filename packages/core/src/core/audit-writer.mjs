/**
 * 母版层 · 审计写入器（2026-10-18 从 src/dsh/audit.mjs 下沉）
 *
 * 为什么下沉：架构审查发现 `adapters/dsh/eligibility-gate.mjs`（适配层）反向 import
 * `src/dsh/audit.mjs`（宿主缝）——层序应只向下。写入器是"JSONL 追加 + 体积轮转"的通用能力，
 * 与宿主无关，放 core 后适配层依赖就变成 adapter → core。
 *
 * 2026-10-29 起本文件还是**审计行的唯一构造点**（`buildAuditRow`）：
 * 此前造行代码散在 5 处、字段集各不相同，真实日志里漂出三种行形态、17 组 seq 重复。
 * 详见 `buildAuditRow` 上方注释。
 *
 * 调用方约定：写失败只 warn，绝不阻断业务（也绝不因写失败把拦截降级成放行）。
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'

// 本文件位于 <仓库根>/packages/core/src/core/ → 上溯 4 级到仓库根
export const AUDIT_FILE = fileURLToPath(new URL('../../../../.focus-guard/AUDIT.log', import.meta.url))

/** 审计日志体积上限（字节）；`FG_AUDIT_MAX_BYTES` 可覆盖。默认 5 MB ≈ 2 万条记录。 */
export const AUDIT_MAX_BYTES = Number(process.env.FG_AUDIT_MAX_BYTES) || 5 * 1024 * 1024

/**
 * 审计日志**年龄**上限（毫秒）；`FG_AUDIT_MAX_AGE_MS` 可覆盖。默认 30 天。
 *
 * 2026-11-03 人类报「AUDIT.log 有极旧数据都不清理」——实测成立：只有体积判据时，
 * 27 天写 2.76 MB（10,256 条）离 5 MB 还差一半，于是首条 2026-10-06 的记录一直留在活动日志里，
 * 按当时速率约 45–50 天才轮转一次。**体积约束的是磁盘，年龄约束的是可读性**，两件事。
 */
export const AUDIT_MAX_AGE_MS = Number(process.env.FG_AUDIT_MAX_AGE_MS) || 30 * 24 * 60 * 60 * 1000

/** 归档保留份数；超出则删最旧。`FG_AUDIT_ARCHIVE_KEEP` 可覆盖。 */
export const AUDIT_ARCHIVE_KEEP = Number(process.env.FG_AUDIT_ARCHIVE_KEEP) || 10

/**
 * 项目目录来源由**宿主适配层注入**（2026-11-16 从 `core/audit.mjs` 下沉）。
 *
 * 为什么定义点放在写入器而不是 `audit.mjs`：DSH 侧唯一写入口 `appendAudit` 在本文件，
 * 它拿不到 `audit.mjs` 里的 provider——反向 import 会成环（`audit.mjs` → `audit-writer.mjs`）。
 * 于是 provider 的定义点下沉到这里，`audit.mjs` 改为转发（`setProjectDirProvider` 对外 API 不变）。
 *
 * 不设这一层时，`auditFilePath()` 只能回退 `AUDIT_FILE`——那是**按包安装位置上溯 4 级**算出来的。
 * 开发仓里上溯正好是仓库根，看着对；一旦装到 `~/.dsh/plugins/<name>`，上溯就是插件目录，
 * 审计全部写进安装位置，用户在自己项目里永远看不到。
 */
let projectDirProvider = null

export function setAuditProjectDirProvider(fn) {
  projectDirProvider = typeof fn === 'function' ? fn : null
}

/** 会话工作区（provider 注入）；未注入或抛错返回空串。 */
export function resolveProjectDir(sid) {
  try {
    return (projectDirProvider && projectDirProvider(sid)) || ''
  } catch {
    return ''
  }
}

/**
 * 当前审计目标路径。
 * 优先级：`FG_AUDIT_FILE`（测试必须用它指向 tmpdir，否则会写进真实工作区）
 * 　　→ 会话工作区 `.focus-guard/AUDIT.log`（provider 注入）
 * 　　→ `AUDIT_FILE`（包相对路径，仅开发仓内正确）
 *
 * @param {string} [sid] 会话 id；provider 按会话分流工作区
 */
export function auditFilePath(sid) {
  if (process.env.FG_AUDIT_FILE) return process.env.FG_AUDIT_FILE
  const dir = resolveProjectDir(sid)
  if (dir) {
    try {
      if (statSync(dir).isDirectory()) return join(dir, '.focus-guard', 'AUDIT.log')
    } catch {
      /* 目录不可用则继续回退 */
    }
  }
  return AUDIT_FILE
}

/**
 * 事件唯一号：`<时间戳36进制>.<进程内单调计数>.<pid36>`。
 *
 * 为什么不用 `Math.floor(performance.now())`（2026-10-29 重构）：
 * 重构前 5 处各自拼 seq，其中 4 处用 `performance.now()` 取整当尾数。
 * 同一毫秒内连写两条就撞号——真实 AUDIT.log 7227 条带 seq 的记录里有 **17 组重复**
 * （如 `mv2fzh7c.350962` ×2），因果链渲染按 seq 建索引，撞号即丢边。
 *
 * 三段各管一件事：时间戳让日志可读、单调计数保证进程内不撞、pid 保证**跨进程**不撞
 *（宿主与测试子进程会同时往同一个 AUDIT.log 写，只靠"同毫秒 + 同计数"仍可能重合）。
 */
let seqBase = 0

/** 生成一个唯一事件号（测试可直接调）。 */
export function nextSeq(now = Date.now()) {
  seqBase += 1
  return `${now.toString(36)}.${seqBase}.${process.pid.toString(36)}`
}

/** 审计行七字段（docs/ARCHITECTURE.md:63）+ 因果链三字段（:267）。 */
export const AUDIT_REQUIRED_FIELDS = Object.freeze([
  'ts',
  'session',
  'action',
  'trigger',
  'level',
  'evidence',
  'pardon',
])

/** 由 `buildAuditRow` 独占的键：调用方只能在 opts 里**取值**，不能绕过规范化直接塞行。 */
const CANONICAL = new Set([
  'ts',
  'session',
  'seq',
  'chain',
  'ref',
  'action',
  'trigger',
  'level',
  'evidence',
  'pardon',
  'run',
  'evidenceLimit',
  'extra',
])

/**
 * 审计行唯一构造点（2026-10-29 重构，依据真实 AUDIT.log 实测）。
 *
 * 病根：造一条审计行这段代码原来在 5 处各写一遍——`seams/shared.mjs::auditRow`、
 * `postProgress.mjs`、`preGuard.mjs`、`stopGuard.mjs` 的局部 `audit()`，以及
 * `compactionWatch.mjs::row()`。五份字段集各不相同，于是同一份日志出现三种形态：
 * `preGuard` 带 chain/ref、其余不带；`fuse-waste`(11 行) / `grant`(5 行) /
 * `grants-swept`(8 行) / `audit-purge`(1 行) 干脆缺 trigger/level/pardon。
 * 契约写在文档里，但没有任何一处代码强制它——现在由这里强制。
 *
 * @param {string} session 会话标识
 * @param {string} action 动作名
 * @param {object} [opts] 七字段覆盖 + `extra` 附加诊断字段
 * @returns {object} 规范化后的审计行
 */
export function buildAuditRow(session, action, opts = {}) {
  const extra = opts.extra && typeof opts.extra === 'object' ? opts.extra : {}
  // 取值优先级：显式 opts 参数 > opts.extra > 缺省。
  // 为什么 extra 也能供契约字段：迁移期老调用点习惯把 `evidence` 之类混在附加字段里传
  //（compactionWatch 的 `row(state, action, trigger, extra)` 就是这种形态），
  // 若这里只认 opts，那些字段会被静默丢掉——实测第一版就是这样把 evidence 丢成空串的。
  const pick = (k) => (opts[k] !== undefined ? opts[k] : extra[k])
  const row = {
    ts: pick('ts') || new Date().toISOString(),
    // 身份两个字段（session / action）由位置参数定，extra 只能在位置参数缺失时兜底——
    // 否则一条 `deny` 记录能被附加字段改成别的动作，日志就没法当证据用了。
    // 2026-11-20：缺省值原先是 `'dsh-native'`——母版替 DSH 代言。改成中性值 `'unknown'`：
    // 两者在 `approvals.mjs::identityKnown` 眼里同属"身份不可判定"，行为等价，
    // 但母版从此不认识任何宿主名。真实 session 由各适配层在调用点传入。
    session: String(session || extra.session || 'unknown'),
    seq: pick('seq') || nextSeq(),
    chain: pick('chain') !== undefined ? pick('chain') : null,
    ref: pick('ref') || null,
    action: opts.action || action || extra.action || 'unspecified',
    trigger: pick('trigger') || action || 'unspecified',
    level: pick('level') ?? null,
    evidence: String(pick('evidence') || '').slice(0, pick('evidenceLimit') || 200),
    pardon: !!pick('pardon'),
  }
  // 附加诊断字段（tool / command / layer / decision / basis / turn / step …）原样带入，
  // 但**不得覆盖**上面十个契约字段——否则又回到"谁最后写谁说了算"。
  const carry = (src) => {
    if (!src || typeof src !== 'object') return
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined || k in row || CANONICAL.has(k)) continue
      row[k] = v
    }
  }
  carry(extra)
  carry(opts)
  return row
}

/**
 * 兜底规范化：任何一行落盘前补齐七字段 + 事件号。
 * 即使调用方绕开 `buildAuditRow` 直传裸行，日志里也不会再出现"缺 trigger"或"没有 seq"的残行。
 * 只补缺、不改值——调用方显式给 `level: null` 与"没给 level"在语义上都归一为 null。
 *
 * `chain`/`ref` 不在这里补：它们是任务链语义，不属于链的事件本来就没有，
 * 补成 `null` 只是噪音（消费方一律按真值判断）。
 */
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row
  const out = { ...row }
  if (!out.ts) out.ts = new Date().toISOString()
  if (out.session === undefined) out.session = 'unknown'
  if (!out.action) out.action = 'unspecified'
  if (out.trigger === undefined) out.trigger = out.action
  if (out.level === undefined) out.level = null
  if (out.evidence === undefined) out.evidence = ''
  if (out.pardon === undefined) out.pardon = false
  if (!out.seq) out.seq = nextSeq()
  // 2026-10-31：运行批次号。原先只有 `core/audit.mjs::audit()` 那条写路径自己 stringify 时
  // 带了 run，走 `buildAuditRow`/`appendAudit` 的写入（compactionWatch、case-tool…）全都没有。
  // 后果：`audit-isolation` 的隔离判据按 run 认"测试链写的行"，在这条路径上恒数到 0 ——
  // 报「本批次 0 条」= 隔离通过，**假绿**。补在 normalizeRow 而不是 buildAuditRow：
  // 这里是**落盘前**的兜底，绕开 buildAuditRow 直传裸行的写点也一并覆盖。
  // 宿主进程没有 FG_RUN_ID → 值为 null，与 `audit()` 同口径。
  if (out.run === undefined) out.run = process.env.FG_RUN_ID || null
  return out
}

/** 读首条记录的 `ts`（只读头部 512 字节，不整读日志）。无记录或不可解析返回 null。 */
function firstEntryTs(file) {
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(512)
      const n = readSync(fd, buf, 0, 512, 0)
      if (n <= 0) return null
      const m = /"ts":"([^"]+)"/.exec(buf.subarray(0, n).toString('utf8'))
      const t = m ? Date.parse(m[1]) : NaN
      return Number.isFinite(t) ? t : null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * 轮转：体积超上限**或**首条记录早于年龄上限，就把当前日志移入同目录 `archive/` 并重建空文件。
 * 纪律三条：① 只归档活动日志、不删记录（归档保留最近 `AUDIT_ARCHIVE_KEEP` 份，更早的才清）；
 * ② 任何失败只 warn；③ 轮转失败时继续追加原文件——宁可文件变大，不可丢记录。
 * @param {string} [file] 日志路径
 * @param {number} [max] 体积上限（字节）
 * @param {number} [maxAgeMs] 年龄上限（毫秒）；传 `Infinity` 关闭年龄判据
 * @returns {string|null} 归档目标路径；未轮转或失败返回 null
 */
export function rotateAuditIfNeeded(file = auditFilePath(), max = AUDIT_MAX_BYTES, maxAgeMs = AUDIT_MAX_AGE_MS) {
  try {
    if (!existsSync(file)) return null
    const size = statSync(file).size
    const tooBig = size >= max
    let tooOld = false
    if (!tooBig && Number.isFinite(maxAgeMs)) {
      const ts = firstEntryTs(file)
      tooOld = ts !== null && Date.now() - ts >= maxAgeMs
    }
    if (!tooBig && !tooOld) return null
    const dir = join(dirname(file), 'archive')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(dir, `${basename(file)}.${stamp}`)
    renameSync(file, dest)
    appendFileSync(file, '')
    const prefix = `${basename(file)}.`
    const olds = readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .sort()
    for (const n of olds.slice(0, Math.max(0, olds.length - AUDIT_ARCHIVE_KEEP))) {
      try {
        rmSync(join(dir, n), { force: true })
      } catch {
        /* 清理旧存档失败可忽略 */
      }
    }
    console.warn(`[focus-guard] 审计日志已轮转：${dest}（原 ${size} 字节${tooOld ? '，首条超龄' : '，超体积'}）`)
    return dest
  } catch (error) {
    console.warn('[focus-guard] 审计轮转失败（继续追加原文件，不丢记录）:', (error && error.message) || error)
    return null
  }
}

/**
 * 位置元数据提供者（`turn` / `step`）——由**宿主缝**注册，母版不反向依赖宿主。
 *
 * 背景（2026-10-19 人类批示）：AUDIT.log 原来只有 `seq`（进程内单调序号，跨会话不可比），
 * 算不出"熔断后浪费了几步"，于是 `stalledFuse.threshold` 该松该紧无从判断（ARCH-MAP 缺口 #3）。
 * 宿主只在 `agent/pre-step` 的载荷里给出 position `{turn, step}`，`tools/pre-execute` 的 exec 里没有；
 * 所以位置由缝记录、由本写入器统一注入——只在这一处，所有写点自动受益。
 *
 * 契约：provider `(session, row) => {turn, step} | null`，同步、不得抛错（抛错按无元数据处理）。
 * 行里已有 `turn`/`step` 时以行为准（不覆盖调用方显式给的值）。
 */
let traceMetaProvider = null

/** 注册位置元数据提供者；传非函数即卸载（测试与 zcode 路径共用）。 */
export function setTraceMetaProvider(fn) {
  traceMetaProvider = typeof fn === 'function' ? fn : null
}

/** 给一条审计行补位置元数据（缺字段才补；provider 异常不阻断写入）。 */
function withTraceMeta(row) {
  if (!traceMetaProvider || !row || typeof row !== 'object') return row
  if (row.turn !== undefined && row.step !== undefined) return row
  let meta = null
  try {
    meta = traceMetaProvider(row.session, row)
  } catch {
    meta = null /* 留痕优先：元数据失败不影响写入 */
  }
  if (!meta || typeof meta !== 'object') return row
  const extra = {}
  if (row.turn === undefined && Number.isInteger(meta.turn)) extra.turn = meta.turn
  if (row.step === undefined && Number.isInteger(meta.step)) extra.step = meta.step
  return Object.keys(extra).length > 0 ? { ...row, ...extra } : row
}

/**
 * 统一审计写入入口：所有写点共用，轮转只在这一处生效。
 * @returns {boolean} 是否写入成功
 */
/**
 * 追加一条审计记录。
 *
 * @param {object} row 审计行（`buildAuditRow` 产出，含 `session`）
 * @param {string} [file] 显式目标；不传则按 `row.session` 解析（见 `auditFilePath`）
 */
export function appendAudit(row, file) {
  // 2026-11-16：目标从默认参数改为函数内解析——默认参数在调用前求值，拿不到 row.session，
  // 于是 DSH 侧永远落回包相对路径（装到 ~/.dsh/plugins 时写进插件目录）。
  const target = file || auditFilePath(row && row.session)
  try {
    rotateAuditIfNeeded(target)
    mkdirSync(dirname(target), { recursive: true })
    // 顺序要紧：先补七字段，再注入位置元数据，最后序列化。
    // 反过来的话 provider 拿到的行还没规范化，判断"缺字段"会看错。
    appendFileSync(target, JSON.stringify(withTraceMeta(normalizeRow(row))) + '\n')
    return true
  } catch (error) {
    console.warn('[focus-guard] AUDIT 留痕失败（不阻断）:', (error && error.message) || error)
    return false
  }
}
