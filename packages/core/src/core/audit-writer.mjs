/**
 * 母版层 · 审计写入器（2026-10-18 从 src/dsh/audit.mjs 下沉）
 *
 * 为什么下沉：架构审查发现 `adapters/dsh/eligibility-gate.mjs`（适配层）反向 import
 * `src/dsh/audit.mjs`（宿主缝）——层序应只向下。写入器是"JSONL 追加 + 体积轮转"的通用能力，
 * 与宿主无关，放 core 后适配层依赖就变成 adapter → core。
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
    appendFileSync(file, JSON.stringify(withTraceMeta(row)) + '\n')
    return true
  } catch (error) {
    console.warn('[focus-guard] AUDIT 留痕失败（不阻断）:', (error && error.message) || error)
    return false
  }
}
