/**
 * 版本一致性 + 成本相关两条缝（2026-10-27 从 pipeline.mjs 抽出，纯搬运）。
 *
 * ① system-prompt/assemble：峰谷成本提示行注入；
 * ② tools/post-execute：token 用量折算 → 成本台账落卷（只观测，不改决策）。
 * 外加「磁盘代码 vs 内存实例」一致性提示（FG 是 link 挂载，启动后改盘不会热更）。
 */
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { appendCostRow } from '../audit.mjs'
import { isPeakAt, isSaveStreamEnabled } from '../../peak-cost.mjs'

/** 每次改动流水线递增；用于磁盘/内存版本一致性提示 */
const PIPELINE_VERSION = '3.2.1-m1'

// 比对对象仍是 src/dsh/pipeline.mjs 的 mtime（本模块位于 src/dsh/guard/ 下）。
const PIPELINE_FILE = fileURLToPath(new URL('../pipeline.mjs', import.meta.url))

/**
 * 运行实例的"内存版本时间戳"：模块加载（DSH 启动）时采一次。
 * FG 是 link 挂载，启动后改盘不会重新加载 —— 与磁盘 mtime 比对即可发现"跑旧代码"。
 */
const MEM_PIPELINE_MTIME = (() => {
  try {
    return statSync(PIPELINE_FILE).mtimeMs
  } catch {
    return null
  }
})()

let diskVersionWarned = false

/** 单次检查：磁盘与内存不一致 → 警告一次（warn 只写日志，不抛错、不阻塞） */
export function warnIfStaleOnce(warn) {
  if (diskVersionWarned || MEM_PIPELINE_MTIME === null) return false
  try {
    const diskMtime = statSync(PIPELINE_FILE).mtimeMs
    if (diskMtime === MEM_PIPELINE_MTIME) return false
    diskVersionWarned = true
    warn(
      `[focus-guard] 磁盘代码已更新（${PIPELINE_VERSION}，磁盘 mtime=${diskMtime} ≠ 内存 mtime=${MEM_PIPELINE_MTIME}），当前运行实例为旧版，请重启 DSH`,
    )
    return true
  } catch (error) {
    warn('版本一致性检查失败（不阻塞）:', (error && error.message) || error)
    return false
  }
}

const PIPELINE_VERSION_INFO = { version: PIPELINE_VERSION, memoryMtime: MEM_PIPELINE_MTIME }

/** 供自检/诊断调用：返回本次是否检出磁盘更新 */
export function checkDiskVersion(warn = console.warn) {
  return warnIfStaleOnce(warn)
}

export { PIPELINE_VERSION_INFO }

/** 成本提示行（≤30 字；省流开启时追加后缀） */
function promptCostLine() {
  let base
  try {
    base = isPeakAt(new Date()).inPeak
      ? '【成本】高峰时段，建议压缩输出。'
      : '【成本】低谷时段，可放心输出。'
  } catch {
    base = '【成本】低谷时段，可放心输出。'
  }
  try {
    return isSaveStreamEnabled() ? base + '（主动省流已开）' : base
  } catch {
    return base
  }
}

/** 兼容多家常字段名的用量提取；无用量返回 null */
function usageOf(u) {
  if (!u || typeof u !== 'object') return null
  const usage = {
    input: u.input ?? u.input_tokens ?? u.prompt_tokens,
    cacheRead: u.cacheRead ?? u.cache_read_input_tokens ?? u.prompt_cache_hit_tokens,
    output: u.output ?? u.output_tokens ?? u.completion_tokens,
  }
  return usage.input || usage.output ? usage : null
}

/** 成本台账停摆检测（2026-10-18）：连续多少条工具结果拿不到 usage 就告警一次。 */
const COST_MISS_WARN_AT = 5
let costMissStreak = 0

/**
 * 把成本行追加到下游装配结果里（形状见 dsh-system-prompt/lib/index.js:338-354）。
 * 官方 assembly 顶层没有 text/system 字段，因此优先以新增 section 的方式注入
 * （原实现遍历 text/system 等键，恒不命中）；其余形状为兼容分支。
 */
function appendCostLine(downstream, line) {
  if (typeof downstream === 'string') return downstream ? downstream + '\n' + line : line
  if (Array.isArray(downstream)) return [...downstream, line]
  if (!downstream || typeof downstream !== 'object') return downstream
  if (Array.isArray(downstream.sections)) {
    return { ...downstream, sections: [...downstream.sections, { name: 'focus-guard-cost', text: line }] }
  }
  for (const k of ['system', 'systemPrompt', 'text', 'prompt']) {
    if (typeof downstream[k] === 'string') return { ...downstream, [k]: downstream[k] + '\n' + line }
  }
  return downstream
}

/** ② 系统提示装配：追加成本提示行（改写失败原样放行下游） */
export function systemPromptListener({ warn }) {
  return async (assembly, context, next) => {
    warnIfStaleOnce(warn)
    let downstream
    try {
      downstream = await next()
      return appendCostLine(downstream, promptCostLine())
    } catch (error) {
      warn('system-prompt 注入异常，原样放行：', (error && error.message) || error)
    }
    return downstream
  }
}

/** ③ 工具执行后：用量折算落台账（只观测；next 缺失时兜底 undefined，不影响下游默认决策） */
export function postExecuteListener({ warn }) {
  return async (exec, result, next) => {
    try {
      const usage =
        usageOf(result && result.usage) ||
        usageOf(exec && exec.usage) ||
        usageOf(result && result.meta && result.meta.usage)
      if (usage) {
        costMissStreak = 0
        const model =
          (exec && ((exec.agent && (exec.agent.model || exec.agent.modelId)) || exec.model)) ||
          (result && result.model) ||
          'unknown'
        const { inPeak } = isPeakAt(new Date())
        appendCostRow(new Date().toISOString(), model, inPeak, usage)
      } else {
        // 2026-10-18 修（REPORT-2026-10-12「成本台账静默停摆」）：原实现无 else——
        // 宿主不提供 usage 时整条成本核算静默失效（台账 10-08 起零新增，没人发现）。
        // 连续多次拿不到就 warn 一次，把"停摆"变成可见信号。
        costMissStreak += 1
        if (costMissStreak === COST_MISS_WARN_AT) {
          warn(
            `成本台账停摆：连续 ${COST_MISS_WARN_AT} 次工具结果都没有 usage 字段（宿主未提供），本会话成本未记账。`,
          )
        }
      }
    } catch (error) {
      warn('成本核算异常（不阻塞）:', (error && error.message) || error)
    }
    return next()
  }
}
