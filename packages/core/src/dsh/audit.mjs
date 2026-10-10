/**
 * focus-guard 原生插件 · 审计接入（3.0.5）
 *
 * 卷宗写入口：AUDIT.log（拦截留痕）与 CASE_FILE.md（成本台账）。
 * 一切写入独立 try/catch：留痕失败只 warn，绝不阻断宿主主流程；
 * 也绝不因写失败把拦截降级成放行（见 pipeline.mjs 调用次序）。
 */
import { appendFileSync, readFileSync, statSync, renameSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname, basename } from 'node:path'
import { calcCost } from '../peak-cost.mjs'

// 插件文件位于 <仓库根>/packages/core/src/dsh/ → 上溯 4 级到仓库根
export const AUDIT_FILE = fileURLToPath(new URL('../../../../.focus-guard/AUDIT.log', import.meta.url))

/** 审计日志体积上限（字节）；`FG_AUDIT_MAX_BYTES` 可覆盖。默认 5 MB ≈ 2 万条记录。 */
export const AUDIT_MAX_BYTES = Number(process.env.FG_AUDIT_MAX_BYTES) || 5 * 1024 * 1024

/** 归档保留份数；超出则删最旧。`FG_AUDIT_ARCHIVE_KEEP` 可覆盖。 */
export const AUDIT_ARCHIVE_KEEP = Number(process.env.FG_AUDIT_ARCHIVE_KEEP) || 10

/**
 * 当前审计目标路径。
 * `FG_AUDIT_FILE` 可重定向——**测试必须**用它指向 tmpdir，否则会写进真实工作区
 *（2026-10-09 事故：污染 2630 行 / 746 个测试 session）。与 `caseFilePath` 的 `FG_CASE_FILE` 同思路。
 */
export function auditFilePath() {
  return process.env.FG_AUDIT_FILE || AUDIT_FILE
}

/**
 * 体积轮转（2026-10-09）：超出上限则把当前日志移入同目录 `archive/`，并立刻重建空文件。
 * 纪律三条：
 *   ① 只归档、不删除（执法记录不得丢）——超保留份数才清理最旧存档；
 *   ② 任何失败只 warn，绝不阻断写入方（与全文件 fail-open 口径一致）；
 *   ③ 轮转失败时**继续追加原文件**——宁可文件变大，不可丢记录。
 * 注意：封存的 `hooks/guard.mjs`（ZCode 层）不经此处写入，它的日志不受本机制管辖。
 * @returns {string|null} 归档目标路径；未轮转或失败返回 null
 */
export function rotateAuditIfNeeded(file = auditFilePath(), max = AUDIT_MAX_BYTES) {
  try {
    // 文件尚不存在 = 首次写入，属正常情况，静默放过。
    // （不先判存在会走 statSync 抛 ENOENT，每次首写都刷一条"轮转失败"warn，噪音掩盖真问题。）
    if (!existsSync(file)) return null
    const size = statSync(file).size
    if (size < max) return null
    const dir = join(dirname(file), 'archive')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(dir, `${basename(file)}.${stamp}`)
    renameSync(file, dest)
    appendFileSync(file, '') // 立刻重建空文件，保持 append-only 语义
    const prefix = `${basename(file)}.`
    const olds = readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .sort()
    for (const n of olds.slice(0, Math.max(0, olds.length - AUDIT_ARCHIVE_KEEP))) {
      try {
        rmSync(join(dir, n), { force: true })
      } catch {
        /* 清理旧存档失败可忽略，不影响本次轮转 */
      }
    }
    console.warn(`[focus-guard-native] 审计日志已轮转：${dest}（原 ${size} 字节）`)
    return dest
  } catch (error) {
    console.warn(
      '[focus-guard-native] 审计轮转失败（继续追加原文件，不丢记录）:',
      (error && error.message) || error,
    )
    return null
  }
}

/**
 * 统一审计写入入口（3.0.7）：三处写点（auditDeny / auditRedlineExempt / auditEligibility）共用，
 * 避免"同一文件两种口径"复发（2026-10-09 事故的根因之一），并让轮转只在一处生效。
 * @returns {boolean} 是否写入成功
 */
export function appendAudit(row, file = auditFilePath()) {
  try {
    rotateAuditIfNeeded(file)
    appendFileSync(file, JSON.stringify(row) + '\n')
    return true
  } catch (error) {
    console.warn('[focus-guard-native] AUDIT 留痕失败（不阻断）:', (error && error.message) || error)
    return false
  }
}

