/**
 * focus-guard 原生插件 · 补充宿主缝（3.0.8 · 孤儿机制移植）
 *
 * 背景：原生插件原本只注册 pipeline.mjs 的三条缝（tools/pre-execute、system-prompt/assemble、
 * tools/post-execute），而 guard.mjs 的六条缝里另有三条在 DSH 侧没有对应实现——于是
 * KPI / 三预算池 / 审批单 / 抽查 / 污染检测 / 因果链 / 图书馆 / 降级 / 绝境等机制
 * 全都停在 guard.mjs（封存且未挂载）里，DSH 用户拿不到。
 *
 * 本文件按官方桥（@deepseek-ai/dsh-hooks-claude-code）已验证的事件映射接上缺失的缝：
 *   SessionStart      ← agent/created       （sessionStartListener）
 *   UserPromptSubmit  ← agent/pre-step      （preStepListener · waterfall，必须 return next()）
 *   Stop              ← agent/turn-stopping （turnStoppingListener · KPI 兑现结算）
 *
 * 取值口径与桥一致（lib/index.js:349-354）——**这不是可选项**：
 *   sid = agent.session.header.id   ← 用 agent.session.id 会取不到，于是全部会话退化成同一个
 *                                      'dsh-native'，造成跨会话状态污染。
 *   cwd = agent.session.header.cwd ?? process.cwd()
 *   人类文本 = messages.flatMap(m => m.content).filter(b => b.type==='text').map(b => b.text).join('')
 *
 * 纪律：所有写入经 appendAudit / saveState / saveLedger（均 fail-open + 留痕）；
 * 任一缝异常只 warn，绝不断开 DSH 主流程。
 */
import { existsSync } from 'node:fs'
import { statePath, loadState, saveState, saveLedger } from '../core/state.mjs'
import {
  BUDGET_CAP,
  BUDGET_DEFAULT,
  CREDIT_RE,
  DELEGATE_DEFAULT,
  INV_POOL_DEFAULT,
  KEY15_RE,
  KEY50_RE,
  MERCY_RE,
  MERCY_SHORT,
  REFILL,
  STOP_ORDER_RE,
} from '../core/constants.mjs'
import { appendAudit } from './audit.mjs'

/** 会话标识：与桥同源（agent.session.header.id）。取不到才退化为 dsh-native。 */
function sidOf(agent) {
  return (
    (agent && ((agent.session && agent.session.header && agent.session.header.id) || agent.sessionId || agent.id)) ||
    'dsh-native'
  )
}

/** 工作目录：与桥同源（session.header.cwd），缺省用进程 cwd。 */
function projDirOf(agent) {
  return (agent && agent.session && agent.session.header && agent.session.header.cwd) || process.cwd()
}

/** 从 agent/pre-step 的 messages 提取人类提示原文（与桥的 blocksToText 同口径）。 */
function humanTextOf(messages) {
  if (!Array.isArray(messages)) return ''
  const blocks = messages.flatMap((m) => (m && Array.isArray(m.content) ? m.content : []))
  return blocks
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('')
}

/** 载入本会话状态；文件不存在时 loadState 返回默认结构（含 readSet: {}）。 */
function loadOrInit(agent) {
  const sid = sidOf(agent)
  const file = statePath(sid)
  return { sid, file, state: loadState(file) }
}

/** 写一条审计（DSH 侧统一入口，带体积轮转）。 */
function auditRow(sid, action, evidence, extra = {}) {
  appendAudit({
    ts: new Date().toISOString(),
    session: sid,
    seq: Date.now().toString(36) + '.' + Math.floor(performance.now()),
    action,
    trigger: action,
    level: extra.level ?? null,
    evidence: String(evidence || '').slice(0, 200),
    pardon: !!extra.pardon,
  })
}

/**
 * ① agent/created → SessionStart：建立/载入本会话状态。
 * 这是"原生插件自持状态"的起点——此前 DSH 侧没有任何 state 写入者，
 * 所有依赖 state 的机制（取证、KPI、预算池…）因此一起失效。
 */
export function sessionStartListener({ warn } = {}) {
  return async ({ agent } = {}) => {
    try {
      const { sid, file, state } = loadOrInit(agent)
      if (!existsSync(file)) {
        saveState(file, state)
        auditRow(sid, 'start-fired', `本会话状态初始化（DSH 原生插件自持）：${file}`)
      }
    } catch (error) {
      if (typeof warn === 'function') warn('会话启动缝异常（不阻塞）:', (error && error.message) || error)
    }
  }
}

// ── 批示词识别（3.0.2：头尾皆可）──
// 原实现用 \b 收尾，而 JS 的 \b 只认 ASCII 词字符，导致「同意/批准/不/拒绝」等中文批示全部失效；
// 这里保留 guard.mjs 修正后的精确写法：整条短指令==一个批示词（可带尾标点），
// 或「批示词 + 分隔符 + 简短补充」。
const Y_TOKEN = '(?:y|yes|是|好|行|ok|同意|批准|允许|可以|没问题|通过)'
const N_TOKEN = '(?:n|no|不|不行|否|不要|拒绝|不许)'
const LEAD = (tok) => new RegExp(`^${tok}(?:[\\s。！!，,]*$|[\\s]*[，,。：:！!][\\s]*\\S)`, 'i')
const TAIL = (tok) => new RegExp(`(?:^|[\\s，,。：:！!])${tok}[\\s。！!，,]*$`, 'i')

