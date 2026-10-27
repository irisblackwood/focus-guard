/**
 * 工具/路径/命令的基础取形（2026-10-27 从 pipeline.mjs 抽出，纯搬运）。
 *
 * 这里只回答"这是什么工具、目标是什么文件、命令文本是什么"，不做任何判定。
 * 判定在 evidence / redline / hardCheck / volume / authz / risk 各自模块里。
 */
import { statSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { isReadOnlyCall } from '../../core/risk.mjs'

/** 提取命令类参数；非命令类工具（write/read 等）返回 null，不做检查 */
export function commandOf(exec) {
  const args = exec && exec.arguments
  if (!args || typeof args !== 'object') return null
  const cmd = args.command ?? args.cmd ?? args.script
  return typeof cmd === 'string' ? cmd : null
}

/** 会话工作目录：与 seams.mjs:63 projDirOf / preGuard / postProgress / stopGuard 同源（session.header.cwd）。 */
export function cwdOf(exec) {
  const a = exec && exec.agent
  return (a && a.session && a.session.header && a.session.header.cwd) || undefined
}

/**
 * 把工具参数里的路径解析成绝对路径（2026-10-19 修：真实会话均传相对路径）。
 *
 * 病根：整文件闸 / 取证闸 / 体积闸此前直接拿 `pathOfTool(args)` 去 statSync / existsSync，
 * 相对路径按**宿主进程 cwd** 解析；而 DSH 会话的 cwd 在 `agent.session.header.cwd`。
 * 两者不一致时 statSync 抛 ENOENT → 闸无声跳过（fail-open），表现为"整读 1022 行不拦"。
 * 实测证据：session-002c143b 的 `read {file_path:"packages/core/src/dsh/pipeline.mjs"}` 直通。
 */
export function resolveToolPath(rawPath, exec) {
  const p = String(rawPath ?? '').trim()
  if (!p) return null
  if (isAbsolute(p)) return p
  const base = cwdOf(exec)
  return base ? join(base, p) : p
}

/**
 * 取证键归一化（2026-10-19 修 BUG）：**绝对化 + 统一正斜杠**。
 *
 * 病根（实测复现见 tests/evidence-relative-path.test.mjs）：读记录侧存的是宿主给的原始路径，
 * 查证侧存的是 `resolveToolPath` 后的绝对路径（`join(cwd, rel)`，Windows 带反斜杠）——
 * 同一文件两种写法 → 查不到 → 判"未读" → 靠 evidenceBlockedOnce 的「拒一次」逃生阀放行。
 * 表现就是"明明读过，首次改还是被拦一次"。这不是设计语义，是键没归一化。
 */
export function evidenceKeyOf(rawPath, exec) {
  const resolved = resolveToolPath(rawPath, exec)
  return resolved ? String(resolved).replace(/\\/g, '/') : null
}

/** 两个取证键是否指同一文件（已归一化：正斜杠；Windows 下大小写不敏感）。 */
export function sameEvidenceKey(a, b) {
  const x = String(a).replace(/\\/g, '/')
  const y = String(b).replace(/\\/g, '/')
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

export function isDirPath(absPath) {
  try {
    return Boolean(absPath) && statSync(absPath).isDirectory()
  } catch {
    return false
  }
}

export const pathOfTool = (args) => {
  const a = args || {}
  // MCP 写盘工具（如 cities2 的 write_project_file）用 {project_dir, relative_path}，
  // 2026-10-22 补：能拼出绝对路径就拼，拼不出返回 null（由"改动类无路径"分支兜底）。
  if (!a.file_path && !a.path && !a.target && !a.targetPath && !a.dest && a.relative_path) {
    const base = a.project_dir || a.root || ''
    return join(String(base), String(a.relative_path))
  }
  return a.file_path || a.path || a.target || a.targetPath || a.dest || null
}

/** 本会话身份：与 audit / grant 口径一致（真实 id 在 agent.session.header.id，见桥 lib/index.js:349）。 */
export function sessionIdOf(exec) {
  // ⚠ 2026-10-10 实测修正：原实现只认 exec.sessionId / agent.sessionId / agent.id，三者皆空 →
  // 全部退化成 'dsh-native'，导致**所有会话共用一份状态文件**（真实 AUDIT.log 里 439 条记在
  // dsh-native 名下）。真实会话 id 形如 sess_<uuid>，位于 agent.session.header.id。
  return (
    (exec &&
      ((exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.id) ||
        exec.sessionId ||
        (exec.agent && (exec.agent.sessionId || exec.agent.id)))) ||
    'dsh-native'
  )
}

const MUTATING_TOOL = /^(?:Write|Edit|MultiEdit|Delete|Move|Patch|ApplyPatch|NotebookEdit)$/i
export const READ_TOOL = /^(?:Read|Grep|Glob|read_image|NotebookRead)$/i
export const SHELL_TOOL = /^(?:Bash|Shell|sh|pwsh|powershell|cmd|Terminal|RunCommand)$/i

// 改动类工具分类（2026-10-22 补口）：
// 病根：取证闸 / 授权闸 / 批量待批全靠 MUTATING_TOOL 一个正则，而它只认 8 个名字。
// 真实目录里还有一批**会写盘 / 装包 / 跑构建**的工具完全不匹配：
//   `mcp__cities2-mcp__write_project_file`（写项目文件）、`build_project` / `package_project`（跑构建、打包）、
//   `plugin_manager`（装删插件，会执行 npm 构建脚本）、`move_run`（写 AGENTS.md、拷技能）、
//   `import_claude` / `claude_export`（写会话文件）。
// 判据取"动词前缀 + 显式清单"，宁可窄也不扩成 `.test(/write/)` 那种宽匹配（`write_project_file` 是写、
// `read_project_file` 不是，靠前缀区分已经够用）。
const MUTATING_TOOL_NAMED = /^(?:plugin_manager|move_run|import_claude|claude_export)$/i
const MUTATING_MCP_TOOL =
  /^mcp__[\s\S]+?__(?:write|create|update|delete|remove|move|copy|patch|apply|edit|save|install|uninstall|build|package|scaffold|deploy|upload|publish)_/i

/** 是否为改动类工具（写盘 / 装包 / 构建等有副作用的调用）。 */
export function isMutatingTool(toolName) {
  const t = String(toolName || '')
  return MUTATING_TOOL.test(t) || MUTATING_TOOL_NAMED.test(t) || MUTATING_MCP_TOOL.test(t)
}

/**
 * 本次调用的改动判定（工具名 + 参数级动作，2026-10-27）。
 * 只读动作（适配层登记，如 `plugin_manager` 的 list_*）不算改动——
 * 否则"只读列举"会落进取证闸的"改动类无路径"分支被直接挡死。
 */
export function isMutatingInvocation(toolName, args) {
  return isMutatingTool(toolName) && !isReadOnlyCall(toolName, args)
}

/**
 * 从 shell 命令里提取"会被写的已存在文件"的目标路径（2026-10-18 补口）。
 *
 * 起因：A/B 会话对照实测——B 组第 2 条要求"不读就改 README.md"，代理用 `pwsh Add-Content`
 * 而不是 Edit 工具，取证闸只管 MUTATING_TOOL，于是**盲改被放行**。shell 重定向是等效写操作，
 * 必须纳入同一判据，否则取证闸一行 `echo >>` 就能绕过。
 *
 * 只认显式写目标，宁可漏也不扩大误伤面：
 *   PowerShell：`>` / `>>` / `Set-Content [-Path] X` / `Add-Content [-Path] X` / `Out-File X` / `Tee-Object X`
 *   POSIX：`>` / `>>` / `tee X` / `sed -i … X` / `perl -pi … X`
 * 返回绝对/相对路径数组（去重、去掉引号与变量占位）。
 */
export function shellWriteTargets(cmd) {
  const c = String(cmd || '')
  if (!c) return []
  const out = new Set()
  const push = (raw) => {
    if (!raw) return
    const p = String(raw).trim().replace(/^["']|["']$/g, '')
    if (!p || p.startsWith('$') || p.startsWith('%') || p === '/' || /^[A-Za-z]:$/.test(p)) return
    if (/^(\/dev\/null|NUL)$/i.test(p)) return
    out.add(p)
  }
  // 重定向：> file / >> file（排除 2>&1 这类句柄复制）
  for (const m of c.matchAll(/(?<![0-9])\>{1,2}\s*("([^"]+)"|'([^']+)'|([^\s;&|）]+))/g)) {
    push(m[2] || m[3] || m[4])
  }
  // PowerShell cmdlet
  for (const m of c.matchAll(/\b(?:Set-Content|Add-Content|Out-File|Tee-Object)\b[^;|&]*?(?:-\w+\s+)*("([^"]+)"|'([^']+)'|([A-Za-z]:[\\/][^\s;"']+|[^\s;&|]+))/gi)) {
    const candidate = m[2] || m[3] || m[4]
    // 跳过 -Path 之类参数名本身
    if (candidate && !candidate.startsWith('-')) push(candidate)
  }
  // tee / sed -i / perl -pi
  for (const m of c.matchAll(/\btee\b(?:\s+-\w+)*\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))/gi)) push(m[2] || m[3] || m[4])
  for (const m of c.matchAll(/\b(?:sed|perl)\b[^\n;|&]*?\s(?:-i\S*|-pi\S*)\b[^\n;|&]*?\s("([^"]+)"|'([^']+)'|([^\s;&|]+))\s*$/gim)) {
    push(m[2] || m[3] || m[4])
  }
  return [...out]
}

/**
 * 从 exec 提取模型标识（最后一公里）。
 * 取值顺序与 postExecuteListener 的成本行模型同源（exec.agent.model / modelId / exec.model），
 * 另加 FG_MODEL_ID 作显式兜底。取不到时返回 null → 画像为 null → 闸按最严 mutating（安全默认）。
 */
export function modelIdOf(exec) {
  return (
    (exec && ((exec.agent && (exec.agent.model || exec.agent.modelId)) || exec.model)) ||
    process.env.FG_MODEL_ID ||
    null
  )
}