/** 从 exec 取会话标识（三处写入共用的口径）。 */
function sessionOf(exec) {
  // ⚠ 取值口径必须与官方桥一致（lib/index.js:349-354）——真实会话 id 在 agent.session.header.id。
  // 2026-10-10 实测：只认 exec.sessionId / agent.sessionId / agent.id 会全部取空，
  // 于是所有会话退化成同一个 'dsh-native'（真实 AUDIT.log 里 439 条记录都记在 dsh-native 名下，
  // 而取值正确的 seams 写的是 sess_<uuid>）——这会造成跨会话状态与审计互相污染。
  return (
    (exec &&
      ((exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.id) ||
        exec.sessionId ||
        (exec.agent && (exec.agent.sessionId || exec.agent.id)))) ||
    'dsh-native'
  )
}

/** 拦截写入一条审计记录（JSONL 追加，字段与 hooks/guard.mjs 口径一致） */
export function auditDeny(exec, cmd) {
  return appendAudit({
    ts: new Date().toISOString(),
    session: sessionOf(exec),
    action: 'deny',
    trigger: 'high-risk-rm',
    level: 3,
    evidence: String(cmd).slice(0, 120),
    pardon: false,
  })
}

/**
 * 红线上下文豁免留痕（3.0.6 P0，HANDOFF §八）。
 * 命中绝对红线但被判为"被引用的命令字符串"而豁免时调用——豁免不是静默放行，必须可审计。
 */
export function auditRedlineExempt(exec, cmd, detail = {}) {
  return appendAudit({
    ts: new Date().toISOString(),
    session: sessionOf(exec),
    action: 'redline-exempt',
    trigger: detail.redline || 'absolute-redline',
    level: null,
    basis: detail.basis || null,
    evidence: `${detail.detail || ''} | ${String(cmd).slice(0, 120)}`.slice(0, 300),
    pardon: false,
  })
}

/**
 * 成本台账落卷目标。
 * 默认 = 仓库根 `.ai/CASE_FILE.md`；`FG_CASE_FILE` 可覆盖——测试**必须**用它重定向到临时目录，
 * 否则自检会写进人类真实卷宗（2026-10-07 事故）。落盘前另有一道守卫，见 appendCostRow。
 */
export function caseFilePath() {
  return process.env.FG_CASE_FILE || fileURLToPath(new URL('../../../../.ai/CASE_FILE.md', import.meta.url))
}

const COST_MARK = '【五】成本台账'

/** 成本台账落卷：卷宗无该章节则先补表头，再逐行追加；失败只 warn 不阻塞 */
export function appendCostRow(ts, model, inPeak, usage) {
  try {
    let header = ''
    try {
      if (!readFileSync(caseFilePath(), 'utf8').includes(COST_MARK)) {
        header =
          '\n### 【五】成本台账（DSH 原生插件自动追加；tokens / USD）\n\n' +
          '| 时间 | 模型 | 时段 | 输入未缓存 | 缓存读 | 输出 | 成本USD |\n' +
          '|---|---|---|---|---|---|---|\n'
      }
    } catch (error) {
      console.warn(
        '[focus-guard-native] 读卷宗失败，按无表头处理（写入仍尝试）:',
        (error && error.message) || error,
      )
    }
    const usd = calcCost(model, usage, inPeak)
    const target = caseFilePath()
    // 写守卫：目标必须是默认卷宗路径，或调用方显式用 FG_CASE_FILE 重定向（测试用）。
    // 其余一律拒写——防止任何代码路径把台账写到意料之外的位置。
    const DEFAULT_CASE_FILE = fileURLToPath(new URL('../../../../.ai/CASE_FILE.md', import.meta.url))
    if (target !== DEFAULT_CASE_FILE && !process.env.FG_CASE_FILE) {
      throw new Error(`成本台账目标异常，拒绝写入：${target}`)
    }
    appendFileSync(
      target,
      `${header}| ${ts} | ${model} | ${inPeak ? '峰' : '谷'} | ${usage.input} | ${usage.cacheRead} | ${usage.output} | ${usd === null ? '未知价目' : usd.toFixed(6)} |\n`,
    )
  } catch (error) {
    console.warn('[focus-guard-native] 成本台账写入失败（不阻塞）:', (error && error.message) || error)
  }
}
