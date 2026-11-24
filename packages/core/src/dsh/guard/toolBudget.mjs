/**
 * 工具预算闸（2026-11-24）
 *
 * 为什么内化到 FG：实测 shell（pwsh）是本仓最大的调用方（单会话 1,250 次 / 参数 ≈145k tokens），
 * 其中大量是「为一次分析写多条 node -e」「同一条命令换引号重试」。这类浪费靠会话约定管不住，
 * 但**可观测**（工具名 + 命令文本 + 回合号），所以做成机械判据。
 *
 * 语义（默认只提醒一次，不封死整回合）：
 *   - 同回合 shell 工具超过 `FG_SHELL_BUDGET`（默认 50）→ 拦一次，要求合并命令；
 *   - 同回合 `node -e` / `--input-type` 超过 `FG_NODE_E_BUDGET`（默认 4）→ 拦一次，要求写成脚本；
 *   - 拦一次后同回合放行（避免把合法重活卡死）；下回合重新计数。
 *
 * 关：`FG_TOOL_BUDGET=0`。
 */
import { currentPosition } from '../traceMeta.mjs'
import { auditDeny } from '../audit.mjs'

const OFF = process.env.FG_TOOL_BUDGET === '0'
const SHELL_LIMIT = Number(process.env.FG_SHELL_BUDGET) || 50
const NODE_E_LIMIT = Number(process.env.FG_NODE_E_BUDGET) || 4

const SHELL_TOOLS = /^(?:pwsh|powershell|bash|sh|shell|terminal|runcommand)$/i
const NODE_E = /\bnode(?:\.exe)?\s+(?:-e|--eval|--input-type(?:=|\s+)module)/i

const tables = new Map()

function sidOf(exec) {
  return (
    (exec && ((exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.id) || exec.sessionId)) ||
    'unknown'
  )
}

function tableOf(sid) {
  let t = tables.get(sid)
  if (!t) {
    t = { turn: null, shell: 0, nodeE: 0, warnedShell: false, warnedNode: false }
    if (tables.size >= 128) tables.delete(tables.keys().next().value)
    tables.set(sid, t)
  }
  return t
}

/**
 * @returns {null | {kind:'deny', reason:string}} 超预算时返回一次 deny
 */
export function toolBudgetCheck(exec, cmd) {
  if (OFF) return null
  const tool = String((exec && exec.name) || '')
  const text = String(cmd || '')
  const sid = sidOf(exec)
  const t = tableOf(sid)
  const pos = currentPosition((exec && exec.agent) || sid)
  const turn = pos && pos.turn != null ? pos.turn : null
  if (turn !== null && t.turn !== turn) {
    t.turn = turn
    t.shell = 0
    t.nodeE = 0
    t.warnedShell = false
    t.warnedNode = false
  }
  if (SHELL_TOOLS.test(tool)) {
    t.shell += 1
    if (t.shell > SHELL_LIMIT && !t.warnedShell) {
      t.warnedShell = true
      const reason =
        `focus-guard-native: [工具预算] 本回合 shell 调用已 ${t.shell} 次（上限 ${SHELL_LIMIT}）。` +
        '把多条命令合并成一次（用 ; 分隔或写一个脚本一次跑），不要逐条起 shell；本条只提醒一次，后续放行。'
      auditDeny(exec, reason, { trigger: 'tool-budget:shell', level: 2 })
      return { kind: 'deny', reason }
    }
  }
  if (NODE_E.test(text)) {
    t.nodeE += 1
    if (t.nodeE > NODE_E_LIMIT && !t.warnedNode) {
      t.warnedNode = true
      const reason =
        `focus-guard-native: [工具预算] 本回合 node -e 已 ${t.nodeE} 次（上限 ${NODE_E_LIMIT}）。` +
        '把临时脚本写成文件一次跑，或优先用现成工具（read / grep / glob / npm run panel:baseline）；本条只提醒一次，后续放行。'
      auditDeny(exec, reason, { trigger: 'tool-budget:node-e', level: 2 })
      return { kind: 'deny', reason }
    }
  }
  return null
}

/** 测试钩子。 */
export function resetToolBudget() {
  tables.clear()
}
