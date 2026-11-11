/**
 * focus-guard · 申请/申辩工具注册（2026-10-18 补洞）
 *
 * 背景：资格闸会拦高危操作（`npm publish` 之类），但 `fg_apply` / `fg_appeal` 两个工具
 * **从未接进装配层**——被拦后模型无路可走，只能让人绕过 DSH。本文件补这条通道。
 *
 * 为什么自己构造而不复用早期版本（`adapters/dsh/fg-apply-tool.mjs` 已于 2026-10-25 删除）：
 *   ① `@deepseek-ai/dsh-tools` 在 FG 安装目录下不可解析（peerDependency 未随包安装）；
 *   ② 早期那两个文件调 `defineTool` 时没传 `output`，而 defineTool 会读 `options.output.render`
 *      → 一导入就抛，说明它们从未被真正执行过（本次才第一次接线）。
 * 故按宿主 register 的既证形状直接构造：`{ name, description, parameters(JSON Schema),
 * output: { schema, render }, execute }`——与 dsh-memory 的 state_checkpoint 同构。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyEligibility, grantFromAppeal, FG_APPLY_TOOL_SPEC, FG_APPEAL_TOOL_SPEC } from '../adapters/dsh/eligibility-gate.mjs'
import { ABSOLUTE_REDLINES } from '../core/redlines.mjs'
import { livenessBadge } from './heartbeat.mjs'

/** 简化参数表（{type,required,description,enum}）→ JSON Schema。 */
function specToJsonSchema(spec = {}) {
  const properties = {}
  const required = []
  for (const [key, def] of Object.entries(spec)) {
    const prop = { type: def.type || 'string' }
    if (def.description) prop.description = def.description
    if (Array.isArray(def.enum)) prop.enum = def.enum
    properties[key] = prop
    if (def.required === true) required.push(key)
  }
  return { type: 'object', additionalProperties: false, properties, required }
}

/** 工具输出形状：lossless JSON 对象 + 文本渲染。 */
const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
}

function sessionOf(exec) {
  return (exec && (exec.sessionId || (exec.agent && (exec.agent.sessionId || exec.agent.id)))) || 'dsh-native'
}

function renderApply(result, spec) {
  const layers = (result.trace || []).map((s) => `L${s.layer}:${s.decision}`).join(' → ')
  if (result.decision === 'allow') {
    return `[资格审核·通过] ${spec.tool} 已获授权（ttl=${spec.ttl ?? 'turn'}）。理由：${result.reason}\n层序：${layers}\n现在可以执行：${String(spec.command ?? '').slice(0, 120)}`
  }
  if (result.decision === 'needApproval') {
    return `[资格审核·需人类审批] ${result.reason}\n层序：${layers}\n请向人类说明目的与影响范围后再执行；未经批准不得执行。`
  }
  return `[资格审核·拒绝] ${result.reason}\n层序：${layers}\n不得执行该命令；如需继续，先修正申请（目的/影响范围）或改用合规替代方案。`
}

/** 构造 fg_apply 工具定义。 */
export function buildApplyTool() {
  return {
    name: FG_APPLY_TOOL_SPEC.name,
    description: FG_APPLY_TOOL_SPEC.description,
    parameters: specToJsonSchema(FG_APPLY_TOOL_SPEC.parameters),
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const spec = {
        tool: args.tool,
        command: args.command ?? '',
        purpose: args.purpose,
        scope: args.scope,
        ttl: args.ttl ?? 'turn',
        target: args.target,
      }
      const result = await applyEligibility({ session: sessionOf(exec), ...spec, redlines: ABSOLUTE_REDLINES, model: null })
      // 按需自证（2026-10-19）：fg_apply 是第二个局部点——申请/审核结果里附带一次存活徽标。
      return { decision: result.decision, text: `${renderApply(result, spec)}\n${livenessBadge()}` }
    },
  }
}

/**
 * 构造 fg_env 工具定义（2026-11-09）。
 *
 * 为什么需要这个工具：环境档案是**探测**出来的，而探测只看得到 PATH 与 `--version`。
 * 它看不出「这个 pwsh7 是 scoop 装的」「bash 其实是 WSL」「grep 3.0 的 -P 有坑」——
 * 这些只有模型（或人类）在真用过之后才知道。工具给一条**写回**的通道，探测与经验互补。
 *
 * 不传 note 就是只读查询：模型可以随时确认"这台机器到底有什么"，不必靠猜。
 */
