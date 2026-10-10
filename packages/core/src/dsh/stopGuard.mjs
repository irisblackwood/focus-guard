/**
 * focus-guard 原生插件 · stop 收尾缝（3.0.8 · 孤儿机制移植批 4）
 *
 * 移植自 guard.mjs 的 stop 段（L908-1107）。KPI 结算已在 seams.mjs（批 1）完成，
 * 本模块补其余收尾判定：任务规模声明 · 绝境模式豁免 · **《授权识别与留痕条例》核验** ·
 * 触发⑤（熔断声明与未知跟踪）· 双规后交代 · 经验库创建（79条）· 触发②（本回合调用≥5 无锚点）。
 *
 * ⚠ 两个刻意的取舍（与 guard.mjs 不同，均因 DSH 的现实）：
 *  ① **只审计、不打回**。guard.mjs 用 `block()` 打回，靠 `input.stop_hook_active` 这个
 *     宿主协议信号保证"只打回一次"；DSH 的 `agent/turn-stopping` 不提供该信号，
 *     误打回会变成强制续跑死循环（本移植过程中本人已被自家熔断拦过，深知其代价）。
 *     故本批把"打回"降级为"审计 + 警告"，待确认 DSH 的收尾语义后再决定是否启用打回。
 *  ② **无收尾文本时跳过文本核验**。guard.mjs 对 DSH 桥接（`transcript_path` 为空且无收尾文本）
 *     明确降级为审计（`dshBridge`），注释里写明"打回会强制续跑且桥接无连败上限"。
 *     原生插件同样拿不到 assistant 收尾文本，故沿用同一降级：有文本才核验，没有就只留痕。
 *
 * 不搬：高危审批单收尾校验（L1059-1077）——该机制已退役（见 RULES 第七十五条(三)）。
 *
 * 纪律：审计走 DSH 统一入口；异常只 warn，绝不断开主流程。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { statePath, loadState, saveState } from '../core/state.mjs'
import { appendAudit } from './audit.mjs'
import {
  AUTH_SEMANTICS_RE,
  BUDGET_CAP,
  BUDGET_DEFAULT,
  DOWNGRADE_MARKERS,
  EVIDENCE_ANCHORS,
  FUSE_PHRASE,
  PARDON_BASIS_RE,
  PARDON_DECL_RE,
  PARDON_PENDING_RE,
  PARDON_QUOTE_RE,
  TASK_SCALE_RE,
} from '../core/constants.mjs'

/** 会话标识 / 工作目录：与 seams、audit 同口径（真实 id 在 agent.session.header.id）。 */
function sidOf(agent) {
  return (
    (agent && ((agent.session && agent.session.header && agent.session.header.id) || agent.sessionId || agent.id)) ||
    'dsh-native'
  )
}
function projDirOf(agent) {
  return (agent && agent.session && agent.session.header && agent.session.header.cwd) || process.cwd()
}

const audit = (sid, action, opts = {}) =>
  appendAudit({
    ts: new Date().toISOString(),
    session: sid,
    seq: Date.now().toString(36) + '.' + Math.floor(performance.now()),
    action,
    trigger: opts.trigger || action,
    level: opts.level ?? null,
    evidence: String(opts.evidence || '').slice(0, 200),
    pardon: !!opts.pardon,
  })

/** 尽力从 agent 取本回合的收尾文本；取不到返回 undefined（触发降级）。 */
function finalTextOf(agent) {
  if (!agent) return undefined
  for (const k of ['response', 'lastMessage', 'last_message', 'message', 'output']) {
    const v = agent[k]
    if (typeof v === 'string' && v) return v
  }
  const msgs = agent.messages || (agent.session && agent.session.messages)
  if (Array.isArray(msgs) && msgs.length) {
    const last = msgs[msgs.length - 1]
    if (typeof last === 'string') return last
    if (last && Array.isArray(last.content)) {
      const t = last.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
      if (t) return t
    }
  }
  return undefined
}

/** 生成"待人类裁决"的说明行（替代 guard.mjs 的 block，只警告不打断）。 */
const advisory = (msg) => `[收尾核验·待裁决]${msg}`

