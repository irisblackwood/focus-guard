/**
 * 第 2 层·语义预判（可插拔）+ 观察模式（2026-10-27 从 pipeline.mjs 抽出，纯搬运）。
 *
 * 接口：`riskOf(cmd, tool)` 返回 {risk, category, reasons, backend}；
 * 默认实现真哨兵（sentinel.py），失败/缺失时由调用方保守 ask，不静默放行。
 * 观察模式：累计判定数未达标前，高危只留痕 + 告警、不返回 ask（由人类决定何时启用）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { auditDeny } from '../audit.mjs'
import { RM_RF } from './redline.mjs'

export const RISK_ASK_THRESHOLD = 0.85

const clampRisk = (n) => Math.min(0.99, Math.max(0, Number(n) || 0))

const HEURISTIC_RULES = [
  { re: /\|\s*(?:sh|bash|zsh|cmd|powershell|pwsh)\b/i, cat: 'pipe_to_shell', w: 0.55 },
  // 重定向 0.3 → 0.15（2026-10-18）：`>` 本身不是破坏性动作，它只是"会写文件"。
  // 旧权重下 Remove-Item(0.6) + 一条重定向就 0.9 越线，把"清 TEMP + 存日志"这种常规脚本判成高危。
  { re: /[>]{1,2}\s*\S/, cat: 'redirect', w: 0.15 },
  { re: /\b(?:child_process|execSync|spawnSync|subprocess|os\.system)\b/, cat: 'subprocess', w: 0.5 },
  { re: RM_RF, cat: 'fs_mutation', w: 0.3 },
  { re: /\b(?:mv|dd|truncate)\s/, cat: 'fs_mutation', w: 0.3 },
  { re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+\.)/, cat: 'history_overwrite', w: 0.6 },
]

// ── 破坏性 API：按目标分级（2026-10-18 修）──
// 旧实现只看动词，权重恒 0.6：清 TEMP 单文件与递归删系统目录同分，而且 +重定向就误伤。
// 现在按"打哪里"给权：系统路径/递归 → 0.9（必拦）；TEMP → 0.2（不拦）；其余 → 0.4。
const DESTRUCTIVE_API = /\b(?:shutil\.rmtree|fs\.rmSync|Remove-Item)\b/i
const SYSTEM_PATH =
  /(?:[A-Za-z]:\\(?:Windows|Program Files|ProgramData)|(?:^|[\s"'=])\/(?:usr|etc|bin|sbin|var|lib|boot|sys|proc|opt|root)(?:\/|$))/i
const RECURSIVE_FLAG = /-Recurse\b|\brmdirSync\s*\(|recursive\s*:\s*true/i
const TEMP_TARGET = /\$(?:env:)?TEMP\b|%TEMP%|\\Temp\\|\/tmp\//i

function destructiveApiWeight(cmd) {
  const text = String(cmd ?? '')
  if (!DESTRUCTIVE_API.test(text)) return 0
  if (/shutil\.rmtree/i.test(text)) return 0.9 // rmtree 天生递归
  if (SYSTEM_PATH.test(text) || RECURSIVE_FLAG.test(text)) return 0.9
  if (TEMP_TARGET.test(text)) return 0.2
  return 0.4 // 未知目标：中间档，不拦但会进审批视野
}

/**
 * 启发式兜底实现。
 * @returns {{risk:number, category:string, reasons:string[]}}
 */
export function riskOfHeuristic(cmd, tool) {
  const text = cmd ?? ''
  const hits = HEURISTIC_RULES.filter((r) => r.re.test(text)).map((r) => ({ cat: r.cat, w: r.w }))
  const destructive = destructiveApiWeight(text)
  if (destructive > 0) hits.push({ cat: 'destructive_api', w: destructive })
  return {
    risk: clampRisk(hits.reduce((a, h) => a + h.w, 0)),
    category: hits.slice().sort((a, b) => b.w - a.w)[0]?.cat || 'benign',
    reasons: hits.map((h) => h.cat),
  }
}

/** 审批单形状（对齐 dsh-tools/lib/index.js:3439-3458：reason 必填，displayReason 可选） */
export function buildAsk(cmd, risk, category, extra) {
  return {
    kind: 'ask',
    reason: `focus-guard-native 第2层语义预判：risk=${risk} category=${category} 命令=${String(cmd).slice(0, 120)}`,
    displayReason: `高危但可审批（${category}，risk ${risk}）${extra ? ' — ' + extra : ''}`,
  }
}

// ── 第 2 层·真哨兵接线（观察模式）──
const SENTINEL_PY = fileURLToPath(new URL('../sentinel.py', import.meta.url))
const SENTINEL_TIMEOUT_MS = 1500 // 实测 Needle 冷启 0.30s / 单次 0.13-0.42s → 取 ~5x 余量
// `FG_PYTHON` 仅环境适配：宿主 python 不在 PATH 或需指定版本时用，测试也可借此指向假哨兵。
const SENTINEL_PYTHON = process.env.FG_PYTHON || 'python'
const OBSERVE_UNTIL_JUDGEMENTS = 50 // 观察模式：累计 50 次真实判定后才允许启用 ask

