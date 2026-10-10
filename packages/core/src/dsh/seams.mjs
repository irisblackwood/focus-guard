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
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  statePath,
  loadState,
  saveState,
  saveLedger,
  casePath,
  ensureCaseFile,
  loadCaseRecords,
} from '../core/state.mjs'
import { noteFail } from '../core/audit.mjs'
import { detectEnv } from '../core/env.mjs'
import {
  BUDGET_CAP,
  BUDGET_DEFAULT,
  CREDIT_RE,
  DELEGATE_DEFAULT,
  ENGINE_VERSION,
  INV_POOL_DEFAULT,
  KEY15_RE,
  KEY50_RE,
  MERCY_RE,
  MERCY_SHORT,
  REFILL,
  SESSION_RULES,
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

/**
 * 是否为子代理会话（`origin === 'subagent'`）。
 *
 * 2026-10-10 实测必要性：hermes-loop 的复盘子代理走 `ctx.agents.create({ meta: { origin: 'subagent' } })`，
 * 它会**同样触发 `agent/created` 与 `agent/pre-step`**。若不加区分，FG 会对一个只跑几十秒的复盘子代理：
 *   · 做完整环境检测、载入 39 条卷宗记录（实测白占 20KB 状态文件）
 *   · **重写工作区 `.ai/CASE_FILE.md` 的卷宗【一】**（每个 agent 创建都写一次 → 文件抖动、并发时可能互相覆盖）
 *   · 把 hermes 自己生成的复盘 prompt **当成人类批示**去识别（实测命中 KEY50_RE → 额度误判为 50、并记了无意义的 goal）
 * 子代理的 prompt 由父 agent 生成、不是人类输入，故这些一律应跳过。
 */
function isSubagent(agent) {
  const s = agent && agent.session
  const origin = (s && ((s.header && s.header.origin) || s.origin)) || (agent && agent.origin)
  if (origin === 'subagent') return true
  // 兜底：委派深度 > 0 亦视为子代理
  const depth = (s && ((s.header && s.header.delegationDepth) || s.delegationDepth)) || agent?.delegationDepth
  return typeof depth === 'number' && depth > 0
}

/**
 * 从 `agent/pre-step` 的 messages 提取人类提示原文。
 *
 * ⚠ 2026-10-10 实际运行修正（真实会话审计里出现 `prompt:无`）：
 *  ① **形状不止一种**。原实现只认 `messages[].content[]` 的 text 块（照桥的 `blocksToText` 假设），
 *     真实载荷对不上 → 人类文本恒为空 → **批示识别全部失效**（追加额度/停止令/特批/额度核定 50·15
 *     全都拿不到输入，额度永远按默认 10 走）。测试发现不了，因为测试造的就是自己假设的形状。
 *  ② **messages 里混有非人类消息**。DSH 的 pre-step 默认 next 是
 *     `{ messages: [...claimed, context] }`（dsh-agent-loop/lib/index.js:911-918），
 *     即**渲染后的系统提示也会作为一条消息追加进来**。若无条件拼接，会把系统提示当成人类批示——
 *     那是比"取不到"更危险的方向，所以这里**优先只取 user 角色的消息**，取不到才退回全量。
 */
function humanTextOf(messages) {
  if (!Array.isArray(messages)) return ''
  /** 单条消息 → 文本（逐层兜底，覆盖常见的几种载荷形状）。 */
  const pick = (m) => {
    if (typeof m === 'string') return m
    if (!m || typeof m !== 'object') return ''
    if (typeof m.text === 'string') return m.text
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
        .map((b) => b.text || '')
        .join('')
    }
    if (Array.isArray(m.parts)) {
      return m.parts
        .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
        .map((b) => b.text || '')
        .join('')
    }
    if (typeof m.message === 'string') return m.message
    return ''
  }
  const isUser = (m) =>
    m && typeof m === 'object' && (m.role === 'user' || m.author === 'user' || m.type === 'user')
  const users = messages.filter(isUser)
  // 有明确的 user 消息就只用它（排除 pre-step 追加的 context 消息，防把系统提示当批示）
  const pool = users.length ? users : messages
  return pool.map(pick).join('\n')
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
 * ① agent/created → SessionStart：建立/载入本会话状态 + 环境检测 + 卷宗载入 + 巡视。
 *
 * 移植自 guard.mjs 的 start 模式（L90-193），**唯一的取舍**：原文把常驻规则 `SESSION_RULES`
 * 混在 `hookSpecificOutput.additionalContext` 里用 stdout 输出（Claude hooks 协议）；
 * DSH 原生插件不走 stdout，注入缝是 `system-prompt/assemble` —— 故规则改由下面的
 * `systemPromptRulesListener` 承担，本缝只管状态与环境。
 *
 * 去掉脚本特有部分：rmSync(path)（原文每次 start 都清状态；DSH 的会话状态要跨回合保留，
 * 清空会丢取证记录）、cleanStaleTemp 之外的 ZCode 注册表核验（`~/.zcode/...` 在 DSH 下无意义）。
 */
export function sessionStartListener({ warn } = {}) {
  return async ({ agent } = {}) => {
    try {
      const sid = sidOf(agent)
      const file = statePath(sid)
      const projDir = projDirOf(agent)
      const state = loadState(file)
      const first = !existsSync(file)

      // ── 子代理：只落一份最小状态，跳过环境检测 / 卷宗读写 / 规则备案 / 巡视 ──
      // （理由见 isSubagent 注释：这些对短命的子代理没有意义，且会重写工作区卷宗、误读其 prompt）
      if (isSubagent(agent)) {
        if (first) {
          saveState(file, state)
          auditRow(sid, 'subagent-start', `子代理会话（轻量初始化，跳过卷宗与环境检测）：${file}`)
        }
        return
      }

      // 2.0 环境检测：会话级一次，写入 state.envCache（总纲三）
      try {
        state.envCache = detectEnv(projDir)
      } catch {
        /* 环境检测失败不阻断 */
      }
      // 2.0 卷宗载入：重建取证记录与 TTL 表（总纲七）
      if (projDir) {
        try {
          state.caseCache = loadCaseRecords(ensureCaseFile(projDir))
          // 2.5.3（案一）：从卷宗重建的记录标为"继承"——内容不在本会话上下文中，
          // 据此免重读会挡住合法首读。继承记录只提示不拦，本会话真读过（post 重录指纹）后转正。
          for (const k of Object.keys(state.caseCache)) state.caseCache[k].inherited = 1
        } catch {
          noteFail(sid, '卷宗初始化（工作区可能只读，降级继续）')
        }
        // 卷宗【一】环境声明落卷（原子写：tmp + rename）
        try {
          const cp = casePath(projDir)
          let t = readFileSync(cp, 'utf8')
          const env = state.envCache || {}
          const envRow = `- OS=${env.os} / Shell=${env.shellIdKey} / 大小写=${env.caseSensitive === false ? '不敏感' : '敏感'} / 编码=${env.encoding || '-'} / 检测于 ${new Date().toISOString()}`
          t = t.replace(/### 【一】[\s\S]*?(?=\n### |\n## |$)/, () => `### 【一】环境声明（会话级检测，全程复用）\n\n${envRow}\n`)
          const tmp = cp + '.' + process.pid + '.tmp'
          writeFileSync(tmp, t)
          renameSync(tmp, cp)
        } catch {
          noteFail(sid, '卷宗【一】环境声明落卷')
        }
        // 36条 异地交叉巡视：新会话接手 → 复核前任结论
        try {
          readFileSync(join(projDir, 'HANDOFF.md'), 'utf8')
          auditRow(sid, 'handover-inspect', '36条 交叉巡视：发现 HANDOFF.md')
        } catch {
          /* 无 HANDOFF 属正常 */
        }
        // 42条 部署版本核验：运行引擎 vs 工作区源码
        // ⚠ 排除 `packages/core/hooks/guard.mjs`——它是**封存版、版本号独立**（header 写明不随 FG 主版本更新，
        // 见 HANDOFF §九）。拿它的 v 号与 ENGINE_VERSION 比较会**每次会话误报部署漂移**（2026-10-10 实测）。
        const SEALED = ['packages/core/hooks/guard.mjs']
        for (const rel of ['hooks/guard.mjs', 'focus-guard/hooks/guard.mjs', ...SEALED]) {
          try {
            const m = readFileSync(join(projDir, rel), 'utf8').slice(0, 400).match(/v(\d+\.\d+\.\d+)/)
            if (m && m[1] !== ENGINE_VERSION) {
              auditRow(sid, 'version-check', `42条 引擎 v${ENGINE_VERSION} vs 源码 v${m[1]} (${rel})`)
            }
            break
          } catch {
            /* 该路径不存在，试下一个 */
          }
        }
      }

      state.taskChain = (state.taskChain || 'S') + ''
      if (first) state.taskChain = 'S' + Date.now().toString(36) // 3.0.0 因果链：会话根链
      saveState(file, state)
      if (first) {
        auditRow(sid, 'start-fired', `本会话状态初始化（DSH 原生插件自持）：${file}`)
      }
      // 立法法·第七章 规则备案
      auditRow(sid, 'rules-registered', `立法法(试行)v1.0 生效2026-09-29; 监督办法v1.0(docs/RULES.md); 引擎v${ENGINE_VERSION}`)
    } catch (error) {
      if (typeof warn === 'function') warn('会话启动缝异常（不阻塞）:', (error && error.message) || error)
    }
  }
}

/**
 * 常驻规则注入（`system-prompt/assemble`，与 pipeline 的成本提示行并列）。
 * 这是 guard.mjs 的 `SESSION_RULES` 在 DSH 原生插件里的落点——原文经 stdout 的
 * `hookSpecificOutput.additionalContext` 输出，原生插件无此契约，故改走注入缝。
 * 追加为独立 section，不改动下游既有 section。
 */
export function systemPromptRulesListener({ warn } = {}) {
  return async (assembly, context, next) => {
    let downstream
    try {
      downstream = await next()
      if (downstream && typeof downstream === 'object' && Array.isArray(downstream.sections)) {
        return { ...downstream, sections: [...downstream.sections, { name: 'focus-guard-rules', text: SESSION_RULES }] }
      }
      // 兜底：下游不是预期的 assembly 形状时不强行改写，原样透传
      return downstream
    } catch (error) {
      if (typeof warn === 'function') warn('常驻规则注入异常（不阻塞）:', (error && error.message) || error)
      return downstream
    }
  }
}

// ── 3.0.8 修法：审批单机制退役 ──
// 原 guard.mjs 的 reset 段含 y/n 批示识别（Y_TOKEN/N_TOKEN/LEAD/TAIL）与待批队列处理，
// 本文件批 1 曾照搬。**现已移除**——理由（人类批示 2026-10-10）：
//   审批单只需敲一个 y，**无目的、无范围、无留档**；而 fg_apply 要求 purpose/scope 结构化留档。
//   两套并存时人会本能选省事的那条，使"事前结构化申请"形同虚设。
//   **留一条能绕过主设计的旁路，等于没有主设计。**
// 误伤救济（fg_appeal）不受影响：它不是绕过，而是申辩——须附反例锚点、人类一次性裁决、全程留痕。
// 对应条文修法见 RULES 第七十五条(三)(四)。

/**
 * ② agent/pre-step → UserPromptSubmit：回合重置（waterfall，必须 return next()）。
 *
 * 移植自 guard.mjs 的 reset 模式（L194-326），但**不含**已退役的审批单部分（y/n 批示识别与待批队列）。
 * 去掉脚本特有部分：process.exit / detectEnv 环境重检（依赖 env.mjs 探测链，留待后续批次）。
 */
export function preStepListener({ warn } = {}) {
  return async ({ agent, messages } = {}, next) => {
    try {
      const { sid, file, state } = loadOrInit(agent)
      // ── 子代理：只做回合重置，跳过批示识别 ──
      // 子代理的 prompt 由父 agent 生成、不是人类输入。实测（hermes-loop 复盘子代理）：
      // 其复盘 prompt 含"审计/全量"等词 → 命中 KEY50_RE → 额度被误判为 50，还记了无意义的 goal-preauth。
      if (isSubagent(agent)) {
        state.turnCount = 0
        state.stopBlocked = false
        saveState(file, state)
        return next()
      }
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
        `prompt:${promptText ? '有' : '无'}(${promptText.length}字) kw=${kw} budget=${state.taskBudget} eff=${state.effectiveCalls || 0} inv=${state.invCalls || 0} stall=${state.stalledStreak || 0}${creditGranted ? ' 信用延期' : ''}${mercy ? ' 特赦' : ''}`,
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
