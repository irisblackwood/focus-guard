/**
 * focus-guard 原生插件 · 三缝流水线（3.0.5）
 *
 * ① tools/pre-execute：rm -rf 族拦截 + 审计留痕；
 * ② system-prompt/assemble：峰谷成本提示行注入；
 * ③ tools/post-execute：token 用量折算 → 成本台账落卷（只观测，不改决策）。
 *
 * 各缝独立 fail-open：判定/注入/核算异常一律放行或原样透传，绝不阻塞 DSH 主流程。
 * 缝契约证据（本机 DSH Desktop 0.2.0-rc.2 装机源码）：
 *   - dsh-tools/lib/index.js:3225  pre-execute 瀑布 fallback {kind:"allow"}，gate.kind==="ask" 走审批；
 *   - dsh-hooks-claude-code/lib/index.js:255-258  deny 形状 {kind:"deny", reason}；
 *   - dsh-tools/lib/index.js:3504  post-execute 三参瀑布 (exec, result, next)。
 */
import { auditDeny, appendCostRow } from './audit.mjs'
import { isPeakAt, isSaveStreamEnabled } from '../peak-cost.mjs'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 每次改动本文件递增；用于磁盘/内存版本一致性提示 */
const PIPELINE_VERSION = '3.0.5-m1'

/**
 * 运行实例的"内存版本时间戳"：模块加载（DSH 启动）时采一次。
 * FG 是 link 挂载，启动后改磁盘不会重新加载 —— 与磁盘 mtime 比对即可发现"跑旧代码"。
 */
const MEM_PIPELINE_MTIME = (() => {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtimeMs
  } catch {
    return null
  }
})()

let diskVersionWarned = false

/** 单次检查：磁盘与内存不一致 → 警告一次（warn 只写日志，不抛错、不阻塞） */
function warnIfStaleOnce(warn) {
  if (diskVersionWarned || MEM_PIPELINE_MTIME === null) return false
  try {
    const diskMtime = statSync(fileURLToPath(import.meta.url)).mtimeMs
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

export const PIPELINE_VERSION_INFO = { version: PIPELINE_VERSION, memoryMtime: MEM_PIPELINE_MTIME }

/** 供自检/诊断调用：返回本次是否检出磁盘更新 */
export function checkDiskVersion(warn = console.warn) {
  return warnIfStaleOnce(warn)
}

/** rm 后跟单簇旗标且同时含 r 与 f（任意顺序）：rm -rf / rm -fr / rm -Rdf …（第 1 层·普通档，模糊命令） */
const RM_RF = /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*(?:r\w*f|f\w*r)\w*\b/

// ── 第 1 层·绝对红线（零延迟短路 deny，不进第 2 层）──
// rm 递归强删根/HOME 族：rm -rf / ... 、rm -rf ~ ...（后随任意字符即命中本档）
const RM_RF_ROOT = /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*(?:r\w*f|f\w*r)\w*\s+["']?[\/~][\/\s"']*(?=\s|["']|$)/
/** 破坏库结构：DROP DATABASE / DROP SCHEMA / TRUNCATE TABLE */
const DROP_DB = /\b(?:drop\s+(?:database|schema)|truncate\s+table)\b/i
/** 强制推送：git push -f / --force / --force-with-lease */
const GIT_PUSH_FORCE = /\bgit\s+push\b[^\n]*\s(?:-f|--force(?:-with-lease)?)\b/i

export const ABSOLUTE_REDLINES = [
  { name: 'rm-rf-root', re: RM_RF_ROOT },
  { name: 'drop-database', re: DROP_DB },
  { name: 'git-push-force', re: GIT_PUSH_FORCE },
]

/** 命中哪条绝对红线；未命中返回 null */
export function redlineOf(cmd) {
  if (!cmd) return null
  return ABSOLUTE_REDLINES.find((r) => r.re.test(cmd)) || null
}

/** 提取命令类参数；非命令类工具（write/read 等）返回 null，不做检查 */
function commandOf(exec) {
  const args = exec && exec.arguments
  if (!args || typeof args !== 'object') return null
  const cmd = args.command ?? args.cmd ?? args.script
  return typeof cmd === 'string' ? cmd : null
}

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

// ── 第 2 层：语义预判（接口可插拔；M3 换成 Needle 2 实现）──
export const RISK_ASK_THRESHOLD = 0.85

const clampRisk = (n) => Math.min(0.99, Math.max(0, Number(n) || 0))

const HEURISTIC_RULES = [
  { re: /\|\s*(?:sh|bash|zsh|cmd|powershell|pwsh)\b/i, cat: 'pipe_to_shell', w: 0.55 },
  { re: /[>]{1,2}\s*\S/, cat: 'redirect', w: 0.3 },
  { re: /\b(?:child_process|execSync|spawnSync|subprocess|os\.system)\b/, cat: 'subprocess', w: 0.5 },
  { re: /\b(?:shutil\.rmtree|fs\.rmSync|Remove-Item)\b/i, cat: 'destructive_api', w: 0.6 },
  { re: RM_RF, cat: 'fs_mutation', w: 0.3 },
  { re: /\b(?:mv|dd|truncate)\s/, cat: 'fs_mutation', w: 0.3 },
  { re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+\.)/, cat: 'history_overwrite', w: 0.6 },
]

