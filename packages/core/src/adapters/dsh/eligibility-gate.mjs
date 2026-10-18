/**
 * focus-guard 适配层 · 资格审核闸（3.0.5 第二步）
 *
 * 双入口闭环：
 *   入口一 fg_apply（applyEligibility + FG_APPLY_TOOL_SPEC）：AI 提交目的/影响范围 → 审核 → 通过则按 session 授权
 *   入口二 gateToolCall（pre-execute 调用）：高危工具无授权 → deny，理由指向 fg_apply
 *
 * 分层纪律：本文件属适配层，向母版注入 redlines / audit / model；母版不反向依赖本层。
 * grants 是 FG 自己的状态（按 session 分表，内存版；第五步持久化到 FG 状态文件），不进 guard.mjs 的 state。
 * 审计默认写 .focus-guard/AUDIT.log；FG_AUDIT_FILE 可重定向——自检**只写 tmpdir()**，绝不碰真实工作区。
 */
import { appendFileSync } from 'node:fs'
import { checkEligibility, HIGH_RISK_TOOLS, SYSTEM_PATH_RE, profileScope, IRREVERSIBLE_IDS } from '../../core/checkEligibility.mjs'
import { redlineExempt, isMutatingBashCmd } from '../../core/redlines.mjs'
import { loadProfile } from '../../core/profileLoader.mjs'
import { createGrantTable } from '../../core/grants.mjs'
import { AUDIT_FILE, appendAudit } from '../../core/audit-writer.mjs'
import { createApprovalRequest, consumeApproval } from '../../core/approvals.mjs'

/** 需要人工批准的不可逆类别（默认只严抓 rm-rf；strictAll 时扩到全部）。 */
function strictGateHit(gateId) {
  if (!PTC.strictIrreversible || !gateId) return false
  if (gateId === 'rm-rf') return true
  return PTC.strictAll && IRREVERSIBLE_IDS.includes(gateId)
}

/** 人工闸门的提示文案（模型侧可见，含可直接照抄的 CLI 命令）。 */
function approvalHint(id) {
  return `已生成审批请求 ${id}：请在终端执行 node packages/core/tools/focusguard.mjs approve ${id}，批准后重试本次调用即放行（一次性，ttl=turn）。`
}

/**
 * FGA-PTC 策略开关（主图 L3「默认只读 / 隐藏高危」+「静默秒批」）。
 *
 * 默认**关闭**——它改变的是"默认放行还是默认拦截"这条主干语义，
 * 不能被开关暗地里改掉。开启方式：
 *   FG_PTC_READONLY=1      默认只读：写类工具与变更型 shell 一律先申请
 *   FG_PTC_AUTO_GRANT=1    静默秒批：**可逆**类别（publish / global-install / chmod-wide）自动批准，
 *                          不可逆类别（rm-rf / format-volume / drop-database / git-push-force /
 *                          write-system-path）仍走人工
 *
 * 关于"隐藏高危工具"：工具 schema 由宿主注入，FG 改不了；能做的只有把高危工具变成
 * "默认拒绝、按需解锁"（即本策略），以及在拒绝理由里明确指引 fg_apply。
 */
export const PTC = {
  /** 默认只读：写类工具与变更型 shell 一律先申请。 */
  get readOnlyDefault() {
    return process.env.FG_PTC_READONLY === '1'
  },
  /** 静默秒批：可逆类别自动批准。 */
  get autoGrant() {
    return process.env.FG_PTC_AUTO_GRANT === '1'
  },
  /**
   * 不可逆类别必须人工（2026-10-18 人类定 B 方案：**默认开**）。
   *
   * 病根：`applyOneEligibility` 在审核期给该工具**临时授权**，让母版 L3 不要被"无授权"挡在自己入口上；
   * 副作用是 L3 一律通过 —— 于是 `rm -rf ./src` 这类不可逆删除也是**自证自批**。
   *
   * 默认策略（人类批示）：**只严抓 `rm-rf`**（真正能走到申请通道的不可逆操作；
   * format-volume / drop-database / git-push-force 已由绝对红线层直接拦，不经过申请）。
   * 逃生口：`FG_PTC_ALLOW_RM_RF=1` 允许 rm-rf 自证自批（应急用，会在审计里留痕）。
   * 扩展：`FG_PTC_STRICT_ALL=1` 把全部 IRREVERSIBLE_IDS 纳入人工闸。
   */
  get strictIrreversible() {
    return process.env.FG_PTC_ALLOW_RM_RF !== '1'
  },
  get strictAll() {
    return process.env.FG_PTC_STRICT_ALL === '1'
  },
}

