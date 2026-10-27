/**
 * 第 3 层·状态校验 + 取证闸（2026-10-27 从 pipeline.mjs 抽出，纯搬运）。
 *
 * 权威落盘点（实测 guard.mjs:255-268, 372-395）：
 *   会话状态 → os.tmpdir()/focus-guard-<会话id>.json，字段 fused / forcedInvestigate / probation / readSet
 *   执法留痕 → <工作区>/.focus-guard/AUDIT.log（guard.mjs:19；工作区由 ZCODE_PROJECT_DIR/CLAUDE_PROJECT_DIR 定，缺省 tmpdir）
 *   取证记录 → <工作区>/.ai/CASE_FILE.md 的【三】（guard.mjs 写；原生插件另有记账类【五】）
 * 注意：任务书写的「熔断状态在 packages/core/.focus-guard/」不准确——该目录只有 AUDIT.log；
 * 熔断标志实际落在 os.tmpdir() 的会话状态文件里。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { auditDeny } from '../audit.mjs'
import { isMutatingBashCmd } from '../../core/redlines.mjs'
import { statePath as guardStateFile, loadState, saveState } from '../../core/state.mjs'
import {
  READ_TOOL,
  SHELL_TOOL,
  commandOf,
  evidenceKeyOf,
  isMutatingInvocation,
  pathOfTool,
  resolveToolPath,
  sameEvidenceKey,
  sessionIdOf,
  shellWriteTargets,
} from './tooling.mjs'

export const STATE_GATE = { effective: true }
export const EVIDENCE_GATE = { effective: process.env.FG_EVIDENCE_GATE !== '0' }
const GUARD_STATE_MAX_AGE_MS = 60 * 60 * 1000

/**
 * 取最近一个真实会话状态（排除 eval 快照）。
 * 入参可以是目录（默认 os.tmpdir()）或一个具体的状态文件路径（自检注入用）。
 * 顺序：先按 mtime 取最新一个 focus-guard-*.json → 再判定是否在 GUARD_STATE_MAX_AGE_MS 内。
 * 无可用状态（无文件 / 过旧 / 解析失败）返回 null，由调用方 fail-open + warn。
 */
export function readGuardState(target = tmpdir()) {
  try {
    const isFile = /\.json$/i.test(String(target)) && !String(target).endsWith('\\') && !String(target).endsWith('/')
    if (isFile) {
      const state = JSON.parse(readFileSync(target, 'utf8'))
      if (state && typeof state === 'object') return { file: target, state }
      return null
    }

    const dir = target
    const latest = readdirSync(dir)
      .filter((n) => n.startsWith('focus-guard-') && n.endsWith('.json') && !n.startsWith('focus-guard-eval-'))
      .map((n) => join(dir, n))
      .map((p) => ({ p, st: statSync(p) }))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0]
    if (!latest) return null
    if (Date.now() - latest.st.mtimeMs >= GUARD_STATE_MAX_AGE_MS) return null // 最新一个也已过期
    const state = JSON.parse(readFileSync(latest.p, 'utf8'))
    if (state && typeof state === 'object') return { file: latest.p, state }
    return null
  } catch {
    return null
  }
}

// 3.0.8：按【会话身份】分表（原为模块级单一 Set，跨会话共享）。
// DSH 单进程里多个会话共用同一份 pipeline 模块，共享 Set 会让"会话 A 读过的文件"
// 被判成"会话 B 也读过"——违反取证的本会话语义（新增用例「会话隔离」锁定了这一点）。
const nativeReadSet = new Map() // sid → Set<path>
const evidenceBlockedOnce = new Map() // sid → Set<path>
/** 取某会话的集合（不存在则建）。 */
const setOf = (m, sid) => {
  let s = m.get(sid)
  if (!s) {
    s = new Set()
    m.set(sid, s)
  }
  return s
}

/**
 * 本会话是否"读过"该文件。先查直命（归一化键），再兼容历史/异形态键
 *（postProgress 存的是相对正斜杠、老记录可能存原始相对路径）——逐个解析后比较。
 */
