/**
 * focus-guard 原生插件 · 审计接入（3.0.5；3.0.8 起底层下沉）
 *
 * 卷宗写入口：AUDIT.log（拦截留痕）与 CASE_FILE.md（成本台账）。
 * 一切写入独立 try/catch：留痕失败只 warn，绝不阻断宿主主流程；
 * 也绝不因写失败把拦截降级成放行（见 pipeline.mjs 调用次序）。
 *
 * 2026-10-18 架构修正：通用的"JSONL 追加 + 体积轮转"下沉到 `src/core/audit-writer.mjs`，
 * 本文件只保留 **DSH 语义**（exec → session 口径、deny/红线豁免字段、成本台账）。
 * 理由：适配层 `eligibility-gate.mjs` 需要写审计，但适配层不能反向依赖宿主缝。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { calcCost } from '../peak-cost.mjs'
import {
  AUDIT_FILE,
  AUDIT_MAX_BYTES,
  AUDIT_ARCHIVE_KEEP,
  auditFilePath,
  appendAudit,
  rotateAuditIfNeeded,
} from '../core/audit-writer.mjs'

// 兼容旧的引用面：底层实现已下沉，这里继续对外暴露同名符号。
export { AUDIT_FILE, AUDIT_MAX_BYTES, AUDIT_ARCHIVE_KEEP, auditFilePath, appendAudit, rotateAuditIfNeeded }

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

/**
 * 拦截写入一条审计记录（JSONL 追加，字段与 hooks/guard.mjs 口径一致）。
 * 2026-10-18 修（REPORT-2026-10-12 P2）：trigger/level 原为常量 'high-risk-rm'/3，
 * 与真实拦截规则无关 —— `ls -la` 也被记成 "high-risk-rm"，审计无法回答"为什么被拦"。
 * 现由调用点传 detail.trigger（规则名），缺省才退回 'unspecified'。
 * @param {unknown} exec
 * @param {unknown} cmd
 * @param {{ trigger?: string, level?: number|null }} [detail]
 */
export function auditDeny(exec, cmd, detail = {}) {
  return appendAudit({
    ts: new Date().toISOString(),
    session: sessionOf(exec),
    action: 'deny',
    trigger: detail.trigger || 'unspecified',
    level: detail.level ?? 3,
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

/** 退化值守卫：宿主未提供可信 usage 时不再写假账（2026-10-18）。 */
let warnedDegenerate = false

/**
 * usage 是否可信。
 * 病根：`tools/post-execute` 收到的 usage 长期是 `{ input: 1, output: 1 }`（模型名也退化成 unknown），
 * 于是台账写进去的全是 1 token / 未知价目。宿主面板能显示真实用量，说明数据在宿主内部，
 * 只是没走这条缝。在拿到可信 usage 之前，宁可**不记**，也不留一页假账。
 * 判据：模型名不能是 unknown，且输入+输出 > 2（真实一次调用不可能只有 1~2 token）。
 */
function usageLooksReal(model, usage) {
  const input = Number(usage && (usage.input ?? usage.input_tokens))
  const output = Number(usage && (usage.output ?? usage.output_tokens))
  if (!Number.isFinite(input) || !Number.isFinite(output)) return false
  if (String(model || '').toLowerCase() === 'unknown') return false
  return input + output > 2
}

/** 成本台账落卷：卷宗无该章节则先补表头，再逐行追加；失败只 warn 不阻塞 */
export function appendCostRow(ts, model, inPeak, usage) {
  if (!usageLooksReal(model, usage)) {
    if (!warnedDegenerate) {
      warnedDegenerate = true
      console.warn(
        '[focus-guard-native] 成本 usage 不可信（model=%s, input=%s, output=%s），台账暂停写入；真实用量以宿主面板为准。',
        String(model || 'unknown'),
        String(usage && usage.input),
        String(usage && usage.output),
      )
    }
    return false
  }
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
