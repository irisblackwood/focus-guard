/**
 * focus-guard 原生插件 · post-execute 进度与执法缝（3.0.8 · 孤儿机制移植批 3）
 *
 * 移植自 guard.mjs 的 post/postfail 段（L666-907，242 行）。DSH 侧此前**完全没有**这一层——
 * 于是进度检测、三预算池核算、上下文污染检测、委派 KPI、抽查节奏全部缺失，
 * 表现为"护栏只会在事前拦，不会在事后算账"。
 *
 * 与 pipeline.mjs 的 postExecuteListener **同事件、并列监听**（DSH 支持多监听者），
 * 职责分工：pipeline 那条记成本台账；本条做进度/预算/污染/考核。
 *
 * 工具名适配（DSH 与 ZCode 命名不同）：
 *   ZCode: Read/Write/Edit/Grep/Bash/Agent  →  DSH: read/write/edit/grep/pwsh|bash/subagent
 *   故一律用大小写不敏感匹配；子代理同时认 'agent' 与 'subagent'。
 * 入参适配：DSH 的 post-execute 签名是 `(exec, result, next)`，
 *   对应 guard.mjs 的 `input.tool_response` 是这里的 result、`input.tool_name` 是 exec.name、
 *   `input.tool_input` 是 exec.arguments。
 *
 * 纪律：任何异常只 warn，绝不断开 DSH 主流程；写状态走 saveState（原子落盘）。
 */
import { statSync } from 'node:fs'
import { statePath as guardStateFile, loadState, saveState, fingerprint, gitDirty, casePath, loadCaseRecords, saveCaseRecords } from '../core/state.mjs'
import { auditChainInit } from '../core/audit.mjs'
import { collectStrings, callHash, isInvestigation } from '../core/risk.mjs'
import { isDangerousCmd, SCRIPT_FILE_RE } from '../core/redlines.mjs'
import { appendAudit } from './audit.mjs'

/**
 * 本地 audit：**签名与母版一致**（sid, action, { level, evidence }），但落点走 DSH 侧统一入口。
 *
 * 为什么不直接用母版 `audit`：它按 `auditTarget()` 落盘，优先读 `ZCODE_PROJECT_DIR` /
 * `CLAUDE_PROJECT_DIR`——在 DSH 下后者被设置，于是**会写真实工作区的 `.focus-guard/AUDIT.log`**
 *（测试亦然，会重演此前修过的测试污染）。DSH 侧必须统一经 `appendAudit`：它尊重 `FG_AUDIT_FILE`
 * 且带体积轮转。
 */
const audit = (sid, action, opts = {}) =>
  appendAudit({
    ts: new Date().toISOString(),
    session: sid,
    seq: Date.now().toString(36) + '.' + Math.floor(performance.now()),
    action,
    trigger: action,
    level: opts.level ?? null,
    evidence: String(opts.evidence || '').slice(0, 200),
    pardon: !!opts.pardon,
  })
import {
  BLOCKS_RE,
  BUDGET_CAP,
  BUDGET_DEFAULT,
  CASE_MAX_ROWS,
  FUSE_PHRASE,
  INV_POOL_DEFAULT,
  OUTPUT_GATE_BYTES,
  RANDOM_AUDIT_EVERY,
  REFILL,
  STALL_FUSE,
} from '../core/constants.mjs'

const RE_WRITE = /^(?:write|edit|multiedit)$/i
const RE_READ = /^(?:read|notebookread)$/i
const RE_GREP = /^grep$/i
const RE_BASH = /^(?:pwsh|bash|shell|bash-persistent|pwsh-persistent)$/i
const RE_AGENT = /^(?:agent|subagent)$/i

/** 会话标识与工作目录：与 seams.mjs 同口径（agent.session.header.*）。 */
function sidOf(exec) {
  const a = exec && exec.agent
  return (
    (a && ((a.session && a.session.header && a.session.header.id) || a.sessionId || a.id)) ||
    (exec && exec.sessionId) ||
    'dsh-native'
  )
}
function projDirOf(exec) {
  const a = exec && exec.agent
  return (a && a.session && a.session.header && a.session.header.cwd) || process.cwd()
}
const normalize = (p) => String(p || '').replace(/\\/g, '/')

/**
 * post-execute 进度与执法缝。
 * 对应 guard.mjs 的 `post`（工具成功后）与 `postfail`（工具失败后）两种语义——
 * DSH 侧没有独立的失败缝，故用 `result` 是否含 error 判定。
 */