/** 写类工具（默认只读模式下必须申请）。 */
const PTC_WRITE_TOOLS = /^(?:Write|Edit|MultiEdit|NotebookEdit|Delete|Move|Patch|ApplyPatch)$/i
/** 命令执行类工具（要看命令是否变更型）。 */
const PTC_SHELL_TOOLS = /^(?:Bash|Shell|sh|pwsh|powershell|cmd|Terminal|RunCommand)$/i

/**
 * 默认只读模式下的门槛判定：写类工具、以及变更型 shell 命令，未授权即拦。
 * @returns {string|null} 门槛 id（ptc:write / ptc:shell），非门槛返回 null
 */
export function ptcReasonOf(tool, command = '') {
  if (!PTC.readOnlyDefault) return null
  const name = String(tool ?? '')
  if (PTC_WRITE_TOOLS.test(name)) return 'ptc:write'
  if (PTC_SHELL_TOOLS.test(name) && isMutatingBashCmd(String(command ?? ''))) return 'ptc:shell'
  return null
}

/** 对系统路径的写入类工具：与命令型高危同属"必须先申请"的门槛清单（显式成文）。 */
export const GATED_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

/** 可直接重建的 rm -rf 目标：构建产物 / 缓存 / TEMP。命中则不进门槛清单（交回第 2 层分级判定）。 */
const DISPOSABLE_TARGET_RE =
  /(?:^|[\\/])(?:dist|build|out|output|target|coverage|\.cache|\.next|\.nuxt|\.turbo|node_modules)(?:[\\/]|$)|^(?:\/tmp|\/var\/tmp|\$TMPDIR|%TEMP%|%TMP%)|[\\/]AppData[\\/]Local[\\/]Temp(?:[\\/]|$)/i