/**
 * ② agent/pre-step → UserPromptSubmit：批示识别 + 回合重置（waterfall，必须 return next()）。
 *
 * 移植自 guard.mjs 的 reset 模式（L194-326），保留全部判定；去掉脚本特有部分
 *（process.exit / detectEnv 环境重检——后者依赖 env.mjs 的探测链，留待后续批次）。
 */
export function preStepListener({ warn } = {}) {
  return async ({ agent, messages } = {}, next) => {
    try {
      const { sid, file, state } = loadOrInit(agent)
      const promptText = humanTextOf(messages)
      const short = promptText.trim()

      // 特赦识别
      const grant = promptText.match(MERCY_RE)
      const mercy = !!(grant && short.length <= MERCY_SHORT)
      if (mercy) auditRow(sid, 'mercy-granted', `批示原文: ${grant[0]}`, { pardon: true })

      // 目标预授权与执行级授权分离：任务指令里的「上传/推送」只记 goal，不解锁执行标记
      const goalPush =
        /上传|推送|push/i.test(promptText) && !/(不|禁|勿|别|暂|缓)[^，。；\n]{0,6}(上传|推送|push)/i.test(promptText)
      if (goalPush) auditRow(sid, 'goal-preauth', 'goal=push-at-end（目标预授权，不构成执行级授权）')

      // 信用延期：连续停滞 ≥2 且收到信用批示 → 侦查池/执行池各补一次
      let creditGranted = false
      if (short.length <= 12 && (state.stalledStreak || 0) >= 2 && CREDIT_RE.test(short)) {
        state.stalledStreak = 0
        state.taskBudget = Math.min((state.taskBudget || BUDGET_DEFAULT) + REFILL, BUDGET_CAP)
        state.invCap = Math.min((state.invCap || INV_POOL_DEFAULT) + REFILL, BUDGET_CAP)
        state.invWarned = false
        creditGranted = true
      }

      // 停止令：人类明确批示停止 → 熔断（旧实现曾在本函数后续把 fused 硬写回 false，止停令被自己抹掉）
      const stopOrdered = short.length <= 12 && STOP_ORDER_RE.test(short)
      if (stopOrdered) {
        state.fused = true
        state.violations = Math.max(state.violations || 0, 3)
        auditRow(sid, 'stall-fuse', '人类批示停止', { level: 3 })
      }

      // 24条(三) 追加批示：三池各 +REFILL
      if (short.length <= 12 && /追加|增加额度|扩大额度/.test(short)) {
        state.taskBudget = Math.min((state.taskBudget || BUDGET_DEFAULT) + REFILL, BUDGET_CAP)
        state.invCap = Math.min((state.invCap || INV_POOL_DEFAULT) + REFILL, BUDGET_CAP)
        state.invWarned = false
        state.delegateBudget = Math.min((state.delegateBudget ?? DELEGATE_DEFAULT) + REFILL, BUDGET_CAP)
        auditRow(
          sid,
          'budget-extend',
          `24条(三) 追加批示 budget=${state.taskBudget} invCap=${state.invCap} delegate=${state.delegateBudget}`,
        )
      }

      // 2.4.0 执行级授权：只认人类当回合短指令 y/n；y 放行全部待批，n 彻底阻断
      const yReply = short.length <= MERCY_SHORT && (LEAD(Y_TOKEN).test(short) || TAIL(Y_TOKEN).test(short))
      const nReply = short.length <= MERCY_SHORT && (LEAD(N_TOKEN).test(short) || TAIL(N_TOKEN).test(short))
      const pendingCount = (state.highRiskQueue || []).length + (state.highRiskKey ? 1 : 0)
      if (yReply && pendingCount > 0) {
        const keys = (state.highRiskQueue || []).map((x) => x.k)
        if (state.highRiskKey && !keys.includes(state.highRiskKey)) keys.push(state.highRiskKey)
        state.highRiskOk = true
        state.highRiskBatch = keys
        state.highRiskQueue = []
        state.highRiskApprovedKeys = state.highRiskApprovedKeys || {}
        for (const k of keys) state.highRiskApprovedKeys[k] = true
        auditRow(sid, 'high-risk-approved', `批示原文: ${short} | 放行 ${keys.length} 条待批（目标绑定）`, {
          pardon: true,
        })
      }
      if (nReply && pendingCount > 0) {
        state.rejectedCmds = state.rejectedCmds || {}
        const keys = (state.highRiskQueue || []).map((x) => x.k)
        if (state.highRiskKey && !keys.includes(state.highRiskKey)) keys.push(state.highRiskKey)
        for (const k of keys) state.rejectedCmds[String(k)] = 1
        if (state.highRiskApprovedKeys) for (const k of keys) delete state.highRiskApprovedKeys[k]
        auditRow(sid, 'high-risk-rejected', `批示原文: ${short} | 已彻底阻断 ${keys.length} 条`)
        state.highRiskCmd = ''
        state.highRiskKey = ''
        state.highRiskQueue = []
      }

      // 43条 状态重置核验：上一回合残留 → 记档后清理
      const residues = []
      if ((state.turnCount || 0) > 0) residues.push(`turnCount=${state.turnCount}`)
      if ((state.stalledStreak || 0) > 0) residues.push(`stall=${state.stalledStreak}`)
      if (state.fused && !stopOrdered) residues.push('fused')
      if (state.forcedInvestigate) residues.push('forcedInvestigate')
      if (state.stopBlocked) residues.push('stopBlocked')
      if (state.readSet && Object.keys(state.readSet).length)
        residues.push(`readSet=${Object.keys(state.readSet).length}`)
      if (residues.length) auditRow(sid, 'residue-check', `43条 残留(已清理): ${residues.join(' ')}`)

      // 额度核定
      const kw = KEY50_RE.test(promptText) ? 50 : KEY15_RE.test(promptText) ? 15 : BUDGET_DEFAULT
      state.taskBudget = Math.max(kw, state.declaredBudget || 0, state.taskBudget || BUDGET_DEFAULT)
      state.taskInitial = state.taskBudget
      state.ineffCalls = 0
      const chain = 'T' + Date.now().toString(36)

      saveState(file, {
        ...state, // envCache/caseCache（侦查缓存）随 spread 保留；kpi/delegateUsed 跨回合保留
        turnCount: 0,
        fused: stopOrdered,
        stopBlocked: false,
        mercy,
        goalPush,
        highRiskOk: yReply && pendingCount > 0,
        highRiskDeniedThisTurn: false,
        violations: stopOrdered ? Math.max(state.violations || 0, 3) : 0,
        forcedInvestigate: false,
        probation: false,
        readSet: {},
        delegated: false,
        editedFiles: {},
        kpiScolded: {},
        kpiDelegatedAwarded: false,
        turnPrompt: promptText.slice(0, 500),
        turnPromptFull: promptText.slice(0, 4000),
        taskBudget: state.taskBudget,
        taskInitial: state.taskInitial,
        taskChain: chain,
        lastSig: '',
        lastInput: '',
      })

      auditRow(
        sid,
        'reset-fired',
        `prompt:${promptText ? '有' : '无'} kw=${kw} budget=${state.taskBudget} eff=${state.effectiveCalls || 0} inv=${state.invCalls || 0} stall=${state.stalledStreak || 0}${creditGranted ? ' 信用延期' : ''}${mercy ? ' 特赦' : ''}`,
      )
    } catch (error) {
      if (typeof warn === 'function') warn('回合重置缝异常（不阻塞）:', (error && error.message) || error)
    }
    return next()
  }
}

