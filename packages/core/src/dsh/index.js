/**
 * focus-guard 原生 Cordis 插件（3.0.5 阶段一 · 最小可行原型）
 *
 * 宗旨：证明原生插件在 DSH 里「能拦、能放、能扛」——
 *   能拦：rm -rf 族命令在 tools/pre-execute 缝被拒，理由模型可见；
 *   能放：其余工具调用零打扰（next() 透传）；
 *   能扛：判定异常或注册异常一律 fail-open，绝不阻塞 DSH 主流程。
 *
 * 边界（阶段一刻意保持最小）：
 *   - 不调用、不改动 guard.mjs（ZCode 侧引擎原样运行，本文件零 import）；
 *   - 只判命令类参数（arguments.command/cmd/script），不检查写文件内容，
 *     不检查 PTC run_code（留给阶段二接 guard-core 时统一处理）；
 *   - 只识别单簇旗标组合（rm -rf / -fr / -Rf 等），拆分旗标（rm -r -f）
 *     留给 guard.mjs 特征库，避免阶段一自造半吊子特征库。
 *
 * 缝契约证据（本机 DSH Desktop 0.2.0-rc.2 装机源码）：
 *   - 消费端：@deepseek-ai/dsh-tools/lib/index.js:3225
 *       ctx.waterfall(carrier, "tools/pre-execute", exec, () => ({ kind: "allow" }))
 *     gate.kind === "ask" 走 serviceAsk 审批流；
 *   - deny 形状：@deepseek-ai/dsh-hooks-claude-code/lib/index.js:255-258
 *       { kind: "deny", reason } —— reason 为模型可见的拦截理由。
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { calcCost, isPeakAt, isSaveStreamEnabled } from '../peak-cost.mjs'

export const name = 'focus-guard'

// 拦截留痕：与 ZCode 侧引擎同一份卷宗（仓库根 .focus-guard/AUDIT.log，JSONL 追加）。
// 路径相对插件文件上溯 4 级（src/dsh → src → core → packages → 仓库根）。
const AUDIT_FILE = fileURLToPath(new URL('../../../../.focus-guard/AUDIT.log', import.meta.url))

/** 拦截写入一条审计记录；独立 try/catch——留痕失败绝不把 deny 降级成放行 */
function auditDeny(exec, cmd) {
  try {
    appendFileSync(
      AUDIT_FILE,
      JSON.stringify({
        ts: new Date().toISOString(),
        session: (exec && (exec.sessionId || (exec.agent && (exec.agent.sessionId || exec.agent.id)))) || 'dsh-native',
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

/** rm 后跟单簇旗标且同时含 r 与 f（任意顺序）：rm -rf / rm -fr / rm -Rdf … */
const RM_RF = /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*(?:r\w*f|f\w*r)\w*\b/

/** 提取命令类参数；非命令类工具（write/read 等）返回 null，不做检查 */
function commandOf(exec) {
  const args = exec && exec.arguments
  if (!args || typeof args !== 'object') return null
  const cmd = args.command ?? args.cmd ?? args.script
  return typeof cmd === 'string' ? cmd : null
}

// ── 3.0.5 阶段一：成本感知（收编 dsh-peak-cost-mode 职能，常量见 src/peak-cost.mjs）──
const CASE_FILE = fileURLToPath(new URL('../../../../.ai/CASE_FILE.md', import.meta.url))
const COST_MARK = '【五】成本台账'

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

/** 成本台账落卷：卷宗无该章节则先补表头，再逐行追加；失败只 warn 不阻塞 */
function appendCostRow(ts, model, inPeak, usage) {
  try {
    let header = ''
    try {
      if (!readFileSync(CASE_FILE, 'utf8').includes(COST_MARK)) {
        header =
          '\n### 【五】成本台账（DSH 原生插件自动追加；tokens / USD）\n\n' +
          '| 时间 | 模型 | 时段 | 输入未缓存 | 缓存读 | 输出 | 成本USD |\n' +
          '|---|---|---|---|---|---|---|\n'
      }
    } catch {
      /* 读取失败按无表头处理，写入仍尝试 */
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

export function apply(ctx) {
  const warn = (...parts) => {
    console.warn('[focus-guard-native]', ...parts)
    if (ctx && typeof ctx.logger?.warn === 'function') ctx.logger.warn(...parts)
  }

  // 注册失败也 fail-open：插件降级为无操作，DSH 照常启动
  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const cmd = commandOf(exec)
        if (cmd && RM_RF.test(cmd)) {
          warn('已拦截高危删除命令：', cmd.slice(0, 120))
          auditDeny(exec, cmd)
          return {
            kind: 'deny',
            reason: 'focus-guard-native: rm -rf 属高危递归删除，已拦截；如需放行请批示，或改用限定路径的删除方式',
          }
        }
      } catch (error) {
        warn('判定异常，fail-open 放行：', (error && error.message) || error)
      }
      return next()
    })
  } catch (error) {
    warn('监听注册失败，本插件本次不生效：', (error && error.message) || error)
  }

  // ① system-prompt/assemble：注入一行成本提示（fail-open：改写失败原样放行下游）
  try {
    ctx.on('system-prompt/assemble', async (options, next) => {
      const downstream = await next()
      try {
        const line = promptCostLine()
        if (typeof downstream === 'string') return downstream ? downstream + '\n' + line : line
        if (Array.isArray(downstream)) return [...downstream, line]
        if (downstream && typeof downstream === 'object') {
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
    })
  } catch (error) {
    warn('system-prompt/assemble 注册失败（不影响其他缝）：', (error && error.message) || error)
  }

  // ② tools/post-execute：读用量 → 官方价目折算 → 成本台账落卷（只观测，不改决策）
  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
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
      return typeof next === 'function' ? next() : undefined
    })
  } catch (error) {
    warn('tools/post-execute 注册失败（不影响其他缝）：', (error && error.message) || error)
  }
}
