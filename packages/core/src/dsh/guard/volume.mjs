/**
 * 体积刺客三闸 + 污染核实闸（2026-10-27 从 pipeline.mjs 抽出，纯搬运）。
 *
 * 移植自 guard.mjs L579-620 / L534-558。DSH 侧此前完全没有这几道：
 * 大文件整读会一次灌入上下文、步步重复计费，是"烧上下文"最直接的来源。
 */
import { statSync, existsSync } from 'node:fs'
import { OUTPUT_GATE_BYTES, RISKY_FILE_RE } from '../../core/constants.mjs'
import { judgeReadGate, judgeGrepGate, judgeCatGate } from '../../core/outputGate.mjs'
import { statePath as guardStateFile, loadState, saveState } from '../../core/state.mjs'
import { auditDeny, auditRedlineExempt } from '../audit.mjs'
import { isDirPath, pathOfTool, resolveToolPath, sessionIdOf } from './tooling.mjs'

/**
 * 结果准入预算（2026-10-24，新功能③）：体积闸只按硬阈值拦；但"每次只差一点"的多次
 * 中等体积整读同样把上下文撑大。这里给会话一个额度：超过 FG_RESULT_ADMIT_BYTES 的整读每次 -1，
 * 额度用尽即拒（分段读/检索不受限）。默认 3 次，`FG_RESULT_ADMIT_BUDGET` 可调，0=关闭该闸。
 */
function admitBudgetGate({ exec, warn, target, kb, verdict, st, stateFile }) {
  const admitBytes = Number(process.env.FG_RESULT_ADMIT_BYTES) || 32768
  const admitBudgetDefault = Number(process.env.FG_RESULT_ADMIT_BUDGET ?? 3)
  const sizeBytes = kb * 1024
  if (verdict === 'deny' || admitBudgetDefault <= 0 || sizeBytes <= admitBytes || !st) return null
  const left = Number.isFinite(st.resultAdmitLeft) ? st.resultAdmitLeft : admitBudgetDefault
  if (left <= 0) {
    warn('结果准入拦截：', `${target} ${kb}KB（本会话大结果额度已用尽）`)
    auditDeny(exec, `${target} ${kb}KB 准入超限`, { trigger: 'result-admit' })
    return {
      kind: 'deny',
      reason:
        `focus-guard-native: 结果准入——本会话已放行 ${admitBudgetDefault} 次 ≈${Math.round(admitBytes / 1024)}KB+ 的大结果，额度用尽。` +
        `改用 limit+offset 分段读、Grep 收窄、或交子代理处理；压缩后额度自动恢复。`,
    }
  }
  try {
    saveState(stateFile, { ...st, resultAdmitLeft: left - 1 })
  } catch {
    /* 记账失败不阻断（宁可少拦，不做死锁） */
  }
  return null
}

/**
 * ① Read 整读体积闸（判定见 core/outputGate.mjs:judgeReadGate）
 * 2.5.3（案二）：审计/盘点/审查类任务整读留痕不罚——法典把审计定为 50 预算
 * 重大专项，体积闸却拦审计最需要的整读，属制度性误伤。
 */
function readVolumeGate({ exec, warn, toolName, args, target, st, stateFile }) {
  if (!/^read$/i.test(toolName) || args.limit || !target) return null
  let kb = 0
  try {
    kb = Math.round(statSync(String(target)).size / 1024)
  } catch {
    kb = 0
  }
  const turnPrompt = String((st && (st.turnPromptFull || st.turnPrompt)) || '')
  const verdict = judgeReadGate({ bytes: kb * 1024, gateBytes: OUTPUT_GATE_BYTES, turnPrompt })
  const denied = admitBudgetGate({ exec, warn, target, kb, verdict, st, stateFile })
  if (denied) return denied
  if (verdict === 'exempt') {
    auditRedlineExempt(exec, `${target} ${kb}KB 整读`, {
      redline: 'output-gate',
      basis: 'audit-task-exempt',
      detail: `${target} ${kb}KB 整读（审计任务豁免，留痕不罚）`,
    })
    warn('体积刺客·审计豁免：', `${target} ${kb}KB 整读已留痕（审计任务）。预算仍计费，巨量输出仍追责。`)
    return null
  }
  if (verdict !== 'deny') return null
  warn('体积刺客拦截：', `${target} ${kb}KB 整读`)
  auditDeny(exec, `${target} ${kb}KB 整读`, { trigger: 'volume:kb' })
  return {
    kind: 'deny',
    reason:
      `focus-guard-native: 体积刺客——${target} ${kb}KB，整读一次灌入、步步重复计费。` +
      `请用 limit+offset 分段读，或交子代理处理。`,
  }
}