/**
 * ③ agent/turn-stopping → Stop：KPI 兑现结算（二十七~三十二条部分机械化）。
 * 逻辑照搬 guard.mjs 的 stop 分支：本任务 KPI → 等次 → 委托池奖惩，跨任务累计入 kpiCarry。
 * 执行池增减仍由人类批示，引擎只动委托池。
 */
export function turnStoppingListener({ warn } = {}) {
  return async ({ agent } = {}) => {
    try {
      const { sid, file, state } = loadOrInit(agent)
      const kpiNow = state.kpi || 0
      let grade = '称职'
      let poolDelta = 0
      if (kpiNow >= 15) {
        grade = '优秀'
        poolDelta = 5
      } else if (kpiNow >= 0) {
        grade = '称职'
        poolDelta = 0
      } else if (kpiNow >= -9) {
        grade = '基本称职'
        poolDelta = -2
      } else {
        grade = '不称职'
        poolDelta = -5
      }
      state.delegateBudget = Math.max(
        0,
        Math.min(BUDGET_CAP, (state.delegateBudget ?? DELEGATE_DEFAULT) + poolDelta),
      )
      state.kpiCarry = (state.kpiCarry || 0) + kpiNow
      if (kpiNow <= -10) {
        if (!state.kpiLowReported) {
          state.kpiLowReported = true
          auditRow(sid, 'kpi-low', `委派 KPI ${kpiNow}：强制委派场景累计失分，下任务请优先 Agent 委派（委托池独立 20 次）`)
        }
      } else if (state.kpiLowReported) {
        state.kpiLowReported = false
      }
      saveState(file, state)
      saveLedger(projDirOf(agent), state)
      auditRow(
        sid,
        'kpi-settle',
        `二十七~三十二条 兑现 KPI=${kpiNow} 等次=${grade} 委托池${poolDelta >= 0 ? '+' : ''}${poolDelta}（现=${state.delegateBudget}）跨任务累计=${state.kpiCarry}`,
      )
    } catch (error) {
      if (typeof warn === 'function') warn('KPI 结算缝异常（不阻塞）:', (error && error.message) || error)
    }
  }
}