/**
 * 启发式兜底实现（本阶段 mock 语义）：命中规则累加权重、上限 0.99。
 * 当前规则最高累加 0.6 —— 设计上**恒不越过 0.85 阈值**，因此不产生 ask；
 * 阈值分支由测试/未来 Needle 2 实现驱动（见 preExecuteListener 的 riskOf 注入）。
 * @returns {{risk:number, category:string, reasons:string[]}}
 */
export function riskOfHeuristic(cmd, tool) {
  const hits = HEURISTIC_RULES.filter((r) => r.re.test(cmd ?? ''))
  return {
    risk: clampRisk(hits.reduce((a, r) => a + r.w, 0)),
    category: hits.slice().sort((a, b) => b.w - a.w)[0]?.cat || 'benign',
    reasons: hits.map((r) => r.cat),
  }
}

/** 审批单形状（对齐 dsh-tools/lib/index.js:3439-3458：reason 必填，displayReason 可选） */
function buildAsk(cmd, risk, category, extra) {
  return {
    kind: 'ask',
    reason: `focus-guard-native 第2层语义预判：risk=${risk} category=${category} 命令=${String(cmd).slice(0, 120)}`,
    displayReason: `高危但可审批（${category}，risk ${risk}）${extra ? ' — ' + extra : ''}`,
  }
}

/** ① 工具执行前：三层分流 —— ①绝对红线短路 deny ②语义预判 risk>阈值 → ask，否则放行 ③（M4 接入状态校验） */
export function preExecuteListener({ warn, riskOf = riskOfHeuristic }) {
  return async (exec, next) => {
    warnIfStaleOnce(warn)
    let cmd
    try {
      cmd = commandOf(exec)
      if (cmd) {
        const redline = redlineOf(cmd)
        if (redline) {
          warn(`已拦截绝对红线（${redline.name}）：`, cmd.slice(0, 120))
          auditDeny(exec, cmd)
          return {
            kind: 'deny',
            reason: `focus-guard-native: 命中绝对红线「${redline.name}」，直接拒绝（不弹审批）；如确需执行请说明理由后人工处理`,
          }
        }
      }
    } catch (error) {
      warn('红线判定异常，fail-open 放行：', (error && error.message) || error)
      return next()
    }

    // 第 2 层：语义预判（可插拔）。无命令参数的调用零打扰透传。
    if (cmd) {
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
      if (reasons.length > 0) warn(`第2层启发式命中（risk=${risk}）：`, reasons.join(','))
      if (risk > RISK_ASK_THRESHOLD) {
        warn(`第2层判定高危但可审批（risk=${risk} category=${category}）：`, cmd.slice(0, 120))
        return buildAsk(cmd, risk, category)
      }
    }
    return next()
  }
}

/** ② 系统提示装配：追加成本提示行（改写失败原样放行下游） */
export function systemPromptListener({ warn }) {
  return async (assembly, context, next) => {
    warnIfStaleOnce(warn)
    let downstream
    try {
      downstream = await next()
      const line = promptCostLine()
      if (typeof downstream === 'string') return downstream ? downstream + '\n' + line : line
      if (Array.isArray(downstream)) return [...downstream, line]
      if (downstream && typeof downstream === 'object') {
        // 官方 assembly 形状（dsh-system-prompt/lib/index.js:338-354）：
        // { sections:[{name,text}], contexts, tools, variables } —— 顶层没有 text/system 字段，
        // 因此成本行以新增 section 的方式注入（原实现遍历 text/system 等键，恒不命中）。
        if (Array.isArray(downstream.sections)) {
          return { ...downstream, sections: [...downstream.sections, { name: 'focus-guard-cost', text: line }] }
        }
        for (const k of ['system', 'systemPrompt', 'text', 'prompt']) {
          if (typeof downstream[k] === 'string') {
            return { ...downstream, [k]: downstream[k] + '\n' + line }
          }
        }
      }
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
        const model =
          (exec && ((exec.agent && (exec.agent.model || exec.agent.modelId)) || exec.model)) ||
          (result && result.model) ||
          'unknown'
        const { inPeak } = isPeakAt(new Date())
        appendCostRow(new Date().toISOString(), model, inPeak, usage)
      }
    } catch (error) {
      warn('成本核算异常（不阻塞）:', (error && error.message) || error)
    }
    return next()
  }
}
