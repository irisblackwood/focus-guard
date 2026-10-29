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
  existsSync,
  mkdirSync,
  readdirSync,
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

/** 归档保留份数；超出则删最旧。`FG_AUDIT_ARCHIVE_KEEP` 可覆盖。 */
export const AUDIT_ARCHIVE_KEEP = Number(process.env.FG_AUDIT_ARCHIVE_KEEP) || 10

/**
 * 当前审计目标路径。
 * `FG_AUDIT_FILE` 可重定向——**测试必须**用它指向 tmpdir，否则会写进真实工作区
 *（2026-10-09 事故：污染 2630 行 / 746 个测试 session）。与 `FG_CASE_FILE` 同思路。
 */
export function auditFilePath() {
  return process.env.FG_AUDIT_FILE || AUDIT_FILE
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
    session: String(session || extra.session || 'dsh-native'),
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
  if (out.session === undefined) out.session = 'dsh-native'
  if (!out.action) out.action = 'unspecified'
  if (out.trigger === undefined) out.trigger = out.action
  if (out.level === undefined) out.level = null
  if (out.evidence === undefined) out.evidence = ''
  if (out.pardon === undefined) out.pardon = false
  if (!out.seq) out.seq = nextSeq()
  return out
}

/**
 * 体积轮转：超出上限则把当前日志移入同目录 `archive/`，并立刻重建空文件。
 * 纪律三条：① 只归档、不删除（执法记录不得丢）；② 任何失败只 warn；
 * ③ 轮转失败时继续追加原文件——宁可文件变大，不可丢记录。
 * @returns {string|null} 归档目标路径；未轮转或失败返回 null
 */
export function rotateAuditIfNeeded(file = auditFilePath(), max = AUDIT_MAX_BYTES) {
  try {
    if (!existsSync(file)) return null
    const size = statSync(file).size
    if (size < max) return null
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
    console.warn(`[focus-guard] 审计日志已轮转：${dest}（原 ${size} 字节）`)
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
export function appendAudit(row, file = auditFilePath()) {
  try {
    rotateAuditIfNeeded(file)
    mkdirSync(dirname(file), { recursive: true })
    // 顺序要紧：先补七字段，再注入位置元数据，最后序列化。
    // 反过来的话 provider 拿到的行还没规范化，判断"缺字段"会看错。
    appendFileSync(file, JSON.stringify(withTraceMeta(normalizeRow(row))) + '\n')
    return true
  } catch (error) {
    console.warn('[focus-guard] AUDIT 留痕失败（不阻断）:', (error && error.message) || error)
    return false
  }
}