function isReadRecorded(state, sid, absKey, exec) {
  const seen = setOf(nativeReadSet, sid)
  const rs = state && state.readSet && typeof state.readSet === 'object' ? state.readSet : {}
  if (seen.has(absKey) || Object.hasOwn(rs, absKey)) return true
  const candidates = [...seen, ...Object.keys(rs)]
  for (const c of candidates) {
    const k = evidenceKeyOf(c, exec)
    if (k && sameEvidenceKey(k, absKey)) return true
  }
  return false
}

/**
 * 记录本会话内已读过的文件（第 3 层取证判定的原生侧证据）。
 *
 * 3.0.8（孤儿机制审计）：除内存 Set 外**同时落盘**到本会话状态文件。
 * 为什么必须落盘：内存 Set 随模块重载（HMR）与进程重启清零，而 DSH 侧此前**没有 state 写入者**
 * （唯一的写者 guard.mjs 在 DSH 下未挂载）——于是取证记录会凭空消失，表现为"明明读过却被判未取证"。
 * 这是"原生插件自持状态"的第一处写权；KPI / 预算池等机制后续也依赖它。
 * 仅在**新增**记录时落盘，避免每次 Read 都写一次盘。
 */
export function rememberReads(exec) {
  if (!READ_TOOL.test(String((exec && exec.name) || ''))) return
  const p = pathOfTool(exec && exec.arguments)
  if (!p) return
  // 2026-10-19：键必须与查证侧（resolveToolPath 的绝对路径）同形态，否则"读过"永远查不到。
  const key = evidenceKeyOf(p, exec) || String(p)
  const sid = sessionIdOf(exec)
  const seen = setOf(nativeReadSet, sid)
  if (seen.has(key)) return
  seen.add(key)
  try {
    const file = guardStateFile(sid)
    // loadState 在文件不存在时返回默认结构（含 readSet: {}），无需先判存在
    const state = loadState(file)
    state.readSet = state.readSet && typeof state.readSet === 'object' ? state.readSet : {}
    state.readSet[key] = Date.now()
    saveState(file, state)
  } catch (error) {
    // 落盘失败不阻断（内存 Set 仍有效）；但必须留痕——静默丢取证记录属"假留痕"
    console.warn('[focus-guard-native] 取证记录落盘失败（内存记录仍有效）:', (error && error.message) || error)
  }
}

/**
 * 本会话状态读取器（3.0.8 · 孤儿机制审计的修复）。
 * 用 exec 的会话身份**精确定位** `statePath(sessionId)`，**绝不做目录扫描**。
 *
 * 为什么必须这样：原实现走 `readGuardState(undefined)` → 退化成"扫 os.tmpdir() 取 mtime 最新"，
 * 于是会读到**别的会话或测试的残留**，拿它们（往往是空的）readSet 去判你的真实改动。
 * 实测 os.tmpdir() 里有 199 个 `focus-guard-eval-*`（被过滤掉）外加 acceptance/selftest 写的
 * `focus-guard-<测试sid>-<RUN>.json`（**过滤不掉**），于是"拦不拦你"取决于最近跑没跑测试。
 * 自检可传具体文件路径覆盖（statePathOverride）。
 */
function readGuardStateExact(exec, override) {
  const file =
    override && /\.json$/i.test(String(override)) ? String(override) : guardStateFile(sessionIdOf(exec))
  try {
    if (!existsSync(file)) return null
    const state = JSON.parse(readFileSync(file, 'utf8'))
    return state && typeof state === 'object' ? { file, state } : null
  } catch {
    return null
  }
}

