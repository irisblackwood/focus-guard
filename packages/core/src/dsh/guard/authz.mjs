/**
 * 授权/改动面两道闸（2026-10-27 从 pipeline.mjs 抽出，纯搬运）。
 *
 * ① 资格审核闸（3.0.5 第二步）：高危工具须先调 fg_apply 取得授权；
 * ② 改动面闸（2026-10-25）：新建架构敏感文件 / 加依赖须先回三行（收益 / 改动面 / 替代）。
 */
import { existsSync } from 'node:fs'
import { loadProfile } from '../../core/profileLoader.mjs'
import { statePath as guardStateFile, loadState, saveState } from '../../core/state.mjs'
import { shouldGate, gateReason, promptDeclaresBenefit } from '../value-gate.mjs'
import { auditDeny } from '../audit.mjs'
import { modelIdOf, pathOfTool, resolveToolPath, sessionIdOf } from './tooling.mjs'
import { gateSwitch } from '../testRuntime.mjs'

/**
 * 资格审核闸 —— 高危工具须先调 fg_apply 取得授权。
 * 按需加载适配层模块：本文件不在顶部静态 import，以免与适配层的注入关系形成环形依赖。
 * 2026-10-18（任务测试 T39 修）：原条件为 `if (cmd)`，而 Write/Edit 没有 command 参数，
 * 于是"写系统路径"这类只能靠 file_path 判定的门槛**从未被执行**。改为命令或路径任一存在即过闸。
 */
export async function eligibilityStage(ctx) {
  const { exec, warn, cmd } = ctx
  const gateFilePath = (() => {
    const a = (exec && exec.arguments) || {}
    const p = a.file_path ?? a.filePath ?? a.path ?? a.notebook_path
    return typeof p === 'string' ? p : ''
  })()
  if (!cmd && !gateFilePath) return null
  try {
    const { gateToolCall } = await import('../../adapters/dsh/eligibility-gate.mjs')
    const session =
      (exec && (exec.sessionId || (exec.agent && (exec.agent.sessionId || exec.agent.id)))) || 'dsh-native'
    // 最后一公里：把 exec 里的模型标识翻成画像交闸，使画像在真实 pre-execute 生效
    //（此前 pipeline 不传 profile，画像只在 decide()/applyEligibility 那两条路可达）。
    // 取不到模型时为 null → 闸按最严 mutating，是安全默认而非缺陷。
    const modelId = modelIdOf(exec)
    const gate = gateToolCall({
      session,
      tool: String((exec && exec.name) || ''),
      command: cmd || '',
      filePath: gateFilePath,
      profile: modelId ? loadProfile(modelId) : null,
    })
    if (gate.kind === 'deny') {
      warn('资格审核闸拦截：', gate.reason)
      auditDeny(exec, cmd || gateFilePath, { trigger: 'gate:fg_apply', level: 6 })
      return { kind: 'deny', reason: `focus-guard-native: ${gate.reason}` }
    }
    // 2026-10-22：人类批准走宿主 ask 缝（GUI 审批卡片），不再只发 CLI 请求。
    // ask 由宿主 approval.request 处理：allowed-once → 本次执行；rejected/cancelled/unavailable → deny。
    if (gate.kind === 'ask') {
      warn('资格审核闸转人工审批：', gate.reason)
      auditDeny(exec, cmd || gateFilePath, { trigger: 'gate:human-approval', level: 6 })
      return { kind: 'ask', reason: gate.reason, displayReason: gate.displayReason || gate.reason }
    }
  } catch (error) {
    warn('资格审核闸异常，fail-open 放行：', (error && error.message) || error)
  }
  return null
}

/**
 * 改动面闸 —— 人类判据："改大量文件只换来一个小彩灯"。新建架构敏感文件 / 加依赖时，
 * 要求先回三行（收益 / 改动面 / 替代）；**只拒一次**，重试即放行。
 * 人类指令里已声明收益（≥20 字且含收益词）时不介入。
 */
export async function valueGateStage(ctx) {
  const { exec, warn, cmd } = ctx
  try {
    if (gateSwitch('FG_VALUE_GATE')) {
      const fPath = resolveToolPath(pathOfTool((exec && exec.arguments) || {}), exec)
      const sid5 = sessionIdOf(exec)
      const sf = guardStateFile(sid5)
      const st5 = existsSync(sf) ? loadState(sf) : null
      const needGate =
        shouldGate({ filePath: fPath, exists: existsSync, command: cmd }) &&
        !(st5 && st5.valueGateSeen) &&
        !promptDeclaresBenefit(st5 && (st5.turnPromptFull || st5.turnPrompt))
      if (needGate) {
        try {
          saveState(sf, { ...(st5 || {}), valueGateSeen: true })
        } catch {
          /* 记账失败不阻断（宁可少拦，不做死锁） */
        }
        warn('改动面闸：', `新建敏感文件或加依赖 → 要求一行收益 ${fPath || cmd || ''}`)
        auditDeny(exec, fPath || cmd || 'value-gate', { trigger: 'value-gate' })
        return {
          kind: 'deny',
          reason: gateReason({ filePath: fPath, kind: fPath ? 'file' : 'dep' }),
        }
      }
    }
  } catch (error) {
    warn('改动面闸异常，fail-open 放行：', (error && error.message) || error)
  }
  return null
}
