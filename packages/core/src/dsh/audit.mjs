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
export const CASE_FILE = fileURLToPath(new URL('../../../../.ai/CASE_FILE.md', import.meta.url))

/** 拦截写入一条审计记录（JSONL 追加，字段与 hooks/guard.mjs 口径一致） */
export function auditDeny(exec, cmd) {
  try {
    appendFileSync(
      AUDIT_FILE,
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

const COST_MARK = '【五】成本台账'

/** 成本台账落卷：卷宗无该章节则先补表头，再逐行追加；失败只 warn 不阻塞 */
export function appendCostRow(ts, model, inPeak, usage) {
  try {
    let header = ''
    try {
      if (!readFileSync(CASE_FILE, 'utf8').includes(COST_MARK)) {
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
    appendFileSync(
      CASE_FILE,
      `${header}| ${ts} | ${model} | ${inPeak ? '峰' : '谷'} | ${usage.input} | ${usage.cacheRead} | ${usage.output} | ${usd === null ? '未知价目' : usd.toFixed(6)} |\n`,
    )
  } catch (error) {
    console.warn('[focus-guard-native] 成本台账写入失败（不阻塞）:', (error && error.message) || error)
  }
}