/**
 * 第 3 层判定：返回 deny 决策或 null（放行到下游）；读失败一律 fail-open + warn。
 *
 * 反规避抽查B（2026-10-19 人类批示；**2026-10-27 改：默认只留痕，不打断**）。
 *
 * 原实现是「拒一次 → 重试即放行」。审计实测（2026-10-06~10-26，6230 行）：
 *   命中 61 次，全部集中在 1 个长会话（turn 174，第 179/183/187 次写操作…）。
 *   而拒绝理由原文写着"重试即放行"——即**不检查任何内容、不要求任何声明**，
 *   模型最理性的反应就是原样重试。它收不到信息，也拦不住任何东西。
 *
 * 代价是确定的：每拒一次 = 多一次工具往返（≥15k 前缀 + 输出，长会话里最贵）。
 * 收益是 0：它没有核对任何内容。而抽查A（RANDOM_AUDIT_EVERY，同期 143 次）
 * 已经在做同样"不可预测"的留痕，且零成本。抽查B 的净增量只有"打断"。
 * → 往返比拦截贵，所以默认不打断。
 *
 * 保留：计数（fuseOps/fuseNextAt）、post 侧审计行、pending 状态（供观测）。
 * 逃生口：`FG_RANDOM_FUSE_BLOCK=1` 恢复旧语义（拒一次即放行），供需要时序干扰时用。
 * 安全取向不变：状态清不掉就**不拒**（宁可不拦，也不做永久死锁）。
 */
function layer3Check(exec, warn, statePathOverride) {
  const tool = String((exec && exec.name) || '')
  // 2026-10-27：按 (工具, 动作) 判改动——`plugin_manager` 的 list_* 只读列举不写盘，
  // 不能落进下面的"改动类无路径"分支；写动作仍按改动类处理。
  // 参数读取必须防炸（同下段注释）：DSH 允许 arguments 为惰性 getter，
  // 它可能抛错；此处只是取动作名，取不到就按"非只读"（安全默认）。
  let argsForAction = null
  try {
    argsForAction = (exec && exec.arguments) || null
  } catch {
    argsForAction = null
  }
  const isMutating = isMutatingInvocation(tool, argsForAction)
  // 2026-10-18 补口：shell 重定向/写 cmdlet 与 Edit 是等效写操作，取证闸不能只认工具名；
  // 变更型 shell（git commit / npm install）与写类工具同等对待，熔断期一律只读放行。
  const { shellTargets, shellMutating } = shellMutationOf(exec)
  if (!isMutating && shellTargets.length === 0 && !shellMutating) return null

  const gs = readGuardStateExact(exec, statePathOverride)
  if (gs === null) {
    warn('第3层：本会话尚无状态文件（fail-open 放行；无读写记录时不做取证判定）')
    return null
  }
  const { state } = gs
  if (STATE_GATE.effective && (state.fused || state.probation)) {
    const which = state.probation ? 'L5 降权' : '熔断'
    return {
      kind: 'deny',
      reason: `focus-guard-native 第3层状态校验：guard 权威状态为「${which}」，改动类调用（${tool}）被拒；只读放行，解除按 guard 流程`,
    }
  }

  const fuse = randomFuseVerdict({ state, file: gs.file, warn })
  if (fuse) return fuse

  return evidenceTargetsVerdict({ exec, warn, tool, isMutating, shellTargets, state })
}

/**
 * 反规避抽查B（2026-10-19 人类批示；2026-10-27 改：默认只留痕，不打断）。
 * 状态清不掉就不拒（宁可不拦，也不做永久死锁）；`FG_RANDOM_FUSE_BLOCK=1` 恢复"拒一次"。
 */
function randomFuseVerdict({ state, file, warn }) {
  if (!state.randomFusePending) return null
  try {
    saveState(file, { ...state, randomFusePending: false })
    if (String(process.env.FG_RANDOM_FUSE_BLOCK || '') === '1') {
      return {
        kind: 'deny',
        trigger: 'random-fuse',
        reason:
          `focus-guard-native 反规避抽查B：随机检查点命中（第 ${Number(state.randomFuseAt) || 0} 次写操作），本次变更被拒一次；` +
          '这不是报错，是防「攒批量绕过」的不可预测抽查，重试即放行。',
      }
    }
  } catch (error) {
    warn('反规避抽查B：检查点状态回写失败 → 本次放行（不做永久死锁）:', (error && error.message) || error)
  }
  return null
}

