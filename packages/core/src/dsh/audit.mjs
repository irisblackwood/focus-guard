/**
 * focus-guard 原生插件 · 审计接入（3.0.5）
 *
 * 卷宗写入口：AUDIT.log（拦截留痕）与 CASE_FILE.md（成本台账）。
 * 一切写入独立 try/catch：留痕失败只 warn，绝不阻断宿主主流程；
 * 也绝不因写失败把拦截降级成放行（见 pipeline.mjs 调用次序）。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { calcCost } from '../peak-cost.mjs'

// 插件文件位于 <仓库根>/packages/core/src/dsh/ → 上溯 4 级到仓库根
export const AUDIT_FILE = fileURLToPath(new URL('../../../../.focus-guard/AUDIT.log', import.meta.url))

/**
 * 成本台账落卷目标。
 * 默认 = 仓库根 `.ai/CASE_FILE.md`；`FG_CASE_FILE` 可覆盖——测试**必须**用它重定向到临时目录，
 * 否则自检会写进人类真实卷宗（2026-10-07 事故）。落盘前另有一道守卫，见 appendCostRow。
 */
export function caseFilePath() {
  return process.env.FG_CASE_FILE || fileURLToPath(new URL('../../../../.ai/CASE_FILE.md', import.meta.url))
}

/** 拦截写入一条审计记录（JSONL 追加，字段与 hooks/guard.mjs 口径一致） */
export function auditDeny(exec, cmd) {
  try {
    appendFileSync(
      // 2026-10-09 修：补 FG_AUDIT_FILE 重定向。此前本函数写死 AUDIT_FILE，而同文件的
      // auditRedlineExempt 支持重定向 —— 同一文件两种口径，导致跑测试时经
      // preExecuteListener → auditDeny 的拦截记录写进真实 <仓库>/.focus-guard/AUDIT.log。
      // 测试用 FG_AUDIT_FILE 指向 tmpdir 即完全隔离（与 caseFilePath 的 FG_CASE_FILE 同思路）。
      process.env.FG_AUDIT_FILE || AUDIT_FILE,
      JSON.stringify({
        ts: new Date().toISOString(),
        session:
          (exec && (exec.sessionId || (exec.agent && (exec.agent.sessionId || exec.agent.id)))) ||
          'dsh-native',
        action: 'deny',
        trigger: 'high-risk-rm',
        level: 3,
        evidence: String(cmd).slice(0, 120),
        pardon: false,
      }) + '\n',
    )
  } catch (error) {
    console.warn('[focus-guard-native] AUDIT 留痕失败（不阻断拦截）:', (error && error.message) || error)
  }
}

/**
 * 红线上下文豁免留痕（3.0.6 P0，HANDOFF §八）。
 * 命中绝对红线但被判为"被引用的命令字符串"而豁免时调用——豁免不是静默放行，必须可审计。
 */
export function auditRedlineExempt(exec, cmd, detail = {}) {
  try {
    appendFileSync(
      process.env.FG_AUDIT_FILE || AUDIT_FILE,
      JSON.stringify({
        ts: new Date().toISOString(),
        session:
          (exec && (exec.sessionId || (exec.agent && (exec.agent.sessionId || exec.agent.id)))) ||
          'dsh-native',
        action: 'redline-exempt',
        trigger: detail.redline || 'absolute-redline',
        level: null,
        basis: detail.basis || null,
        evidence: `${detail.detail || ''} | ${String(cmd).slice(0, 120)}`.slice(0, 300),
        pardon: false,
      }) + '\n',
    )
  } catch (error) {
    console.warn('[focus-guard-native] 红线豁免留痕失败（不阻断放行）:', (error && error.message) || error)
  }
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