const OBSERVATION = { effective: false, judgements: 0, highRisk: 0 }

export { OBSERVATION }
let observeNoticeEmitted = false

/**
 * sentinel.py 的 Node 侧接线：execFileSync 调子进程，超时/异常/解析失败一律抛错，
 * 由调用方转成保守 ask（不静默放行）。HF_HOME 只注入子进程 env，不写全局。
 *
 * 2026-10-18 加**结论缓存**：判定基准实测每条 Bash 命令都要付 ~60ms 的 python 冷启动，
 * 而同一命令在会话里会反复出现（重试、复测、同一脚本多轮）。按命令内容哈希缓存**成功结论**，
 * 失败（超时/缺 python/解析失败）一律不缓存——下次仍要重试，不能把错误固化成结论。
 * `FG_SENTINEL_CACHE=0` 关闭；`FG_SENTINEL_CACHE_SIZE` 调容量（默认 500，LRU）。
 */
const SENTINEL_CACHE_OFF = process.env.FG_SENTINEL_CACHE === '0'
const SENTINEL_CACHE_LIMIT = Number(process.env.FG_SENTINEL_CACHE_SIZE) || 500
const sentinelCache = new Map()

/** 缓存命中/未命中计数（自检与基准用只读快照）。 */
export const sentinelCacheStats = { hits: 0, misses: 0 }

/** 测试钩子：清空缓存与计数。 */
export function resetSentinelCache() {
  sentinelCache.clear()
  sentinelCacheStats.hits = 0
  sentinelCacheStats.misses = 0
}

function runSentinel(cmd) {
  const out = execFileSync(SENTINEL_PYTHON, [SENTINEL_PY, '--cmd', String(cmd ?? '')], {
    encoding: 'utf8',
    timeout: SENTINEL_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, HF_HOME: process.env.HF_HOME || 'E:\\venvs\\hf-cache', FG_SENTINEL_CALLER: 'focus-guard' },
  })
  const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop()
  if (!line) throw new Error('sentinel 无输出')
  const verdict = JSON.parse(line)
  if (!verdict || typeof verdict !== 'object') throw new Error('sentinel 输出非对象')
  return verdict
}

export function riskOfSentinel(cmd) {
  if (SENTINEL_CACHE_OFF) return runSentinel(cmd)
  const key = String(cmd ?? '')
  const hit = sentinelCache.get(key)
  if (hit !== undefined) {
    sentinelCacheStats.hits += 1
    // LRU：命中后移到队尾（Map 保持插入序）
    sentinelCache.delete(key)
    sentinelCache.set(key, hit)
    return hit
  }
  sentinelCacheStats.misses += 1
  const verdict = runSentinel(cmd)
  sentinelCache.set(key, verdict)
  while (sentinelCache.size > SENTINEL_CACHE_LIMIT) {
    const oldest = sentinelCache.keys().next().value
    sentinelCache.delete(oldest)
  }
  return verdict
}

/**
 * pre-execute 阶段：语义预判（工具调用 write/read 等无命令参数时零打扰透传）。
 * 判定异常 → 保守 ask（不静默放行）；观察模式高危只留痕。
 */
export async function riskStage(ctx) {
  const { exec, warn, cmd, riskOf, observe } = ctx
  if (!cmd) return null
  const tool = String((exec && exec.name) || '')
  let verdict
  try {
    verdict = await riskOf(cmd, tool)
  } catch (error) {
    warn('第2层判定失败，保守走审批：', (error && error.message) || error)
    return buildAsk(cmd, 'error', 'judge_failed', (error && error.message) || String(error))
  }
  const risk = clampRisk(verdict && verdict.risk)
  const category = (verdict && verdict.category) || 'unknown'
  const reasons = (verdict && verdict.reasons) || []
  const backend = (verdict && verdict.backend) || 'unknown'
  observe.judgements += 1
  if (reasons.length > 0) warn(`第2层启发式命中（risk=${risk}）：`, reasons.join(','))
  if (risk > RISK_ASK_THRESHOLD) {
    observe.highRisk += 1
    // 观察模式：留痕 + 告警，但放行（不返回 ask），直到累计判定数达标并由人类启用
    auditDeny(exec, `risk=${risk} category=${category} backend=${backend} | ${String(cmd).slice(0, 100)}`, {
      trigger: `risk:${category}`,
      level: 2,
    })
    warn(
      `第2层高危但观察模式放行（risk=${risk} category=${category} backend=${backend} judgements=${observe.judgements}）：`,
      cmd.slice(0, 120),
    )
    if (!observeNoticeEmitted && observe.judgements >= OBSERVE_UNTIL_JUDGEMENTS) {
      observeNoticeEmitted = true
      warn(
        `观察模式已累计 ${observe.judgements} 次判定（高危 ${observe.highRisk} 次），可评估是否启用 ask（由人类决定）`,
      )
    }
    if (observe.effective) return buildAsk(cmd, risk, category)
  }
  return null
}
