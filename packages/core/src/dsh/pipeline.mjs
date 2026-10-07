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

/** ① 工具执行前：两档分流 —— 绝对红线短路 deny；普通 rm -rf 交由下游层（审计留痕失败不影响拦截本身） */
export function preExecuteListener({ warn }) {
  return async (exec, next) => {
    try {
      const cmd = commandOf(exec)
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
      warn('判定异常，fail-open 放行：', (error && error.message) || error)
    }
    return next()
  }
}

/** ② 系统提示装配：追加成本提示行（改写失败原样放行下游） */
export function systemPromptListener({ warn }) {
  return async (assembly, context, next) => {
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