export function postProgressListener({ warn } = {}) {
  return async (exec, result, next) => {
    try {
      const sid = sidOf(exec)
      const tool = String((exec && exec.name) || '')
      const ti = (exec && exec.arguments) || {}
      const isFail = !!(result && (result.error || result.isError))
      const file = guardStateFile(sid)
      const state = loadState(file)
      auditChainInit(state)

      let reason = null
      state.turnCount = (state.turnCount || 0) + 1

      // 响应内容单次采样：进度/污染/追责/摘要/强制场景五处共用
      const respProbe = { parts: [], total: 0 }
      if (!isFail) collectStrings(result ?? {}, respProbe, 200000)
      const respText = respProbe.parts.join('\n')

      // 取证销账：一次成功调查解除强制取证
      if (state.forcedInvestigate && !isFail && isInvestigation(tool, ti)) {
        state.forcedInvestigate = false
        audit(sid, 'L2-cleared', { level: 2, evidence: `${tool} 取证完成` })
      }

      // ── 本回合已读/已写集合 + 卷宗取证指纹（供 TTL 与免重读）──
      if (!isFail) {
        state.readSet = state.readSet || {}
        if (ti.file_path && (RE_READ.test(tool) || RE_WRITE.test(tool))) state.readSet[normalize(ti.file_path)] = 1
        if (RE_WRITE.test(tool) && ti.file_path && SCRIPT_FILE_RE.test(String(ti.file_path))) {
          state.scriptFiles = state.scriptFiles || {}
          const body = String(ti.content ?? '') + String(ti.old_string ?? '') + String(ti.new_string ?? '')
          state.scriptFiles[normalize(ti.file_path)] = isDangerousCmd(body) ? 'd' : 'c'
        }
        if (RE_GREP.test(tool) && typeof ti.path === 'string') state.readSet[normalize(ti.path)] = 1
        // 卷宗【三】取证记录（指纹 + TTL 依据）。3.0.5：派生积木不进卷宗
        if (RE_READ.test(tool) && ti.file_path && !BLOCKS_RE.test(String(ti.file_path))) {
          try {
            const fp = fingerprint(ti.file_path)
            const key = normalize(ti.file_path)
            const cc = state.caseCache || {}
            const prev = cc[key]
            const changedFp = !!(
              prev &&
              (prev.mtime !== fp.mtime || prev.size !== fp.size || (prev.sha && fp.sha && prev.sha !== fp.sha))
            )
            cc[key] = {
              path: ti.file_path,
              mtime: fp.mtime,
              size: fp.size,
              sha: fp.sha || '',
              gitDirty: fp.sha ? null : gitDirty(projDirOf(exec), ti.file_path),
              readAt: Date.now(),
              changes: (prev ? prev.changes || 0 : 0) + (changedFp ? 1 : 0),
              lastChange: prev ? (changedFp ? Date.now() : prev.lastChange || 0) : 0,
              ttlOverride: prev ? prev.ttlOverride || '' : '',
              via: fp.sha ? 'mtime+size+sha' : 'mtime+size+git',
            }
            state.caseCache = cc
            const ccKeys = Object.keys(cc)
            if (ccKeys.length > CASE_MAX_ROWS) {
              ccKeys.sort((a, b) => (cc[a].readAt || 0) - (cc[b].readAt || 0))
              for (const k of ccKeys.slice(0, ccKeys.length - CASE_MAX_ROWS)) delete cc[k]
            }
            const pDir = projDirOf(exec)
            if (pDir) saveCaseRecords(pDir, { ...loadCaseRecords(casePath(pDir)), ...cc })
          } catch {
            /* 指纹/卷宗失败不阻断 */
          }
        }
      }

      // ── 动态预算：进度检测引擎 ──
      let progress = false
      if (!isFail) {
        const contentSig = respText.slice(0, 1500)
        const inputSig = callHash({ tool_name: tool, tool_input: ti })
        progress = RE_WRITE.test(tool) || contentSig !== (state.lastSig ?? '') || inputSig !== (state.lastInput ?? '')
        state.lastSig = contentSig
        state.lastInput = inputSig
      }

      const inv = isInvestigation(tool, ti)
      if (progress) {
        if (RE_AGENT.test(tool)) {
          state.stalledStreak = 0 // 委派不占主会话执行池（委托池在 pre 核算）
        } else if (inv) {
          state.invCalls = (state.invCalls || 0) + 1
          state.stalledStreak = 0
        } else {
          state.effectiveCalls = (state.effectiveCalls || 0) + 1
          state.stalledStreak = 0
        }
        if ((state.effectiveCalls || 0) >= BUDGET_CAP) {
          state.fused = true
          state.violations = Math.max(state.violations || 0, 3)
          audit(sid, 'stall-fuse', { level: 3, evidence: `硬上限：有效调用达 ${BUDGET_CAP}` })
          reason = `[触发④·L3]硬上限 ${BUDGET_CAP} 次，强制熔断。输出『${FUSE_PHRASE}』+三行降级方案，等批示。`
        } else if ((state.effectiveCalls || 0) >= (state.taskBudget || BUDGET_DEFAULT)) {
          state.taskBudget = Math.min((state.taskBudget || BUDGET_DEFAULT) + REFILL, BUDGET_CAP)
          audit(sid, 'budget-extend', {
            level: null,
            evidence: `自动续杯 budget=${state.taskBudget} eff=${state.effectiveCalls} stall=0`,
          })
          reason = `[触发④]续杯：执行池 ${state.effectiveCalls} 次达阈值，预算+${REFILL}→${state.taskBudget}。任务继续，自查是否收敛。`
        }
        if (inv && !state.invWarned && (state.invCalls || 0) > (state.invCap || INV_POOL_DEFAULT)) {
          state.invWarned = true
          audit(sid, 'inv-pool-exceeded', {
            level: null,
            evidence: `20条 侦查池超限 inv=${state.invCalls}/${state.invCap || INV_POOL_DEFAULT}`,
          })
          reason = `[20条]侦查池（${state.invCap || INV_POOL_DEFAULT}次）超限。汇总证据请示追加（『追加额度』+10），或交子代理压缩侦查成本。`
        }
      } else {
        state.stalledStreak = (state.stalledStreak || 0) + 1
        state.ineffCalls = (state.ineffCalls || 0) + 1
        if ((state.stalledStreak || 0) >= STALL_FUSE) {
          state.fused = true
          state.violations = Math.max(state.violations || 0, 3)
          audit(sid, 'stall-fuse', {
            level: 3,
            evidence: `连续 ${state.stalledStreak} 次无效调用 eff=${state.effectiveCalls || 0}`,
          })
          reason = `[触发④·L3]真失控：连续 ${state.stalledStreak} 次无效调用。停止探索，输出『${FUSE_PHRASE}』+三行降级方案，或等批示。`
        } else if ((state.stalledStreak || 0) === STALL_FUSE - 1) {
          audit(sid, 'stall-warning', {
            level: null,
            evidence: `停滞 ${state.stalledStreak} 次 eff=${state.effectiveCalls || 0}`,
          })
          reason = `[触发④]停滞预警：连续 ${state.stalledStreak} 次无效，再有一次即熔断。换有证据的方法，或结束回合发【信用延期】请批示。`
        }
      }

      // ── 58条 上下文污染检测（批 2 的消费侧在此闭环）──
      if (!reason && !isFail && RE_BASH.test(tool)) {
        const cmd = String(ti.command || '')
        const outLines = respText.split('\n').filter((l) => l.trim() !== '')
        // 2.5.3（案三）：输出对账只对单条语句有意义；复合命令跳过分段对账，宁宽勿严。
        const stmts = cmd.split(/[;&\n]+/).map((s) => s.trim()).filter(Boolean)
        if (stmts.length === 1) {
          const hm = cmd.match(/\bhead\s+(?:-n\s*(\d{1,6})|-(\d{1,6}))\b/)
          if (hm) {
            const n = parseInt(hm[1] || hm[2], 10)
            if (n > 0 && outLines.length > n) {
              state.pollutionFlagged = true
              audit(sid, 'ctx-pollution', {
                level: null,
                evidence: `58条 行数超限 head ${n} → 实际 ${outLines.length} 行 | ${cmd.slice(0, 60)}`,
              })
              reason = `[38条·上下文污染]输出与指令矛盾：head ${n} 行实得 ${outLines.length}。停用本次输出，echo MARK-X 隔离核实并报告人类。`
            }
          }
          if (!reason && /\b(find|git\s+(ls-files|ls-tree))\b/.test(cmd)) {
            const seen = new Set()
            let dup = ''
            for (const l of outLines) {
              if (seen.has(l)) {
                dup = l
                break
              }
              const tok = l.trim().split(/\s+/)[0] || ''
              if (/[/\\]/.test(tok) && !/[:：]$/.test(tok)) seen.add(l)
            }
            if (dup) {
              state.pollutionFlagged = true
              audit(sid, 'ctx-pollution', {
                level: null,
                evidence: `58条 路径重复 ${dup.slice(0, 80)} | ${cmd.slice(0, 50)}`,
              })
              reason = `[38条·上下文污染]清单出现不可能的重复路径（${dup.slice(0, 60)}）。停用本次输出，echo MARK-X 隔离核实并报告人类。`
            }
          }
        }
      }

      // 巨量输出事后追责
      if (!reason && (RE_BASH.test(tool) || RE_GREP.test(tool))) {
        if (respProbe.total > OUTPUT_GATE_BYTES) {
          state.dumpCount = (state.dumpCount || 0) + 1
          audit(sid, 'scold-dump', { level: null, evidence: `${tool} 输出 ${Math.round(respProbe.total / 1024)}KB` })
          reason = `体积刺客：${tool} 输出 ${Math.round(respProbe.total / 1024)}KB 已入上下文。下次先 head/tail/wc/grep 过滤（累计 ${state.dumpCount} 次）。`
        }
      }

      // ── 子代理摘要格式校验（只收【子代理摘要】，≤200字）──
      if (!reason && !isFail && RE_AGENT.test(tool)) {
        const sumText = respText
        const fmtOk =
          /【子代理摘要】/.test(sumText) &&
          /任务[:：]/.test(sumText) &&
          /结果[:：]/.test(sumText) &&
          /异常[:：]/.test(sumText) &&
          /文件线索[:：]/.test(sumText)
        if (!fmtOk || sumText.length > 200) {
          state.kpi = (state.kpi || 0) - 3
          audit(sid, 'delegate-summary-pollution', {
            level: null,
            evidence: `2.3.0 摘要污染 -3 len=${sumText.length} fmt=${fmtOk ? '有' : '无'}`,
          })
          reason =
            '[委派摘要拒收·KPI-3]超200字或缺字段，拒绝全量采纳。压缩为：【子代理摘要】任务：…｜结果：≤5条｜异常：…｜文件线索：文件:行号，以此继续。'
        } else {
          state.kpi = (state.kpi || 0) + 3
          audit(sid, 'kpi-summary-good', { level: null, evidence: `2.3.0 委派摘要合格 +3 len=${sumText.length}` })
        }
      }

      // ── 强制委派场景检测（该委派不委派 → KPI-5；已委派 → KPI+5 一次）──
      if (!reason && !isFail) {
        const scLines = respText.split('\n').map((l) => l.trim()).filter(Boolean)
        const scPaths = scLines.filter((l) => /[/\\]/.test(l) && l.length <= 200 && !/^(total|\.\.?|d[-rwx]|-[-rwx])/.test(l))
        const scDirs = new Set(scPaths.map((l) => l.replace(/[/\\][^/\\]*$/, '')))
        let scenario = ''
        if (
          RE_GREP.test(tool) ||
          (RE_BASH.test(tool) && /\b(find|rg|grep)\b/i.test(String(ti.command || '')))
        ) {
          if (scPaths.length >= 10 || scDirs.size >= 3) scenario = '全库搜索'
        } else if (RE_READ.test(tool) && ti.file_path) {
          let kb = 0
          try {
            kb = statSync(ti.file_path).size / 1024
          } catch {
            kb = 0
          }
          if (kb > OUTPUT_GATE_BYTES / 1024 || scLines.length > 2000) scenario = '大文档摘要'
        } else if (RE_WRITE.test(tool) && ti.file_path) {
          state.editedFiles = state.editedFiles || {}
          state.editedFiles[normalize(ti.file_path)] = 1
          if (Object.keys(state.editedFiles).length >= 5) scenario = '批量文件处理'
        }
        if (scenario) {
          if (state.delegated) {
            if (!state.kpiDelegatedAwarded) {
              state.kpiDelegatedAwarded = true
              state.kpi = (state.kpi || 0) + 5
              audit(sid, 'kpi-delegated', { level: null, evidence: `2.3.0 强制场景已委派 +5 ${scenario}` })
            }
          } else {
            state.kpiScolded = state.kpiScolded || {}
            const key = scenario === '全库搜索' ? 'search' : scenario === '大文档摘要' ? 'bigdoc' : 'batch'
            if (!state.kpiScolded[key]) {
              state.kpiScolded[key] = true
              state.kpi = (state.kpi || 0) - 5
              audit(sid, 'kpi-not-delegated', { level: null, evidence: `2.3.0 强制场景未委派 -5 ${scenario}` })
              reason =
                `[未尽职·KPI-5]${scenario}属强制委派场景（≥3目录/≥10文件、>50KB或>2000行、≥5文件批量、并行任务），本任务未委派过。` +
                `改用 Agent 委派，只回【子代理摘要】；特例需向人类说明。`
            }
          }
        }
      }

      // ── 抽查A：每 5 次写操作全量审计 1 次（确定性节奏，不是随机抽样）──
      if (!reason && !isFail && RE_WRITE.test(tool)) {
        state.writeOps = (state.writeOps || 0) + 1
        if (state.writeOps % RANDOM_AUDIT_EVERY === 0) {
          audit(sid, 'random-audit', {
            level: null,
            evidence: `第 ${state.writeOps} 次写操作全量审计 ${normalize(ti.file_path)}`,
          })
          reason = `抽查A：第 ${state.writeOps} 次写操作已留痕。确认有锚点([文件:行号])，无则补【假设】。`
        }
      }

      saveState(file, state)
      if (reason && typeof warn === 'function') warn('事后执法：', reason)
    } catch (error) {
      if (typeof warn === 'function') warn('进度与执法缝异常（不阻塞）:', (error && error.message) || error)
    }
    return next()
  }
}