/** 取 rm 命令的最后一个非旗标 token 作为删除目标。 */
function rmTargetOf(cmd) {
  const m = String(cmd ?? '').match(/\brm\b([^\n;&|]*)/i)
  if (!m) return ''
  const tokens = m[1]
    .trim()
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('-'))
  if (tokens.length === 0) return ''
  return tokens[tokens.length - 1].replace(/^["']|["']$/g, '')
}

/**
 * 判定本次调用是否属"必须先申请"的类别。
 * @param {string} tool
 * @param {string} [command] 命令型工具的命令原文
 * @param {string} [filePath] 写入型工具的目标路径（Write/Edit 的 file_path）
 * @returns {string|null} 命中的门槛 id（rm-rf / format-volume / … / write-system-path），不属门槛则 null
 */
export function gatedReasonOf(tool, command = '', filePath = '') {
  const cmd = String(command ?? '')
  const hit = HIGH_RISK_TOOLS.find((r) => r.re.test(cmd))
  if (hit) {
    // 3.0.7（HANDOFF §十一 缺陷 3）：与红线层 / 母版 L2 同口径。
    // HIGH_RISK_TOOLS 只做文本匹配，无法区分「要执行的命令」与「被引用的命令字符串」，
    // 于是引号内的危险数据虽已被红线层与母版 L2 豁免，却仍进门槛清单被闸直接 deny——
    // 三方口径不一致。此处对命令型条目先问一次上下文豁免：豁免成立则不进门槛清单，
    // 交回原有判定链（pipeline 文本层 → 硬校验 → 本闸 → 语义预判），由下游按正常语义裁决。
    // 豁免不成立（裸危险命令、执行外壳包装）时行为不变，仍按门槛拦。
    if (redlineExempt(cmd, hit)) return null
    // 2026-10-18 任务测试 T35/T36：`rm -rf ./dist`、`rm -rf /tmp/...` 属常规构建清理，
    // 与第 2 层已做的分级（destructiveApiWeight：TEMP 0.2 / 递归系统 0.9）口径统一——
    // 目标是可重建目录/TEMP 时不进门槛清单，交给第 2 层按风险分级裁决，不再一律要 fg_apply。
    if (hit.id === 'rm-rf' && DISPOSABLE_TARGET_RE.test(rmTargetOf(cmd))) return null
    return hit.id
  }
  const name = String(tool ?? '').toLowerCase()
  // 写入型工具的系统路径检查（2026-10-18 任务测试 T39 修）：此前只拿命令字符串去匹配，
  // 而 Write/Edit 的路径在 file_path 里、command 恒为空 → 写系统目录从未被拦（漏拦）。
  if (GATED_WRITE_TOOLS.some((t) => t.toLowerCase() === name)) {
    const target = String(filePath || cmd || '')
    if (SYSTEM_PATH_RE.test(target)) return 'write-system-path'
  }
  return null
}

// —— FG 自己的授权状态：按 session 分表（内存；第五步持久化）——
const TABLES = new Map()

/** 该会话的授权表（不存在则建）。 */
export function grantsFor(session) {
  const key = String(session || 'dsh-native')
  let table = TABLES.get(key)
  if (!table) {
    table = createGrantTable()
    TABLES.set(key, table)
  }
  return table
}

/** 回收整张表（会话结束；ttl 未到期也不会留到下一个会话）。 */
export function resetGrants(session) {
  return TABLES.delete(String(session || 'dsh-native'))
}

/**
 * 按 ttl 档回收授权（2026-10-18 补口：此前 ttl 只记录、从不回收，等于申请一次永久放行）。
 * 由宿主缝在事件边界调用：回合结束 → 'turn'；任务结束 → 'task'。
 * @param {string} session
 * @param {"turn"|"task"} kind
 * @returns {string[]} 被回收的工具名
 */
export function sweepGrants(session, kind) {
  const table = TABLES.get(String(session || 'dsh-native'))
  if (!table) return []
  const removed = table.sweep(kind)
  if (removed.length > 0) {
    auditEligibility({
      ts: new Date().toISOString(),
      session: String(session || 'dsh-native'),
      action: 'grants-swept',
      trigger: `ttl:${kind}`,
      evidence: removed.join(','),
    })
  }
  return removed
}

/**
 * 资格审核审计（规格 §七 字段口径）。统一走 `appendAudit`——由它负责体积轮转，
 * 并与 auditDeny / auditRedlineExempt 共用同一写入口径（2026-10-09 污染事故的教训）。写失败只 warn。
 */
export function auditEligibility(row) {
  return appendAudit({ ts: new Date().toISOString(), ...row })
}

// ── 原生侧批量审批（主图 L3 FGA「合并出示 / 静默秒批」）──
// 母版 approval.mjs 的 highRiskQueue/queueNote 只服务 ZCode 路径；原生侧此前没有待批队列，
// 于是每条高危都要"申请 + 重试"两次往返。这里补一个按会话的待批队列，配合 applyEligibility
// 支持逗号分隔的批量工具名。
const PENDING = new Map()
const PENDING_MAX = 20

/** 该会话的待批队列（副本）。 */
export function pendingOf(session) {
  return (PENDING.get(String(session || 'dsh-native')) || []).slice()
}

/** 记一条待批（同 tool+reason 去重，超上限丢最旧）。 */
export function notePending(session, tool, reason, command = '') {
  const key = String(session || 'dsh-native')
  const list = PENDING.get(key) || []
  if (!list.some((x) => x.tool === tool && x.reason === reason)) {
    list.push({ tool, reason, at: Date.now(), brief: String(command || '').slice(0, 60) })
    while (list.length > PENDING_MAX) list.shift()
    PENDING.set(key, list)
  }
  return list.length
}

/** 清空该会话的待批队列（批量申请通过后调用）。 */
export function clearPending(session) {
  return PENDING.delete(String(session || 'dsh-native'))
}

/**
 * 入口一的核心：申请 → 审核 → 授权。
 *
 * 关键语义：fg_apply 本身是**申请通道**，所以审核期间先把该工具视为"已有授权"，让母版第 3 层
 * 聚焦于"可否授予"（状态/红线/前置/语义），而不是被"无授权即需审批"挡在自己的入口上。
 * 审核未通过时立即收回这一临时授权——被拒就绝不能放行。
 *
 * @returns {Promise<{decision:"allow"|"deny"|"needApproval", layer:string, reason:string, modelSignal:object|null, trace:Array}>}
 */
export async function applyEligibility(spec) {
  // 批量申请（2026-10-18）：`tool` 支持 "Bash,Write" 这类逗号/空白分隔列表，
  // 一次审核通过全部授权——与母版 approval.mjs 的"合并出示、回复 y 放行全部待批"同一意图。
  const rawTool = String((spec && spec.tool) || '')
  const list = rawTool
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (list.length > 1) {
    const results = []
    for (const one of list) results.push(await applyOneEligibility({ ...spec, tool: one }))
    const blocked = results.find((r) => r.decision !== 'allow')
    const decision = blocked ? blocked.decision : 'allow'
    if (!blocked) clearPending(spec.session)
    return {
      decision,
      layer: blocked ? blocked.layer : '6',
      reason: blocked
        ? `批量申请中 ${blocked.tool || ''} 未通过：${blocked.reason}`
        : `批量授权通过：${list.join(', ')}`,
      modelSignal: blocked ? blocked.modelSignal : null,
      trace: blocked ? blocked.trace : [{ layer: 6, decision: 'allow', reason: '批量授权（合并出示）' }],
      tools: list,
    }
  }
  return applyOneEligibility({ ...spec, tool: list[0] ?? rawTool })
}

/** 单工具申请（applyEligibility 的内部实现；外部请走 applyEligibility）。 */
async function applyOneEligibility({
  session,
  tool,
  command = '',
  purpose,
  scope,
  ttl = 'turn',
  target,
  state = {},
  redlines = [],
  model = null,
  profile = null,
  modelId,
}) {
  const grants = grantsFor(session)
  const preGranted = grants.has(tool)
  if (!preGranted) grants.grant(tool, { ttl, reason: 'fg_apply 审核中（临时）' })
  // 3.0.6 补口（HANDOFF §十 缺陷 1）：画像必须透传到母版，否则真实 fg_apply 路径 profile=null，
  // 画像对所有层失效——此前画像差异只在 decide() 那条路可达。
  const resolved = profile ?? (modelId ? loadProfile(modelId) : null)
  const result = await checkEligibility({
    tool,
    command,
    purpose,
    scope,
    ttl,
    target,
    state,
    redlines,
    model,
    profile: resolved,
    grants,
    audit: (row) => auditEligibility({ session, ...row }),
  })
  // FGA-PTC 人工闸门（B 方案，默认开）：不可逆类别不得自证自批。
  const selfGateId = gatedReasonOf(tool, command) || ptcReasonOf(tool, command)
  if (selfGateId && !preGranted) {
    // 人类已在终端批准过这条（同命令哈希）？消费后直接放行一次。
    const consumed = consumeApproval(tool, command)
    if (consumed.consumed) {
      grants.grant(tool, { ttl, reason: `人工批准（approvals ${consumed.id}）`, layer: '6' })
      auditEligibility({
        session,
        action: 'approval-consumed',
        tool,
        command: String(command ?? '').slice(0, 120),
        layer: 'gate',
        decision: 'allow',
        evidence: consumed.id,
      })
      return {
        decision: 'allow',
        layer: '6',
        reason: `人工已批准（${consumed.id}），本次放行（ttl=${ttl}）`,
        modelSignal: null,
        trace: [{ layer: 6, decision: 'allow', reason: `approval-consumed ${consumed.id}` }],
      }
    }
  }
  if (strictGateHit(selfGateId) && !preGranted && result.decision === 'allow') {
    grants.revoke(tool)
    const req = createApprovalRequest({
      session,
      tool,
      command,
      gateId: selfGateId,
      reason: '不可逆类别需人类批准（B 方案：rm-rf 默认拦截）',
    })
    auditEligibility({
      session,
      action: 'ptc-irreversible-blocked',
      tool,
      command: String(command ?? '').slice(0, 120),
      layer: 'gate',
      decision: 'needApproval',
      evidence: `${selfGateId} | request=${req.id}`,
    })
    auditEligibility({
      session,
      action: 'approval-requested',
      tool,
      command: String(command ?? '').slice(0, 120),
      layer: 'gate',
      decision: 'needApproval',
      evidence: req.id,
    })
    return {
      decision: 'needApproval',
      layer: 'gate',
      reason: `不可逆类别（${selfGateId}）必须人类批准，本次未授予任何授权。${approvalHint(req.id)}`,
      modelSignal: null,
      trace: [{ layer: 6, decision: 'needApproval', reason: `ptc-irreversible ${selfGateId} request=${req.id}` }],
    }
  }
  // FGA-PTC 静默秒批（主图 L3 FGA3）：**可逆类别**不必等人工，审核期内直接授予并留痕；
  // 不可逆类别（IRREVERSIBLE_IDS）仍走原有 needApproval 路径，绝不静默批准。
  if (PTC.autoGrant && result.decision === 'needApproval') {
    const gateId = selfGateId
    if (gateId && !IRREVERSIBLE_IDS.includes(gateId)) {
      grants.grant(tool, { ttl, reason: `PTC 静默秒批（${gateId}）`, layer: '6' })
      auditEligibility({
        session,
        action: 'ptc-auto-grant',
        tool,
        command: String(command ?? '').slice(0, 120),
        layer: 'gate',
        decision: 'allow',
        evidence: gateId,
      })
      return {
        decision: 'allow',
        layer: '6',
        reason: `PTC 静默秒批：${gateId} 属可逆类别，已自动授权（ttl=${ttl}）`,
        modelSignal: null,
        trace: [{ layer: 6, decision: 'allow', reason: `ptc-auto-grant ${gateId}` }],
      }
    }
  }
  if (result.decision !== 'allow' && !preGranted) grants.revoke(tool)
  return result
}

/**
 * 入口二：pre-execute 的 grants 校验。
 * @returns {{kind:"pass", granted?: boolean}} 不属门槛清单、或已有授权 → 交回原有判定链
 *          {{kind:"deny", reason: string}} 属门槛且无授权 → 拦截
 */
export function gateToolCall({ session, tool, command = '', filePath = '', state, profile = null } = {}) {
  // 默认只读（PTC）优先：写类工具 / 变更型 shell 在未授权时直接拦，与高危清单同一套授权表。
  const reason = gatedReasonOf(tool, command, filePath) || ptcReasonOf(tool, command)
  if (!reason) return { kind: 'pass' }
  // 3.0.6（HANDOFF §十 缺陷 5）：与母版 L3 同源——审批层**不可被画像关闭**（只受 scope 约束），
  // 否则会出现"decide 放行而闸拦截"或"闸放行而母版拦截"的路径分叉。
  const scope = profileScope(profile)
  if (scope === 'irreversible' && !IRREVERSIBLE_IDS.includes(reason)) {
    return { kind: 'pass', outOfScope: true }
  }
  const grants = grantsFor(session)
  if (grants.has(tool)) return { kind: 'pass', granted: true }
  // B 方案人工闸门：人类已在终端批准过这条命令 → 消费批准并放行一次。
  const consumedHere = consumeApproval(tool, command)
  if (consumedHere.consumed) {
    grants.grant(tool, { ttl: 'turn', reason: `人工批准（approvals ${consumedHere.id}）`, layer: '6' })
    auditEligibility({
      session,
      action: 'approval-consumed',
      tool,
      command: String(command ?? '').slice(0, 120),
      layer: 'gate',
      decision: 'allow',
      evidence: consumedHere.id,
    })
    return { kind: 'pass', granted: true }
  }
  // 2026-10-18 原生侧批量审批（主图 L3 FGA「静默秒批/合并出示」的原生实现）：
  // 每次拦截都进待批队列，后续拦截的理由里带上"另有 N 条待批"，让模型可以一次 fg_apply 批量申请，
  // 而不是每命中一条就往返两步（申请 + 重试）。
  notePending(session, tool, reason, command)
  const others = pendingOf(session).filter((x) => x.tool !== tool)
  const batchHint =
    others.length > 0
      ? `；另有 ${others.length} 条待批已合并（可一次申请：tool="${[tool, ...others.map((x) => x.tool)].join(',')}"）`
      : ''
  // rm-rf（默认人工闸）：生成审批请求并把 CLI 命令直接写进理由，模型无需再猜怎么解。
  let approvalPart = ''
  if (strictGateHit(reason)) {
    const req = createApprovalRequest({
      session,
      tool,
      command,
      gateId: reason,
      reason: '不可逆类别需人类批准（B 方案：rm-rf 默认拦截）',
    })
    auditEligibility({
      session,
      action: 'approval-requested',
      tool,
      command: String(command ?? '').slice(0, 120),
      layer: 'gate',
      decision: 'needApproval',
      evidence: req.id,
    })
    approvalPart = `；**不可逆操作需人类批准**：${approvalHint(req.id)}`
  }
  const detail = `该工具需先调 fg_apply 申请授权（命中 ${reason}）${batchHint}${approvalPart}`
  auditEligibility({
    session,
    action: 'deny',
    tool,
    command: String(command ?? '').slice(0, 120),
    layer: 'gate',
    decision: 'deny',
    modelSignal: null,
    evidence: detail,
  })
  return { kind: 'deny', reason: detail }
}

/**
 * fg_apply 的工具注册规格。接线时套用装机 dsh-tools 的 defineTool 契约（name/description/parameters +
 * 执行体），执行体只需 await applyEligibility(args) 并按 decision 渲染文案，无额外逻辑。
 */
export const FG_APPLY_TOOL_SPEC = {
  name: 'fg_apply',
  description:
    '向 FocusGuard 申请高危工具的临时执行资格。执行高危命令（rm -rf / 格式化 / git push -f / 发布 / 全局安装 / 系统路径写入）之前必须先申请；purpose 与 scope 必填。通过后本会话内按 ttl 放行（turn/task/persist，到期回收），被拒则不得执行。支持批量：tool 可写 "Bash,Write" 一次覆盖多条待批（拦截理由里会给出可批量申请的工具名）。',
  parameters: {
    tool: {
      type: 'string',
      required: true,
      description: '目标工具名，如 Bash / Write / Edit；批量用逗号分隔，如 "Bash,Write"',
    },
    command: { type: 'string', required: true, description: '命令或操作描述' },
    purpose: { type: 'string', required: true, description: '真实目的（必填，不得空白）' },
    scope: { type: 'string', required: true, description: '影响范围（必填，不得空白）' },
    ttl: { type: 'string', required: false, enum: ['turn', 'task', 'persist'], description: '授权有效期，默认 turn' },
    target: { type: 'string', required: false, description: '目标路径（改动类可选，供第 4 层取证比对）' },
  },
}

// ═══════════ 3.0.7 · 误伤申辩（司法救济通道）═══════════
// 缺口背景（外部审计指出、并经逐字复核成立）：原体系只有"立法救济"（事后改规则），
// 没有"司法救济"（个案当场申辩）。HANDOFF §八 的红线误伤即实证——被拦后AI无程序可走，
// 只能绕过（[char]47 拼接）或等修法（3.0.6 上下文豁免），成本差两个数量级。
// 本机制复用既有审批骨架：申辩 → {kind:"ask"} → 人类一次性裁决 → 留痕。
// 注意：第八十三条(三) 原写"拦截申诉…仍走第十二章"，而第十二章是【反规避与纪律审查】（处罚章），
// 属条文错配——本机制即为该错配补上的实体程序。

/** 红线豁免凭据的授权键前缀：申辩获批后按 `redline:<名称>` 记账，供 pipeline 红线层查询。 */
export const REDLINE_GRANT_PREFIX = 'redline:'

/** 取会话标识（与 audit.mjs 的 auditDeny 口径一致）。 */
function sessionOf(exec) {
  return (exec && (exec.sessionId || (exec.agent && (exec.agent.sessionId || exec.agent.id)))) || 'dsh-native'
}

/**
 * 查该红线是否已有"申辩获批"凭据（3.0.7）。
 * pipeline 红线层在上下文豁免判据之外追加查这一道。
 * @returns {Promise<boolean>}
 */
export async function hasRedlineGrant(exec, redlineName) {
  if (!redlineName) return false
  return grantsFor(sessionOf(exec)).has(`${REDLINE_GRANT_PREFIX}${redlineName}`)
}

/**
 * 申辩入口（3.0.7）：把 fg_appeal 的这次调用转成 `{kind:"ask"}`，交 DSH approval seam 由人类裁决。
 * 由 pipeline 在**所有闸之前**调用——申辩参数携带被拦命令原文，走后续闸会被同一规则再拦一次。
 * @returns {Promise<{kind:"ask", reason:string}|{kind:"deny", reason:string}|null>}
 */
export async function appealAsk(exec, warn) {
  const args = (exec && exec.arguments) || {}
  const target = String(args.tool ?? '').trim()
  const blocked = String(args.command ?? '')
  const counterExample = String(args.counterExample ?? '').trim()
  const reason = String(args.reason ?? '').trim()
  const session = sessionOf(exec)

  if (!target || !reason) {
    const msg = '申辩表单不完整：tool 与 reason 必填；建议附 counterExample 反例锚点（文件:行号 或原文引用）'
    auditEligibility({
      session,
      action: 'appeal-denied',
      tool: target || '(missing)',
      command: blocked.slice(0, 120),
      layer: 'appeal',
      decision: 'deny',
      modelSignal: null,
      evidence: msg,
    })
    if (typeof warn === 'function') warn('申辩表单不完整：', msg)
    return { kind: 'deny', reason: `focus-guard-native: ${msg}` }
  }

  auditEligibility({
    session,
    action: 'appeal-filed',
    tool: target,
    command: blocked.slice(0, 120),
    layer: 'appeal',
    decision: 'needApproval',
    modelSignal: null,
    evidence: `反例锚点：${counterExample.slice(0, 200) || '(未提供)'} | 理由：${reason.slice(0, 200)}`,
  })
  if (typeof warn === 'function') warn('申辩已提交人类裁决：', `${target} ${blocked.slice(0, 80)}`)

  return {
    kind: 'ask',
    reason:
      `focus-guard-native:【误判申辩】\n` +
      `工具：${target}\n` +
      `被拦命令：${blocked.slice(0, 200) || '(未提供)'}\n` +
      `反例锚点：${counterExample.slice(0, 300) || '(未提供)'}\n` +
      `理由：${reason.slice(0, 300)}\n\n` +
      `批准 → 为该工具开通一次授权（ttl=turn），并豁免本次命中的红线；拒绝 → 维持拦截。`,
  }
}

/**
 * 申辩获批后的授予（3.0.7）：由 fg_appeal 的执行体调用（人类批准后才轮到 execute 运行）。
 * 同时记"工具授权"与"红线凭据"，使原被拦命令的下次调用能过红线层与资格闸。
 */
export async function grantFromAppeal({ session, tool, command = '' } = {}) {
  const grants = grantsFor(session)
  const entry = grants.grant(String(tool), {
    ttl: 'turn',
    reason: `申辩获批：${String(command).slice(0, 80)}`,
  })
  let redline = null
  try {
    // 路径相对本文件（src/adapters/dsh/）：上溯两级到 src/，再进 dsh/
    const { ABSOLUTE_REDLINES } = await import('../../core/redlines.mjs')
    const hit = (ABSOLUTE_REDLINES || []).find((r) => r && r.re && r.re.test(String(command)))
    if (hit) {
      grants.grant(`${REDLINE_GRANT_PREFIX}${hit.name}`, { ttl: 'turn', reason: '申辩获批红线豁免' })
      redline = hit.name
    }
  } catch (error) {
    // 不静默：红线凭据拿不到时工具授权仍生效，但必须留痕（对齐 2.5.1「假留痕防线」）
    console.warn(
      '[focus-guard-native] 申辩红线凭据授予失败（工具授权仍生效）:',
      (error && error.message) || error,
    )
    redline = null
  }
  auditEligibility({
    session,
    action: 'appeal-granted',
    tool,
    command: String(command).slice(0, 120),
    layer: 'appeal',
    decision: 'allow',
    modelSignal: null,
    evidence: `获批授权 ttl=${entry.ttl}${redline ? `；红线豁免：${redline}` : ''}`,
  })
  return { entry, redline }
}

/** fg_appeal 的工具注册规格（与 fg_apply 同构；执行体只在人类批准后运行）。 */
export const FG_APPEAL_TOOL_SPEC = {
  name: 'fg_appeal',
  description:
    '对被 FocusGuard 拦截的命令提出【误判申辩】。仅当认为拦截属误伤时使用（例如被引用的危险命令字符串被当成了要执行的命令）。须给出 reason，并尽量附 counterExample 反例锚点（文件:行号 或原文引用）。提交后由人类一次性裁决：批准则开通该工具一次授权并豁免对应红线，拒绝则维持拦截。',
  parameters: {
    tool: { type: 'string', required: true, description: '被拦的工具名，如 Bash / Write' },
    command: { type: 'string', required: true, description: '被拦的命令或操作原文' },
    reason: { type: 'string', required: true, description: '申辩理由（必填，不得空白）' },
    counterExample: {
      type: 'string',
      required: false,
      description: '反例锚点：证明该片段只是数据的证据，如 文件:行号 或原文引用',
    },
  },
}
