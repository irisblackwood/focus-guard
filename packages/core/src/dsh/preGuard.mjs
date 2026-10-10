/**
 * focus-guard 原生插件 · pre-execute 补充执法缝（3.0.8 · 孤儿机制移植批 5）
 *
 * 移植自 guard.mjs 的 pre 段剩余部分（L356-457）。DSH 侧此前完全没有这几道：
 *   · 资料分层隔离（静态资料区/派生积木区不得直写，防自我投毒）
 *   · 环境规则检查（`platformBashViolation`：平台不兼容命令；与第 1.5 层"环境指纹替换"不同）
 *   · 大小写不敏感文件系统 → 禁仅大小写不同的重名文件
 *   · 子代理闸：熔断期启动子代理 = 越权绕行（L4/L5）；48 条继承留痕；蜂群因果子链；**委托池消耗**
 *   · 熔断期白名单：只读放行、改动拒绝，且熔断期不是高危命令的免检通道
 *   · L2 强制取证 / L5 降权：改动类一律拒绝
 *
 * 与 pipeline 的分工：pipeline 的 preExecuteListener 负责红线/硬校验/资格闸/体积刺客/污染核实；
 * 本模块负责上述结构性执法。二者**同事件并列监听**，各自 try/catch、互不阻塞。
 *
 * 委托池闭环：追加侧在 seams.mjs 的 preStepListener（人类批示『追加额度』三池各 +10），
 * 消耗侧在本模块（每次委派 -1）与 stopGuard/seams 的 KPI 结算（委托池奖惩）。
 *
 * 纪律：审计走 DSH 统一入口；异常只 warn，绝不阻断 DSH 主流程。
 */
import { dirname, basename } from 'node:path'
import { readdirSync } from 'node:fs'
import { statePath as guardStateFile, loadState, saveState, fingerprint, gitDirty, resolveTTL } from '../core/state.mjs'
import { backupBeforeEdit } from '../core/backup.mjs'
import { platformBashViolation } from '../core/env.mjs'
import { isDangerousCmd } from '../core/redlines.mjs'
import { isInvestigation, isMutating, penalize } from '../core/risk.mjs'
import { zcodeToolName } from './toolName.mjs'
import { appendAudit } from './audit.mjs'
import { BLOCKS_RE, DELEGATE_DEFAULT, DOWNGRADE_MSG, LIBRARY_RE } from '../core/constants.mjs'

const RE_WRITE = /^(?:write|edit|multiedit)$/i
const RE_READ = /^(?:read|notebookread)$/i
const RE_GREP = /^grep$/i
const RE_BASH = /^(?:pwsh|bash|shell|bash-persistent|pwsh-persistent)$/i
const RE_AGENT = /^(?:agent|subagent)$/i
const RE_SEARCH = /^(?:grep|glob|fs-search|search)$/i

/** 会话标识 / 工作目录：与其余 DSH 模块同口径。 */
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

const audit = (sid, action, opts = {}) =>
  appendAudit({
    ts: new Date().toISOString(),
    session: sid,
    seq: Date.now().toString(36) + '.' + Math.floor(performance.now()),
    action,
    trigger: opts.trigger || action,
    chain: opts.chain || null,
    ref: opts.ref || null,
    level: opts.level ?? null,
    evidence: String(opts.evidence || '').slice(0, 200),
    pardon: !!opts.pardon,
  })

/** 处罚阶梯说明（原 approval.mjs 的 ladderNote：与审批单无关，是"降级阶梯"提示）。 */
function ladderNote(level) {
  const l = Number(level) || 0
  if (l >= 5) return '（L5 降权中：只读模式，等人类批示解除）'
  if (l >= 4) return '（L4 记档：本任务内再犯升级）'
  if (l >= 3) return '（L3：已达熔断线，下一次违规直接熔断）'
  return '（L2：下次改动类调用须先取证）'
}

/**
 * pre-execute 补充执法缝（`tools/pre-execute`）。
 * 返回 deny 决策以拦截；返回 next() 透传下游。
 */