/** shell 类工具的写目标与"变更型"判定；参数惰性 getter 抛错时降级为"无写目标、非变更型"。 */
function shellMutationOf(exec) {
  let shellTargets = []
  let shellMutating = false
  const tool = String((exec && exec.name) || '')
  if (!SHELL_TOOL.test(tool)) return { shellTargets, shellMutating }
  try {
    const cmd = commandOf(exec)
    shellTargets = shellWriteTargets(cmd)
    shellMutating = isMutatingBashCmd(String(cmd ?? ''))
  } catch {
    shellTargets = []
    shellMutating = false
  }
  return { shellTargets, shellMutating }
}

/**
 * 取证闸：改动类工具 / shell 写目标必须在**本会话**读过。
 *
 * 2026-10-22 补口：改动类工具**解析不出路径**时（`plugin_manager`、`move_run`、`import_claude`、
 * `mcp__x__build_project` 等），取证闸无法核验"是否先读过"——旧行为是直接放行，
 * 等于这些工具天生免检。现改为默认要求授权（`fg_apply` 一次放行），可用
 * `FG_MUTATION_UNMAPPED=allow` 退回旧行为。
 */
function evidenceTargetsVerdict({ exec, warn, tool, isMutating, shellTargets, state }) {
  if (!EVIDENCE_GATE.effective) return null
  // 2026-10-19 修：真实调用传相对路径（`Add-Content -Path packages/core/README.md`），
  // 未解析时 existsSync 按宿主 cwd 判 → 假阴性 → 取证闸放行（实测 session-002c143b 第 2 条直通）。
  // 2026-10-27：`plugin_manager` 的 `target` 是包名/条目 id，不是文件路径。旧实现把它
  // 当路径 → 解析出一个不存在的"新文件" → 安装类调用反而绕过了"要求授权"分支。
  const toolPath =
    isMutating && /^plugin_manager$/i.test(tool)
      ? null
      : resolveToolPath(pathOfTool(exec && exec.arguments), exec)
  if (isMutating && !toolPath) {
    if (String(process.env.FG_MUTATION_UNMAPPED || '').toLowerCase() === 'allow') {
      warn('改动类工具无路径（FG_MUTATION_UNMAPPED=allow）→ 放行：', `tool=${tool}`)
    } else {
      auditDeny(exec, `改动类工具无可解析路径：${tool}`, { trigger: 'mutation:unmapped' })
      return {
        kind: 'deny',
        reason:
          `focus-guard-native: 改动类工具「${tool}」未提供可解析的文件路径，取证闸无法核验"是否先读过"。` +
          `请先用 fg_apply 申请一次授权（tool="${tool}"），或改用带 file_path 的工具。`,
      }
    }
  }
  const targets = isMutating
    ? (toolPath ? [toolPath] : [])
    : shellTargets.map((p) => resolveToolPath(p, exec)).filter(Boolean)
  for (const fp of targets) {
    const key = String(fp).replace(/\\/g, '/')
    const sid = sessionIdOf(exec)
    const known = isReadRecorded(state, sid, key, exec)
    // 3.0.7（HANDOFF §十一 任务 C）：取证闸只对"**已存在**目标的修改"有意义。
    // 新建文件没有可读的既有内容 —— 文件不存在 → 读不了 → 永远进不了 readSet →
    // 只能靠"拒一次后豁免"逃生，是死锁。故目标不存在（新建）时直接放行，不要求先读。
    // existsSync 失败（权限/异常）一律视为"不存在"，与取证闸其余分支的 fail-open 口径一致。
    if (!known && existsSync(key) && !setOf(evidenceBlockedOnce, sid).has(key)) {
      setOf(evidenceBlockedOnce, sid).add(key)
      return {
        kind: 'deny',
        reason: `focus-guard-native 第3层状态校验：卷宗无取证记录（本会话未读 ${fp}），改动类调用被拒一次；先读取该文件再重试（避免盲写）`,
      }
    }
  }
  return null
}

/** pre-execute 阶段：取证/熔断状态判定（异常不吞，保持原语义）。 */
export async function evidenceStage(ctx) {
  return layer3Check(ctx.exec, ctx.warn, ctx.statePath)
}