/** fg_env 的执行体（抽出来是为了不让 buildEnvTool 的嵌套超阈值）。 */
async function runEnvArchive(args = {}, exec) {
  const projDir =
    (exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) ||
    process.env.FG_PROJECT_DIR ||
    process.cwd()
  const fp = join(projDir, '.ai', 'env-fingerprint.json')
  let data
  try {
    data = JSON.parse(readFileSync(fp, 'utf8'))
  } catch {
    return { text: `[环境档案] 尚未生成：${fp}\n会话启动会自动探测（后台）；也可手动跑 packages/core/tools/env-fingerprint.mjs` }
  }
  const note = String(args.note || '').trim()
  if (note) {
    data.notes = Array.isArray(data.notes) ? data.notes : []
    data.notes.push({ at: new Date().toISOString(), by: 'model', text: note.slice(0, 500) })
    try {
      writeFileSync(fp, JSON.stringify(data, null, 2) + '\n')
    } catch (error) {
      return { text: `[环境档案] 反馈写入失败（不阻塞）：${(error && error.message) || error}` }
    }
  }
  const shells = (data.shells || [])
    .map((s) => `${s.id}(${s.origin === 'builtin' ? '自带' : '额外'})`)
    .join(' ')
  const cmds = Object.entries(data.commands || {})
    .map(([k, v]) => `${k}=${v.impl}${v.version ? ' ' + v.version : ''}`)
    .join(' / ')
  const probe = data.probe || {}
  const lines = [
    `[环境档案] 机器 ${data.machine?.id || '?'} · ${data.machine?.host || '?'} · ${data.platform?.osLabel || data.platform?.os || '?'}`,
    `执行体 ${data.platform?.shell || '?'}（来源 ${data.platform?.shellSource || '?'}）/ 可用 ${shells || '-'}`,
    `命令语法 ${cmds || '-'}`,
    `探测 ${probe.at || '-'} · 下次重探 ${probe.nextAt || '-'}（${Math.round((probe.ttlMs || 0) / 3600e3)}h，连续未变 ${probe.streak ?? '-'} 次）`,
  ]
  const notes = Array.isArray(data.notes) ? data.notes : []
  if (notes.length) {
    lines.push(`反馈 ${notes.length} 条：`)
    for (const n of notes.slice(-5)) lines.push(`  · ${n.text}`)
  }
  if (note) lines.push(`已记录反馈：${note.slice(0, 120)}`)
  return { text: lines.join('\n') }
}

export function buildEnvTool() {
  return {
    name: 'fg_env',
    description:
      '查看本机环境档案（机器编号 / 操作系统 / 可用终端 / 命令语法新旧 / 探测 TTL），或回填一条补充说明。' +
      '探测只能看到 PATH 与版本号，看不到「这个终端是谁装的」「某个命令在本机有特殊行为」——这些用 note 写回来。',
    parameters: specToJsonSchema({
      note: {
        type: 'string',
        description: '本机环境的补充说明，例如「pwsh7 是 scoop 装的，非系统自带」「bash 实为 WSL」「grep 3.0 不支持 -P 的某些写法」',
      },
    }),
    output: TEXT_OUTPUT,
    execute: runEnvArchive,
  }
}

/** 构造 fg_appeal 工具定义。 */
function buildAppealTool() {
  return {
    name: FG_APPEAL_TOOL_SPEC.name,
    description: FG_APPEAL_TOOL_SPEC.description,
    parameters: specToJsonSchema(FG_APPEAL_TOOL_SPEC.parameters),
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const { entry, redline } = await grantFromAppeal({
        session: sessionOf(exec),
        tool: args.tool,
        command: args.command ?? '',
      })
      const text =
        `[申辩获批] ${args.tool} 已开通一次授权（ttl=${entry.ttl}）` +
        (redline ? `，并豁免红线「${redline}」。` : '。') +
        '\n现在可以执行原被拦命令；如需更多次数请重新申请。'
      return { decision: 'allow', text }
    },
  }
}

/**
 * 注册两个通道工具。任一失败只降级该工具，不影响执法缝。
 * @returns {string[]} 实际注册成功的工具名
 */
export function registerGateTools(ctx, { warn } = {}) {
  const done = []
  for (const [label, build] of [
    ['fg_apply', buildApplyTool],
    ['fg_appeal', buildAppealTool],
    ['fg_env', buildEnvTool],
  ]) {
    try {
      ctx.tools.register(build())
      done.push(label)
    } catch (error) {
      warn?.(`${label} 注册失败（申请/申辩通道不可用）：`, (error && error.message) || error)
    }
  }
  return done
}