export function preGuardListener({ warn } = {}) {
  return async (exec, next) => {
    try {
      const sid = sidOf(exec)
      const tool = String((exec && exec.name) || '')
      const ti = (exec && exec.arguments) || {}
      const rawPath = ti.file_path || ti.path || ti.target || ''
      const filePath = rawPath ? normalize(rawPath) : ''
      const cmd = RE_BASH.test(tool) ? String(ti.command || '') : ''
      // ⚠ 母版判定按 ZCode 命名（Read/Write/Bash/Agent），DSH 传小写 → 必须先归一化，
      // 否则只读工具不被认成只读、改动类不被认成改动（静默判错，非漏拦）。
      const ztool = zcodeToolName(tool)
      const handoff = /HANDOFF\.md$/i.test(String(filePath))
      const search = RE_SEARCH.test(tool)
      const file = guardStateFile(sid)
      const state = loadState(file)
      const env = state.envCache || null

      // ===== 资料分层隔离：静态资料区与派生积木区均不得直写（防自我投毒）=====
      if (RE_WRITE.test(tool) && filePath && (LIBRARY_RE.test(filePath) || BLOCKS_RE.test(filePath))) {
        audit(sid, 'library-write-deny', { evidence: `静态资料区直写被拒 ${filePath}` })
        return {
          kind: 'deny',
          reason:
            `focus-guard-native: [图书馆·隔离]${filePath} 属静态资料区/派生积木区，不得直写。` +
            `外部原文走同步三步（旧版归档 → 覆盖 → 写 frontmatter），派生积木由 library-build 生成到 .ai/output/library（防自我投毒）。`,
        }
      }

      // ===== 环境规则检查（平台命令拦截）=====
      // 与第 1.5 层的区别：环境指纹管"本机有更好替代"（ls→eza），本层管"平台本身不兼容"。
      if (cmd) {
        const v = platformBashViolation(env, cmd)
        if (v) {
          audit(sid, 'platform-deny', {
            evidence: `${env ? env.os + '/' + env.shellIdKey : 'unknown'} ${v.slice(0, 100)}`,
          })
          return {
            kind: 'deny',
            reason: `focus-guard-native: [平台规则·${env ? env.os + '/' + env.shellIdKey : '?'}]${v}`,
          }
        }
      }

      // ===== 大小写不敏感文件系统：禁仅大小写不同的重名文件 =====
      // 注意：不敏感 FS 上大小写变体目标的 existsSync 恒为 true，故不能以 existsSync 豁免。
      if (RE_WRITE.test(tool) && rawPath && env && env.caseSensitive === false) {
        try {
          const dirp = dirname(rawPath)
          const base = basename(rawPath)
          const clash = readdirSync(dirp).find((e) => e !== base && e.toLowerCase() === base.toLowerCase())
          if (clash) {
            audit(sid, 'platform-deny', { evidence: `2.0平台 大小写冲突 ${base} vs ${clash}` })
            return {
              kind: 'deny',
              reason:
                `focus-guard-native: [平台规则·大小写冲突]本文件系统大小写不敏感：${base} 与已有 ${clash} 仅大小写不同，` +
                `创建后会互相覆盖。改名，或改用现有文件。`,
            }
          }
        } catch {
          /* 目录不可读 → 跳过该检查 */
        }
      }

      // ===== 子代理闸：越权绕行边界 + 48 条继承留痕 + 蜂群因果子链 + 委托池消耗 =====
      if (RE_AGENT.test(tool)) {
        // 仅熔断期启动子代理属违规（L4 记档 + L5 降权）；正常委派放行且不计违规
        if (state.fused) {
          state.violations = Math.max(state.violations || 0, 4)
          const lvl = penalize(
            state,
            sid,
            'violation-subagent-usurp',
            `56条 熔断期启动子代理 ${String(ti.description || ti.prompt || '').slice(0, 60)}`,
          )
          saveState(file, state)
          return {
            kind: 'deny',
            reason:
              `focus-guard-native: [越权绕行·L${lvl}]熔断期启动子代理执行被禁操作：L4 记档+L5 降权。` +
              `只读可亲自查，或等批示。${ladderNote(lvl)}`,
          }
        }
        // 48条 子代理继承留痕：父会话处分状态随派单记录（平台无注入通道，以留痕方式移交）
        const spawnSeq = audit(sid, 'subagent-spawn', {
          evidence: `48条 父状态 fused=${!!state.fused} L${state.violations || 0} eff=${state.effectiveCalls || 0} inv=${state.invCalls || 0} | ${String(ti.description || ti.prompt || '').slice(0, 60)}`,
        })
        // 3.0.0 蜂群因果链：每次委派派生子链 /dN，ref 指回派单事件
        state.childChainN = (state.childChainN || 0) + 1
        const childChain = (state.taskChain || sid) + '/d' + state.childChainN
        // 委托池独立核算（不占执行池；用尽须人类批示追加）
        if ((state.delegateBudget ?? DELEGATE_DEFAULT) <= 0) {
          audit(sid, 'delegate-exhausted', { evidence: `2.3.0 委托池用尽 剩余=0 累计=${state.delegateUsed || 0}` })
          return {
            kind: 'deny',
            reason:
              'focus-guard-native: [委托池用尽]子代理额度已用完（默认20次，独立于执行池）。' +
              '请批示『追加额度』（执行/侦查/委托三池各+10），或主会话自行收敛。',
          }
        }
        state.delegateBudget = (state.delegateBudget ?? DELEGATE_DEFAULT) - 1
        state.delegateUsed = (state.delegateUsed || 0) + 1
        state.delegated = true
        saveState(file, state)
        audit(sid, 'delegate-used', {
          chain: childChain,
          ref: spawnSeq,
          evidence: `2.3.0 委托池消耗 剩余=${state.delegateBudget} 累计=${state.delegateUsed} | ${String(ti.description || '').slice(0, 50)}`,
        })
      }

      // ===== 熔断期白名单：只读放行、改动拒绝；熔断期不是高危命令的免检通道 =====
      if (state.fused) {
        // 旧顺序曾让白名单先放行，于是 npm publish / shutil.rmtree 等"不在 MUTATING 表里"的
        // 高危命令被 isInvestigation 判成只读侦查而绕过审批——本分支保证该不变量在熔断期也成立。
        if (cmd && isDangerousCmd(cmd)) {
          audit(sid, 'deny-shuanggui-highrisk', { level: 3, evidence: `熔断期高危命令被拒 ${cmd.slice(0, 120)}` })
          return {
            kind: 'deny',
            reason:
              'focus-guard-native: [熔断期·高危命令]熔断期只读放行不含高危命令。此类命令即使解熔也须先调 fg_apply，现在一律拒绝。',
          }
        }
        if (search || handoff || isInvestigation(ztool, ti)) return next()
        audit(sid, 'deny-shuanggui', { level: 3, evidence: `${tool} 熔断期改动类被拒` })
        return { kind: 'deny', reason: `focus-guard-native: ${DOWNGRADE_MSG}` }
      }

      // ===== L2 强制取证 / L5 降权：改动类操作一律拒绝 =====
      if ((state.forcedInvestigate || state.probation) && isMutating(ztool, ti, handoff)) {
        const lvl = state.probation ? 5 : 2
        audit(sid, state.probation ? 'deny-L5-probation' : 'deny-L2-forced', {
          level: lvl,
          evidence: `${tool} ${filePath}`,
        })
        return {
          kind: 'deny',
          reason: state.probation
            ? 'focus-guard-native: [L5 降权]只读模式，改动类全拒，等人类批示。'
            : 'focus-guard-native: [L2 强制取证]下一调用必须是取证类，取证后自动解除。',
        }
      }

      // ===== 总纲四：卷宗不重复读校验（跨回合）=====
      // 指纹一致（mtime+size+SHA/git）且 TTL 未超 → 拦免重读，复用已有取证；
      // 指纹不一致 / TTL 超时 → 放开，允许真重读（post 缝会更新卷宗指纹）。
      // 与第 3 层取证闸**语义相反**（那座闸管"没读就改"，本闸管"读了还读"），二者不冲突：
      // 取证闸只对改动类生效（MUTATING_TOOL），本闸只对 Read 生效。
      // 熔断/强制取证期豁免（降级重建证据需真重读）；offset 增量读永远放行。
      if (
        RE_READ.test(tool) &&
        rawPath &&
        !ti.offset &&
        !state.fused &&
        !state.forcedInvestigate &&
        !BLOCKS_RE.test(rawPath)
      ) {
        try {
          const rec = (state.caseCache || {})[filePath]
          if (rec) {
            const fp = fingerprint(rawPath)
            const pDir = projDirOf(exec)
            const dirty = fp.sha ? null : gitDirty(pDir, rawPath)
            const changed =
              rec.mtime !== fp.mtime ||
              rec.size !== fp.size ||
              (rec.sha && fp.sha && rec.sha !== fp.sha) ||
              (rec.gitDirty !== null && rec.gitDirty !== undefined && dirty !== null && dirty !== rec.gitDirty)
            if (!changed) {
              const ttl = resolveTTL(pDir, rec, rawPath)
              if (Date.now() - (rec.readAt || 0) < ttl.ms) {
                if (rec.inherited) {
                  // 卷宗继承的指纹只提示不拦——本会话从未读过，内容不在上下文，拦首读即阻断取证
                  audit(sid, 'casefile-inherit', { evidence: `2.0卷宗 继承指纹放行首读 ${filePath} ttl=${ttl.src}` })
                  if (typeof warn === 'function') {
                    warn('卷宗·提示：', `${filePath} 卷宗有近期取证（${ttl.src}），但本会话尚未读过——首读放行。`)
                  }
                } else {
                  audit(sid, 'casefile-hit', { evidence: `2.0卷宗 免重读 ${filePath} ttl=${ttl.src}` })
                  return {
                    kind: 'deny',
                    reason:
                      `focus-guard-native: [卷宗·免重读]${filePath} 指纹一致（${rec.via || 'mtime+size'}）且 TTL 未超（${ttl.src}），` +
                      `勿重复整读；需新内容用 offset 增量读或请批示。`,
                  }
                }
              }
            }
          }
        } catch {
          /* 指纹/卷宗读取失败 → 放行真重读（fail-open，与全文件口径一致） */
        }
      }

      // ===== 74条：本次调用确定执行 → 备份改动前内容到 .ai/backup/（新文件无内容可备份，自动跳过）=====
      if (RE_WRITE.test(tool) && !handoff && rawPath) {
        try {
          backupBeforeEdit(rawPath, projDirOf(exec))
        } catch {
          audit(sid, 'note-fail', { evidence: `74条 改动前备份失败 ${filePath}` })
        }
      }
    } catch (error) {
      if (typeof warn === 'function') warn('补充执法缝异常，fail-open 放行：', (error && error.message) || error)
    }
    return next()
  }
}