/**
 * stop 收尾核验缝（`agent/turn-stopping`，与 seams 的 KPI 结算并列监听）。
 */
export function stopGuardListener({ warn } = {}) {
  return async ({ agent } = {}) => {
    try {
      const sid = sidOf(agent)
      const file = statePath(sid)
      const state = loadState(file)
      const projDir = projDirOf(agent)
      const raw = finalTextOf(agent)
      // 拿不到收尾文本 → 沿用 guard.mjs 对无文本宿主的降级口径：只留痕、不核验
      const noText = raw === undefined
      const text = noText ? '' : raw
      const advisories = []

      // 任务规模声明：预算只升不降，declaredBudget 持久
      const scale = text.match(TASK_SCALE_RE)
      if (scale) {
        const x = Math.min(parseInt(scale[1], 10) || 0, BUDGET_CAP)
        if (x > (state.taskBudget || BUDGET_DEFAULT)) {
          state.taskBudget = x
          audit(sid, 'budget-extend', { evidence: `任务规模声明上调 budget=${x}` })
        }
        state.declaredBudget = Math.max(state.declaredBudget || 0, x)
      }

      // 绝境模式：本回合结论锚点检查豁免
      if (state.mercy) {
        state.turnCount = 0
        saveState(file, state)
        return
      }

      // 《授权识别与留痕条例》+ 信用延期：仅在收尾无锚点（确需豁免/请示）时核验
      if (!noText && !EVIDENCE_ANCHORS.test(text)) {
        if (PARDON_PENDING_RE.test(text)) {
          audit(sid, 'pardon-pending', { evidence: '输出【授权待确认】暂停，等待人类明确批示' })
          state.turnCount = 0
          saveState(file, state)
          return
        }
        if (text.includes('【信用延期】')) {
          audit(sid, 'credit-request', {
            evidence: `eff=${state.effectiveCalls || 0} budget=${state.taskBudget} stall=${state.stalledStreak || 0}`,
          })
          state.turnCount = 0
          saveState(file, state)
          return
        }
        if (PARDON_DECL_RE.test(text)) {
          const q = text.match(PARDON_QUOTE_RE)
          const b = text.match(PARDON_BASIS_RE)
          const tp = String(state.turnPromptFull || state.turnPrompt || '').replace(/\s+/g, '')
          const quote = q ? q[1].replace(/\s+/g, '') : ''
          let invalid = ''
          if (!q) invalid = '声明未引用人类指令原文（条例四-B）'
          else if (!b) invalid = '声明未指明依据法条（条例四-C）'
          else if (!quote || !tp.includes(quote)) invalid = '引用的人类指令原文与本回合实际指令不符，涉嫌编造或事后补（条例四-D/E）'
          else if (!AUTH_SEMANTICS_RE.test(q[1])) invalid = '引用的人类指令原文不含授权语义（条例四-E）'
          if (invalid) {
            state.fused = true
            state.violations = Math.max(state.violations || 0, 3)
            state.stopBlocked = true
            audit(sid, 'violation-usurp-pardon', { level: 3, evidence: invalid })
            saveState(file, state)
            advisories.push(
              advisory(
                `[越权解释授权·L3]${invalid}。正确：【授权识别】引本回合人类指令原文+法条；未明→【授权待确认】。禁止自行推断。`,
              ),
            )
            // ⚠ 必须 return：guard.mjs 此处是 block() + process.exit(0)（打完即结束）。
            // 若继续往下走，末尾的 `state.stopBlocked = false` 会把此处刚设的一次性守卫清掉，
            // 且待裁决提示永远不会被 warn 出来（2026-10-10 由测试抓到）。
            if (typeof warn === 'function') warn(...advisories)
            return
          } else {
            state.mercy = true
            state.fused = false
            audit(sid, 'pardon-interpreted', {
              trigger: q[1],
              level: 'PARDON',
              evidence: b[1],
              pardon: true,
            })
            saveState(file, state)
            return
          }
        }
      }

      // 触发⑤：熔断声明与未知跟踪
      const formalFuse = text.includes('【熔断】')
      if (formalFuse || text.includes('查无依据') || text.includes('查无实据')) {
        state.unknownStreak = (state.unknownStreak || 0) + 1
        if (formalFuse || state.unknownStreak >= 2) {
          state.fused = true
          state.violations = Math.max(state.violations || 0, 3)
          audit(sid, 'shuanggui-declared', {
            level: 3,
            evidence: formalFuse ? '明示熔断' : `连续 ${state.unknownStreak} 次未知声明`,
          })
          // 79条：熔断时确保经验库存在（解除后 AI 追加经验，卡点时 Grep 检索）
          if (formalFuse && projDir) {
            try {
              const pat = join(projDir, '.ai', 'PATTERNS.md')
              if (!existsSync(pat)) {
                mkdirSync(dirname(pat), { recursive: true })
                writeFileSync(
                  pat,
                  '# PATTERNS 经验库\n\n> 格式：[环境:OS] [任务:类型] 以后遇到 X 必须先做 Y。熔断/返工后由 AI 追加；新任务不预读，卡点时 Grep 检索（79条）。\n',
                )
              }
            } catch {
              audit(sid, 'note-fail', { evidence: 'PATTERNS.md 经验库创建失败（降级继续）' })
            }
          }
        }
        // 声明熔断但缺降级方案 → 只提醒一次（不再打回）
        const needDowngrade = formalFuse && !DOWNGRADE_MARKERS.test(text) && !state.stopBlocked
        if (needDowngrade) {
          state.stopBlocked = true
          audit(sid, 'reject-no-downgrade', { level: 3, evidence: '声明熔断但缺降级方案（只审计，不打回）' })
          advisories.push(advisory(`声明熔断但缺降级方案。需补三行降级方案（${FUSE_PHRASE} 之后）。`))
        }
        state.turnCount = 0
        saveState(file, state)
        if (advisories.length && typeof warn === 'function') warn(...advisories)
        return
      }

      // 双规后必须交代（只审计一次，不打回）
      if (state.fused && !EVIDENCE_ANCHORS.test(text) && !DOWNGRADE_MARKERS.test(text) && !state.stopBlocked) {
        state.stopBlocked = true
        state.turnCount = 0
        saveState(file, state)
        audit(sid, 'reject-no-account', { level: 3, evidence: '双规后未交代（只审计，不打回）' })
        advisories.push(advisory(`[触发⑤]熔断已触发未交代。需输出『${FUSE_PHRASE}』+三行降级方案。`))
        if (typeof warn === 'function') warn(...advisories)
        return
      }

      state.unknownStreak = 0

      // 触发②：本回合调用 ≥5 且收尾无证据锚点（回合边界不依赖 reset）
      if (!noText && (state.turnCount || 0) >= 5 && !EVIDENCE_ANCHORS.test(text) && !state.stopBlocked) {
        state.stopBlocked = true
        const tc = state.turnCount
        state.turnCount = 0
        audit(sid, 'violation-no-anchor', { level: 3, evidence: `收尾无锚点，本回合 ${tc} 次调用（只审计，不打回）` })
        saveState(file, state)
        advisories.push(
          advisory(
            `[触发②]本回合 ${tc} 次调用后无证据锚点收尾。补：结论+[文件:行号]证据链，或写 HANDOFF.md，或标【假设】；` +
              `确有授权→【授权识别】引原文+法条，未明→【授权待确认】。`,
          ),
        )
        if (typeof warn === 'function') warn(...advisories)
        return
      }

      // DSH 无收尾文本 → 降级审计（与原 dshBridge 口径一致，供人类复核）
      if (noText && ((state.turnCount || 0) >= 5 || state.highRiskDeniedThisTurn)) {
        audit(sid, 'dsh-stop-observe', {
          evidence: `无收尾文本，锚点核验降级审计 turnCalls=${state.turnCount || 0}`,
        })
      }

      state.stopBlocked = false
      state.turnCount = 0
      saveState(file, state)
    } catch (error) {
      if (typeof warn === 'function') warn('收尾核验缝异常（不阻塞）:', (error && error.message) || error)
    }
  }
}
