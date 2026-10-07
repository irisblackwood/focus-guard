/**
 * DeepSeek 峰谷成本核算（3.0.5 阶段一：收编 dsh-peak-cost-mode 职能）
 *
 * 常量以官方 2026-09-10 价目为准，核对底稿见 docs/deepseek-pricing-audit.md。
 * 零依赖；一切时段判定按北京时间（UTC+8）计算，与宿主机器时区无关。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 2026 法定节假日（国办发明电〔2025〕7号）：7 段共 33 天，MM-DD */
const HOLIDAYS_2026 = new Set([
  '01-01', '01-02', '01-03',
  '02-15', '02-16', '02-17', '02-18', '02-19', '02-20', '02-21', '02-22', '02-23',
  '04-04', '04-05', '04-06',
  '05-01', '05-02', '05-03', '05-04', '05-05',
  '06-19', '06-20', '06-21',
  '09-25', '09-26', '09-27',
  '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07',
])

/** 调休上班日（CONSERVATIVE：官方安排待实测核实，先按工作日保守处理） */
const MAKEUP_WORKDAYS_2026 = new Set(['09-20', '10-10'])

/** 高峰窗口（北京时间，分钟制，左闭右开）：9:00-12:00、14:00-18:00 */
const PEAK_WINDOWS = [
  [540, 720],
  [840, 1080],
]

/** 北京时间墙钟部件（把时刻平移 +8h 后读 UTC 部件，不受宿主时区影响） */
function beijingWall(date) {
  const d = date instanceof Date ? date : new Date(date)
  const t = d.getTime()
  if (Number.isNaN(t)) throw new TypeError('invalid date: ' + String(date))
  const bj = new Date(t + 480 * 60000)
  const md =
    String(bj.getUTCMonth() + 1).padStart(2, '0') + '-' + String(bj.getUTCDate()).padStart(2, '0')
  return { md, minutes: bj.getUTCHours() * 60 + bj.getUTCMinutes(), dow: bj.getUTCDay() }
}

/**
 * 峰谷判定。优先级：法定节假日 → 谷；调休上班日 → 保守按工作日；周末 → 谷；平日 → 按窗口。
 * @param {Date|string|number} date
 * @returns {{ inPeak: boolean, source: 'holiday'|'workday'|'weekend'|'peak-window'|'off-peak' }}
 */
export function isPeakAt(date) {
  const { md, minutes, dow } = beijingWall(date)
  if (HOLIDAYS_2026.has(md)) return { inPeak: false, source: 'holiday' }
  const inWindow = PEAK_WINDOWS.some(([a, b]) => minutes >= a && minutes < b)
  if (MAKEUP_WORKDAYS_2026.has(md)) return { inPeak: inWindow, source: 'workday' }
  if (dow === 0 || dow === 6) return { inPeak: false, source: 'weekend' }
  return inWindow ? { inPeak: true, source: 'peak-window' } : { inPeak: false, source: 'off-peak' }
}

/** 官方价目（USD / 1M tokens，2026-09-10 生效；空闲 = 高峰的一半） */
export const PRICING_USD = {
  effective: '2026-09-10',
  currency: 'USD',
  unit: 'per-1M-tokens',
  models: {
    'deepseek-flash': {
      peak: { inputCacheHit: 0.006, inputCacheMiss: 0.3, output: 1.2 },
      offPeak: { inputCacheHit: 0.003, inputCacheMiss: 0.15, output: 0.6 },
    },
    'deepseek-v4-pro': {
      peak: { inputCacheHit: 0.044, inputCacheMiss: 1.32, output: 3.96 },
      offPeak: { inputCacheHit: 0.022, inputCacheMiss: 0.66, output: 1.98 },
    },
  },
}

/** 旧模型名路由（已下线：请求实际由 V4.1-Flash 服务，按 Flash 价计费） */
const MODEL_ALIAS = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

/**
 * 折算 USD。usage: { input, cacheRead, output }（单位 tokens；input = 未缓存输入）。
 * 未知模型或 usage 缺失返回 null（调用方自行降级），不做汇率换算。
 * @returns {number|null} USD 金额
 */
export function calcCost(modelId, usage, isPeak) {
  if (!usage) return null
  const id = MODEL_ALIAS[modelId] || modelId
  const price = PRICING_USD.models[id]
  if (!price) return null
  const tier = isPeak ? price.peak : price.offPeak
  const M = 1e6
  const u = {
    input: Number(usage.input) || 0,
    cacheRead: Number(usage.cacheRead) || 0,
    output: Number(usage.output) || 0,
  }
  return (
    (u.input / M) * tier.inputCacheMiss +
    (u.cacheRead / M) * tier.inputCacheHit +
    (u.output / M) * tier.output
  )
}

/**
 * 主动省流开关：环境变量 FG_SAVE_STREAM=1，或仓库根 .focus-guard/save-stream.flag 存在即开启。
 * 读取失败一律视为关闭（fail-open 反向：省流提示宁缺勿误）。
 */
export function isSaveStreamEnabled(env = process.env) {
  if (String(env.FG_SAVE_STREAM || '').trim() === '1') return true
  try {
    const flag = fileURLToPath(new URL('../../../.focus-guard/save-stream.flag', import.meta.url))
    return existsSync(flag)
  } catch {
    return false
  }
}