/**
 * ② Grep 收窄闸（判定见 core/outputGate.mjs:judgeGrepGate）
 * 2026-10-19 修：原条件依赖 output_mode/head_limit —— 那是**合成参数**，真实 DSH grep
 * 工具只有 {pattern,path,include}，条件永不成立（实测 session-002c143b 直通）。
 * 2026-10-22 清死分支：`grepContentNoLimit` 已删。它线上永远走不到，却让 decision-bench
 * 里一条用合成参数的用例继续"通过"——死代码在给假测试续命。
 * DSH 侧的"未收窄"语义 = 明确指定了**目录**却没给 include（等价于全目录正文搜索）。
 */
function grepVolumeGate({ exec, warn, toolName, args, target }) {
  const broadDir =
    /^grep$/i.test(toolName) && Boolean(args.path) && isDirPath(target) && !args.include && !args.head_limit
  const grepVerdict = judgeGrepGate({ broadDir })
  if (grepVerdict.action !== 'deny') return null
  warn('体积刺客拦截：', 'Grep 目录级搜索未收窄')
  auditDeny(exec, `Grep 未收窄（path=${String(args.path || '-').slice(0, 60)} include=${args.include || '-'}）`, {
    trigger: 'volume:grep',
  })
  return {
    kind: 'deny',
    reason: `focus-guard-native: 体积刺客——Grep 未收窄。${grepVerdict.reason}`,
  }
}

/** ③ 裸 cat/type 刷屏闸（判定见 core/outputGate.mjs:judgeCatGate） */
function catVolumeGate({ exec, warn, cmd }) {
  if (!cmd || judgeCatGate(cmd) !== 'deny') return null
  warn('体积刺客拦截：', `裸 cat/type：${cmd.slice(0, 60)}`)
  auditDeny(exec, `裸 cat/type：${cmd.slice(0, 60)}`, { trigger: 'volume:cat' })
  return {
    kind: 'deny',
    reason: 'focus-guard-native: 体积刺客——禁裸 cat/type 刷屏。用 `cat x | head -100`，或先 grep/wc 定位。',
  }
}

/** pre-execute 阶段：Read 整读 / Grep 未收窄 / 裸 cat 三闸（顺序不变）。 */
export async function volumeStage(ctx) {
  const { exec, warn, cmd } = ctx
  try {
    const toolName = String((exec && exec.name) || '')
    const args = (exec && exec.arguments) || {}
    const target = resolveToolPath(pathOfTool(args), exec)
    const stateFile = guardStateFile(sessionIdOf(exec))
    const st = existsSync(stateFile) ? loadState(stateFile) : null
    const read = readVolumeGate({ exec, warn, toolName, args, target, st, stateFile })
    if (read) return read
    const grep = grepVolumeGate({ exec, warn, toolName, args, target })
    if (grep) return grep
    const cat = catVolumeGate({ exec, warn, cmd })
    if (cat) return cat
  } catch (error) {
    warn('体积刺客闸异常，fail-open 放行：', (error && error.message) || error)
  }
  return null
}

/**
 * pre-execute 阶段：污染核实闸 + 风险文件留痕。
 *
 * 污染核实闸（移植自 guard.mjs L534-543）：上轮工具输出与参数矛盾且未核实前，
 * 首个改动类先拦一次（一次性，重试放行）；只读核验不受限。
 * 风险文件修改 100% 留痕（不拦，只记录；移植自 guard.mjs L555-558）。
 */
export async function pollutionStage(ctx) {
  const { exec, warn } = ctx
  try {
    const toolName2 = String((exec && exec.name) || '')
    const args2 = (exec && exec.arguments) || {}
    const target2 = pathOfTool(args2)
    const stateFile2 = guardStateFile(sessionIdOf(exec))
    const st2 = existsSync(stateFile2) ? loadState(stateFile2) : null
    const isMutating = /^(?:Write|Edit|MultiEdit|Delete|Move|Patch|NotebookEdit)$/i.test(toolName2)

    if (st2 && st2.pollutionFlagged && isMutating) {
      st2.pollutionFlagged = false
      saveState(stateFile2, st2)
      warn('污染核实闸拦截：', `${toolName2} ${target2 || ''}`)
      return {
        kind: 'deny',
        reason:
          'focus-guard-native: 上轮输出曾与参数矛盾（已记档）。先输出【污染核实】预期X 实际Y，结论：可信/不可信/需重试，再重试本次修改。只读核验不受限。',
      }
    }

    if (
      st2 &&
      /^(Write|Edit)$/i.test(toolName2) &&
      target2 &&
      (RISKY_FILE_RE.test(target2) || /\.github\/|\.zcode-plugin\//.test(target2))
    ) {
      auditRedlineExempt(exec, target2, {
        redline: 'risky-file',
        basis: 'risk-audit',
        detail: `风险文件修改 ${target2}`,
      })
    }
  } catch (error) {
    warn('污染核实/风险留痕异常，fail-open 放行：', (error && error.message) || error)
  }
  return null
}
