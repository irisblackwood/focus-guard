/**
 * focus-guard 原生插件 · 三缝流水线（3.0.5）
 *
 * ① tools/pre-execute：rm -rf 族拦截 + 审计留痕；
 * ② system-prompt/assemble：峰谷成本提示行注入；
 * ③ tools/post-execute：token 用量折算 → 成本台账落卷（只观测，不改决策）。
 *
 * 各缝独立 fail-open：判定/注入/核算异常一律放行或原样透传，绝不阻塞 DSH 主流程。
 * 缝契约证据（本机 DSH Desktop 0.2.0-rc.2 装机源码）：
 *   - dsh-tools/lib/index.js:3225  pre-execute 瀑布 fallback {kind:"allow"}，gate.kind==="ask" 走审批；
 *   - dsh-hooks-claude-code/lib/index.js:255-258  deny 形状 {kind:"deny", reason}；
 *   - dsh-tools/lib/index.js:3504  post-execute 三参瀑布 (exec, result, next)。
 */
import { auditDeny, appendCostRow, auditRedlineExempt } from './audit.mjs'
import { redlineExempt, MUTATOR_HEAD_RE, isMutatingBashCmd } from '../core/redlines.mjs'
import { loadProfile } from '../core/profileLoader.mjs'
import { OUTPUT_GATE_BYTES, RISKY_FILE_RE } from '../core/constants.mjs'
// 2026-10-22：体积闸判定内核下沉到母版，两条适配路径共用同一套判据（参数提取各自做）。
import { judgeReadGate, judgeGrepGate, judgeCatGate } from '../core/outputGate.mjs'
// ⚠ 必须用别名：preExecuteListener 的参数名就叫 statePath（自检注入用），
// 直接 import 同名函数会被参数遮蔽 → 函数体内 statePath === undefined → "is not a function"，
// 而且被 try/catch 的 fail-open 吞成静默放行（2026-10-09 实测踩过）。
import { statePath as guardStateFile, loadState, saveState } from '../core/state.mjs'
import { isPeakAt, isSaveStreamEnabled } from '../peak-cost.mjs'
import { statSync, readFileSync, readdirSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

/** 每次改动本文件递增；用于磁盘/内存版本一致性提示 */
const PIPELINE_VERSION = '3.0.9-m1'

/**
 * 运行实例的"内存版本时间戳"：模块加载（DSH 启动）时采一次。
 * FG 是 link 挂载，启动后改磁盘不会重新加载 —— 与磁盘 mtime 比对即可发现"跑旧代码"。
 */
const MEM_PIPELINE_MTIME = (() => {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtimeMs
  } catch {
    return null
  }
})()

let diskVersionWarned = false

/** 单次检查：磁盘与内存不一致 → 警告一次（warn 只写日志，不抛错、不阻塞） */
function warnIfStaleOnce(warn) {
  if (diskVersionWarned || MEM_PIPELINE_MTIME === null) return false
  try {
    const diskMtime = statSync(fileURLToPath(import.meta.url)).mtimeMs
    if (diskMtime === MEM_PIPELINE_MTIME) return false
    diskVersionWarned = true
    warn(
      `[focus-guard] 磁盘代码已更新（${PIPELINE_VERSION}，磁盘 mtime=${diskMtime} ≠ 内存 mtime=${MEM_PIPELINE_MTIME}），当前运行实例为旧版，请重启 DSH`,
    )
    return true
  } catch (error) {
    warn('版本一致性检查失败（不阻塞）:', (error && error.message) || error)
    return false
  }
}

export const PIPELINE_VERSION_INFO = { version: PIPELINE_VERSION, memoryMtime: MEM_PIPELINE_MTIME }

/** 供自检/诊断调用：返回本次是否检出磁盘更新 */
export function checkDiskVersion(warn = console.warn) {
  return warnIfStaleOnce(warn)
}

/** rm 后跟单簇旗标且同时含 r 与 f（任意顺序）：rm -rf / rm -fr / rm -Rdf …（第 1 层·普通档，模糊命令） */
const RM_RF = /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*(?:r\w*f|f\w*r)\w*\b/

// ── 第 1 层·绝对红线（零延迟短路 deny，不进第 2 层）──
// 2026-10-18：红线表下沉到 src/core/redlines.mjs —— 适配层资格闸要用它，
// 而适配层不能反向依赖宿主缝。此处保留 re-export，避免打断既有引用面。
import { ABSOLUTE_REDLINES } from "../core/redlines.mjs"
export { ABSOLUTE_REDLINES }

/** 命中哪条绝对红线；未命中返回 null */
export function redlineOf(cmd) {
  if (!cmd) return null
  return ABSOLUTE_REDLINES.find((r) => r.re.test(cmd)) || null
}

/** 提取命令类参数；非命令类工具（write/read 等）返回 null，不做检查 */
/**
 * 把工具参数里的路径解析成绝对路径（2026-10-19 修：真实会话均传相对路径）。
 *
 * 病根：整文件闸 / 取证闸 / 体积闸此前直接拿 `pathOfTool(args)` 去 statSync / existsSync，
 * 相对路径按**宿主进程 cwd** 解析；而 DSH 会话的 cwd 在 `agent.session.header.cwd`。
 * 两者不一致时 statSync 抛 ENOENT → 闸无声跳过（fail-open），表现为"整读 1022 行不拦"。
 * 实测证据：session-002c143b 的 `read {file_path:"packages/core/src/dsh/pipeline.mjs"}` 直通。
 */
function resolveToolPath(rawPath, exec) {
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
function evidenceKeyOf(rawPath, exec) {
  const resolved = resolveToolPath(rawPath, exec)
  return resolved ? String(resolved).replace(/\\/g, '/') : null
}

/** 两个取证键是否指同一文件（已归一化：正斜杠；Windows 下大小写不敏感）。 */
function sameEvidenceKey(a, b) {
  const x = String(a).replace(/\\/g, '/')
  const y = String(b).replace(/\\/g, '/')
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
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

function isDirPath(absPath) {  try {
    return Boolean(absPath) && statSync(absPath).isDirectory()
  } catch {
    return false
  }
}

function commandOf(exec) {
  const args = exec && exec.arguments
  if (!args || typeof args !== 'object') return null
  const cmd = args.command ?? args.cmd ?? args.script
  return typeof cmd === 'string' ? cmd : null
}

/** 成本提示行（≤30 字；省流开启时追加后缀） */
function promptCostLine() {
  let base
  try {
    base = isPeakAt(new Date()).inPeak
      ? '【成本】高峰时段，建议压缩输出。'
      : '【成本】低谷时段，可放心输出。'
  } catch {
    base = '【成本】低谷时段，可放心输出。'
  }
  try {
    return isSaveStreamEnabled() ? base + '（主动省流已开）' : base
  } catch {
    return base
  }
}

/** 兼容多家常字段名的用量提取；无用量返回 null */
function usageOf(u) {
  if (!u || typeof u !== 'object') return null
  const usage = {
    input: u.input ?? u.input_tokens ?? u.prompt_tokens,
    cacheRead: u.cacheRead ?? u.cache_read_input_tokens ?? u.prompt_cache_hit_tokens,
    output: u.output ?? u.output_tokens ?? u.completion_tokens,
  }
  return usage.input || usage.output ? usage : null
}

// ── 第 2 层：语义预判（接口可插拔；M3 换成 Needle 2 实现）──
export const RISK_ASK_THRESHOLD = 0.85

const clampRisk = (n) => Math.min(0.99, Math.max(0, Number(n) || 0))

const HEURISTIC_RULES = [
  { re: /\|\s*(?:sh|bash|zsh|cmd|powershell|pwsh)\b/i, cat: 'pipe_to_shell', w: 0.55 },
  // 重定向 0.3 → 0.15（2026-10-18）：`>` 本身不是破坏性动作，它只是"会写文件"。
  // 旧权重下 Remove-Item(0.6) + 一条重定向就 0.9 越线，把"清 TEMP + 存日志"这种常规脚本判成高危。
  { re: /[>]{1,2}\s*\S/, cat: 'redirect', w: 0.15 },
  { re: /\b(?:child_process|execSync|spawnSync|subprocess|os\.system)\b/, cat: 'subprocess', w: 0.5 },
  { re: RM_RF, cat: 'fs_mutation', w: 0.3 },
  { re: /\b(?:mv|dd|truncate)\s/, cat: 'fs_mutation', w: 0.3 },
  { re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+\.)/, cat: 'history_overwrite', w: 0.6 },
]

// ── 破坏性 API：按目标分级（2026-10-18 修）──
// 旧实现只看动词，权重恒 0.6：清 TEMP 单文件与递归删系统目录同分，而且 +重定向就误伤。
// 现在按"打哪里"给权：系统路径/递归 → 0.9（必拦）；TEMP → 0.2（不拦）；其余 → 0.4。
const DESTRUCTIVE_API = /\b(?:shutil\.rmtree|fs\.rmSync|Remove-Item)\b/i
const SYSTEM_PATH =
  /(?:[A-Za-z]:\\(?:Windows|Program Files|ProgramData)|(?:^|[\s"'=])\/(?:usr|etc|bin|sbin|var|lib|boot|sys|proc|opt|root)(?:\/|$))/i
const RECURSIVE_FLAG = /-Recurse\b|\brmdirSync\s*\(|recursive\s*:\s*true/i
const TEMP_TARGET = /\$(?:env:)?TEMP\b|%TEMP%|\\Temp\\|\/tmp\//i

function destructiveApiWeight(cmd) {
  const text = String(cmd ?? '')
  if (!DESTRUCTIVE_API.test(text)) return 0
  if (/shutil\.rmtree/i.test(text)) return 0.9 // rmtree 天生递归
  if (SYSTEM_PATH.test(text) || RECURSIVE_FLAG.test(text)) return 0.9
  if (TEMP_TARGET.test(text)) return 0.2
  return 0.4 // 未知目标：中间档，不拦但会进审批视野
}

/**
 * 启发式兜底实现。
 * @returns {{risk:number, category:string, reasons:string[]}}
 */
export function riskOfHeuristic(cmd, tool) {
  const text = cmd ?? ''
  const hits = HEURISTIC_RULES.filter((r) => r.re.test(text)).map((r) => ({ cat: r.cat, w: r.w }))
  const destructive = destructiveApiWeight(text)
  if (destructive > 0) hits.push({ cat: 'destructive_api', w: destructive })
  return {
    risk: clampRisk(hits.reduce((a, h) => a + h.w, 0)),
    category: hits.slice().sort((a, b) => b.w - a.w)[0]?.cat || 'benign',
    reasons: hits.map((h) => h.cat),
  }
}

/** 成本台账停摆检测（2026-10-18）：连续多少条工具结果拿不到 usage 就告警一次。 */
const COST_MISS_WARN_AT = 5
let costMissStreak = 0

/** 审批单形状（对齐 dsh-tools/lib/index.js:3439-3458：reason 必填，displayReason 可选） */
function buildAsk(cmd, risk, category, extra) {
  return {
    kind: 'ask',
    reason: `focus-guard-native 第2层语义预判：risk=${risk} category=${category} 命令=${String(cmd).slice(0, 120)}`,
    displayReason: `高危但可审批（${category}，risk ${risk}）${extra ? ' — ' + extra : ''}`,
  }
}

// ── 第 2 层·真哨兵接线（观察模式）──
export const SENTINEL_PY = fileURLToPath(new URL('./sentinel.py', import.meta.url))
export const SENTINEL_TIMEOUT_MS = 1500 // 实测 Needle 冷启 0.30s / 单次 0.13-0.42s → 取 ~5x 余量
export const SENTINEL_PYTHON = process.env.FG_PYTHON || 'python'
export const OBSERVE_UNTIL_JUDGEMENTS = 50 // 观察模式：累计 50 次真实判定后才允许启用 ask

const OBSERVATION = { effective: false, judgements: 0, highRisk: 0 }
let observeNoticeEmitted = false

/** 观察模式状态（自检/汇报用只读快照） */
export function observeState() {
  return { ...OBSERVATION }
}

/**
 * sentinel.py 的 Node 侧接线：execFileSync 调子进程，超时/异常/解析失败一律抛错，
 * 由 preExecuteListener 的 catch 转成保守 ask（不静默放行）。
 * HF_HOME 只注入子进程 env，不写全局。
 *
 * 2026-10-18 加**结论缓存**：判定基准实测每条 Bash 命令都要付 ~60ms 的 python 冷启动，
 * 而同一命令在会话里会反复出现（重试、复测、同一脚本多轮）。按命令内容哈希缓存**成功结论**，
 * 失败（超时/缺 python/解析失败）一律不缓存——下次仍要重试，不能把错误固化成结论。
 * `FG_SENTINEL_CACHE=0` 关闭；`FG_SENTINEL_CACHE_SIZE` 调容量（默认 500，LRU）。
 */
const SENTINEL_CACHE_OFF = process.env.FG_SENTINEL_CACHE === '0'
const SENTINEL_CACHE_LIMIT = Number(process.env.FG_SENTINEL_CACHE_SIZE) || 500
const sentinelCache = new Map()

/** 缓存命中/未命中计数（自检与基准用只读快照）。 */
export const sentinelCacheStats = { hits: 0, misses: 0 }

/** 测试钩子：清空缓存与计数。 */
export function resetSentinelCache() {
  sentinelCache.clear()
  sentinelCacheStats.hits = 0
  sentinelCacheStats.misses = 0
}

function runSentinel(cmd) {
  const out = execFileSync(SENTINEL_PYTHON, [SENTINEL_PY, '--cmd', String(cmd ?? '')], {
    encoding: 'utf8',
    timeout: SENTINEL_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, HF_HOME: process.env.HF_HOME || 'E:\\venvs\\hf-cache', FG_SENTINEL_CALLER: 'focus-guard' },
  })
  const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop()
  if (!line) throw new Error('sentinel 无输出')
  const verdict = JSON.parse(line)
  if (!verdict || typeof verdict !== 'object') throw new Error('sentinel 输出非对象')
  return verdict
}

export function riskOfSentinel(cmd) {
  if (SENTINEL_CACHE_OFF) return runSentinel(cmd)
  const key = String(cmd ?? '')
  const hit = sentinelCache.get(key)
  if (hit !== undefined) {
    sentinelCacheStats.hits += 1
    // LRU：命中后移到队尾（Map 保持插入序）
    sentinelCache.delete(key)
    sentinelCache.set(key, hit)
    return hit
  }
  sentinelCacheStats.misses += 1
  const verdict = runSentinel(cmd)
  sentinelCache.set(key, verdict)
  while (sentinelCache.size > SENTINEL_CACHE_LIMIT) {
    const oldest = sentinelCache.keys().next().value
    sentinelCache.delete(oldest)
  }
  return verdict
}
// ── 第 3 层：状态校验（单向读 guard.mjs 权威状态，本插件只读不写）──
// 权威落盘点（实测 guard.mjs:255-268, 372-395）：
//   会话状态 → os.tmpdir()/focus-guard-<会话id>.json，字段 fused / forcedInvestigate / probation / readSet
//   执法留痕 → <工作区>/.focus-guard/AUDIT.log（guard.mjs:19；工作区由 ZCODE_PROJECT_DIR/CLAUDE_PROJECT_DIR 定，缺省 tmpdir）
//   取证记录 → <工作区>/.ai/CASE_FILE.md 的【三】（guard.mjs 写；原生插件另有记账类【五】）
// 注意：任务书写的「熔断状态在 packages/core/.focus-guard/」不准确——该目录只有 AUDIT.log；
// 熔断标志实际落在 os.tmpdir() 的会话状态文件里。
export const STATE_GATE = { effective: true }
export const EVIDENCE_GATE = { effective: process.env.FG_EVIDENCE_GATE !== '0' }
export const GUARD_STATE_MAX_AGE_MS = 60 * 60 * 1000

const MUTATING_TOOL = /^(?:Write|Edit|MultiEdit|Delete|Move|Patch|ApplyPatch|NotebookEdit)$/i
const READ_TOOL = /^(?:Read|Grep|Glob|read_image|NotebookRead)$/i
const SHELL_TOOL = /^(?:Bash|Shell|sh|pwsh|powershell|cmd|Terminal|RunCommand)$/i

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
function shellWriteTargets(cmd) {
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

const pathOfTool = (args) => {
  const a = args || {}
  // MCP 写盘工具（如 cities2 的 write_project_file）用 {project_dir, relative_path}，
  // 2026-10-22 补：能拼出绝对路径就拼，拼不出返回 null（由"改动类无路径"分支兜底）。
  if (!a.file_path && !a.path && !a.target && !a.targetPath && !a.dest && a.relative_path) {
    const base = a.project_dir || a.root || ''
    return join(String(base), String(a.relative_path))
  }
  return a.file_path || a.path || a.target || a.targetPath || a.dest || null
}

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
 * 记录本会话内已读过的文件（第 3 层取证判定的原生侧证据）。
 *
 * 3.0.8（孤儿机制审计）：除内存 Set 外**同时落盘**到本会话状态文件。
 * 为什么必须落盘：内存 Set 随模块重载（HMR）与进程重启清零，而 DSH 侧此前**没有 state 写入者**
 * （唯一的写者 guard.mjs 在 DSH 下未挂载）——于是取证记录会凭空消失，表现为"明明读过却被判未取证"。
 * 这是"原生插件自持状态"的第一处写权；KPI / 预算池等机制后续也依赖它。
 * 仅在**新增**记录时落盘，避免每次 Read 都写一次盘。
 */
function rememberReads(exec) {
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

/** 第 3 层判定：返回 deny 决策或 null（放行到下游）；读失败一律 fail-open + warn */
/** 本会话身份：与 audit / grant 口径一致（真实 id 在 agent.session.header.id，见桥 lib/index.js:349）。 */
function sessionIdOf(exec) {
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

function layer3Check(exec, warn, statePathOverride) {
  const tool = String((exec && exec.name) || '')
  const isMutating = isMutatingTool(tool)
  // 2026-10-18 补口：shell 重定向/写 cmdlet 与 Edit 是等效写操作，取证闸不能只认工具名。
  // 实测绕过路径：`pwsh Add-Content -Path README.md`（A/B 会话对照 B 组第 2 条）。
  // 参数读取必须防炸：DSH 允许 arguments 为惰性 getter，解析失败应降级而非中断整条判定链。
  let shellTargets = []
  let shellMutating = false
  if (SHELL_TOOL.test(tool)) {
    try {
      const cmd = commandOf(exec)
      shellTargets = shellWriteTargets(cmd)
      // 2026-10-18 再补口：熔断/降权的判定此前也挂在"有写目标"上，于是
      // `git commit`、`npm install` 这类**无重定向但会改文件**的命令在熔断期照样放行
      //（本次实测：会话被判熔断后 write 被拒，Bash git commit 却提交成功）。
      // 统一口径：变更型 shell 与写类工具同等对待，熔断期一律只读放行。
      shellMutating = isMutatingBashCmd(String(cmd ?? ''))
    } catch {
      shellTargets = []
      shellMutating = false
    }
  }
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

  // 反规避抽查B（2026-10-19 人类批示）：随机检查点消费——「拒一次」语义，不冻结会话。
  // 触发点在 post-execute（那次写已发生、无法回滚），所以检查点挂在**下一次**变更型调用上。
  // 安全取向：状态清不掉就**不拒**（宁可不拦，也不做永久死锁）——与其余 fail-open 口径一致。
  if (state.randomFusePending) {
    try {
      saveState(gs.file, { ...state, randomFusePending: false })
      return {
        kind: 'deny',
        trigger: 'random-fuse',
        reason:
          `focus-guard-native 反规避抽查B：随机检查点命中（第 ${Number(state.randomFuseAt) || 0} 次写操作），本次变更被拒一次；` +
          '这不是报错，是防「攒批量绕过」的不可预测抽查，重试即放行。',
      }
    } catch (error) {
      warn('反规避抽查B：检查点状态回写失败 → 本次放行（不做永久死锁）:', (error && error.message) || error)
    }
  }

  if (EVIDENCE_GATE.effective) {
    // 2026-10-19 修：真实调用传相对路径（`Add-Content -Path packages/core/README.md`），
    // 未解析时 existsSync 按宿主 cwd 判 → 假阴性 → 取证闸放行（实测 session-002c143b 第 2 条直通）。
    const toolPath = resolveToolPath(pathOfTool(exec && exec.arguments), exec)
    // 2026-10-22 补口：改动类工具**解析不出路径**时（`plugin_manager`、`move_run`、`import_claude`、
    // `mcp__x__build_project` 等），取证闸无法核验"是否先读过"——旧行为是直接放行，
    // 等于这些工具天生免检。现改为默认要求授权（`fg_apply` 一次放行），可用
    // `FG_MUTATION_UNMAPPED=allow` 退回旧行为。
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
  }
  return null
}

// ===== 第 1.3 层：Superpowers 动笔闸（2026-10-18 人类批示）=====
// 规则：模糊开发任务（非闲聊）在**未加载方法论技能**前，不许动笔。
// 为什么拦「动笔」而不是「首轮输出」：DSH 没有 beforeSubmit 缝；而 `agent/pre-step`
// 直接 reject 整轮会把回合打死（DCR 就这么死过，同日卸载）。动笔闸是同一意图的可执行版。
// 判定三件套：开发动词 + 模糊标记 + 无验收词。缺一不判，宁可漏也不误伤闲聊。
const SP_SKILLS = /^(?:brainstorming|writing-plans)$/i
const SP_MUTATORS = /^(?:write|edit|multiedit|str_replace_editor|apply_patch)$/i
const SP_DEV_VERB = /(实现|开发|重构|优化|修复|改造|迁移|重写|升级|接入|搭建|新增|加个|加上|补上|改一下|改改)/
const SP_VAGUE = /(一下|顺手|更好|顺便|提升|优化|性能|体验|好看|清理|整理|完善)/
const SP_ACCEPT = /(验收|测试|命令|报错|复现|接口|字段|路径|行号|截图|日志|表结构|阈值|标准|N\s*=)/

function isVagueDevTask(prompt) {
  const text = String(prompt || '').trim()
  if (text.length < 6) return false
  return SP_DEV_VERB.test(text) && SP_VAGUE.test(text) && !SP_ACCEPT.test(text)
}

/** 本轮提示的稳定戳：只存长度+前缀，不把整段 prompt 写进状态文件。 */
function promptStamp(prompt) {
  const text = String(prompt || '')
  return `${text.length}:${text.slice(0, 48)}`
}

// ===== 第 1.4 层：整文件读取闸（2026-10-18 人类批示：整文件检索交给 XERJ）=====
// 口径：目标文件 > N 行（默认 300）且**没有分段参数/限量管道** → 拒绝，并指向 XERJ。
// 为什么排在 1.5 层之前：环境指纹对 cat 只给「用 bat 替代」，而 bat 同样是整文件灌屏；
// 本层的正解是「别整读，去检索」——谁先开口决定模型学会哪条。
// 边界：命中不了目标文件（相对路径、动态拼接、变量）一律 fail-open，不猜。
const WHOLE_FILE_MAX_LINES = Number(process.env.FG_WHOLE_FILE_MAX_LINES) || 300
const WHOLE_FILE_READ_TOOLS = /^(?:read|read_file|readfile|view)$/i
const WHOLE_FILE_SHELL = /(^|[;&|]\s*)(?:cat|type|Get-Content|bat)\s/i
const WHOLE_FILE_HINT =
  '请调用 XERJ 的 search 或 def 工具（`xerj search "<关键词>"` / `xerj def "<符号>"`），' +
  '或对同一文件带 offset/limit 分段读。'

/** 该文件是否超过 n 行；分块数换行、够数即停，绝不把整文件读进内存。 */
function exceedsLines(file, n) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.allocUnsafe(64 * 1024)
    let lines = 0
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null)
      if (read <= 0) return false
      for (let i = 0; i < read; i += 1) {
        if (buf[i] === 10) {
          lines += 1
          if (lines > n) return true
        }
      }
    }
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* fd 已关或不可关：不影响判定 */
      }
    }
  }
}

/** 读类 shell 命令里的第一个真实存在的文件参数；取不到返回 null（fail-open）。 */
function shellFileTarget(cmd, cwd) {
  for (const token of String(cmd).split(/\s+/)) {
    if (!token || token.startsWith('-') || /[|&;><$`]/.test(token)) continue
    const abs = isAbsolute(token) ? token : join(cwd || process.cwd(), token)
    try {
      if (statSync(abs).isFile()) return abs
    } catch {
      /* 不是文件就下一个 */
    }
  }
  return null
}

// ===== 第 1.5 层：命令硬校验（规则来源 = .ai/env-fingerprint.json 的 map 表）=====
// 指纹是规则来源、本层是执行层：mtime 变化立即生效，无需重启；指纹缺失/损坏一律 fail-open + warn。
const ENV_FINGERPRINT_REL = join('.ai', 'env-fingerprint.json')
let envFpCache = { path: null, mtimeMs: 0, map: null }
let envFpMissingWarned = false

/** 读环境指纹的 map 表；缺失或损坏返回 null（fail-open）。 */
export function readEnvMap(warn, cwd = process.cwd()) {
  const p = join(cwd, ENV_FINGERPRINT_REL)
  try {
    const mtimeMs = statSync(p).mtimeMs
    if (envFpCache.path !== p || envFpCache.mtimeMs !== mtimeMs) {
      const parsed = JSON.parse(readFileSync(p, 'utf8'))
      const map = parsed && parsed.map && typeof parsed.map === 'object' && !Array.isArray(parsed.map) ? parsed.map : null
      envFpCache = { path: p, mtimeMs, map }
    }
    return envFpCache.map
  } catch {
    envFpCache = { path: null, mtimeMs: 0, map: null }
    if (warn && !envFpMissingWarned) {
      envFpMissingWarned = true
      warn(`环境指纹缺失（${p}）：命令硬校验跳过（fail-open）。生成：node packages/core/tools/env-fingerprint.mjs`)
    }
    return null
  }
}

/** 会话工作目录：与 seams.mjs:63 projDirOf / preGuard / postProgress / stopGuard 同源（session.header.cwd）。 */
function cwdOf(exec) {
  const a = exec && exec.agent
  return (a && a.session && a.session.header && a.session.header.cwd) || undefined
}

/**
 * 命令硬校验：任一段（|、;、&&、||、换行）的段首命令词命中 map 的 key → deny。
 * 白名单：① 引号内字符串字面量（先剥离）② 参数值（只判段首 token）③ 文件路径（含分隔符或以 . 开头）。
 */
export function hardCheck(cmd, map, warn, cwd) {
  // cwd 缺省时落回 readEnvMap 的 process.cwd()。DSH Desktop 的进程 cwd 是应用安装目录
  // （E:\DSH\DSH Desktop），不是工作区，故调用点必须传会话 cwd，否则工作区里的
  // .ai/env-fingerprint.json 永远读不到 → 本层等于没开（fail-open）。
  const m = map || readEnvMap(warn, cwd)
  if (!m) return null
  const stripped = String(cmd || '').replace(/'[^']*'|"[^"]*"/g, ' ')
  for (const seg of stripped.split(/\|\||&&|[|;\n]/)) {
    const first = seg.trim().split(/\s+/)[0]
    if (!first) continue
    if (/[\\/]/.test(first) || first.startsWith('.')) continue
    if (Object.prototype.hasOwnProperty.call(m, first)) {
      return { kind: 'deny', reason: `本机环境：用 ${m[first]} 替代 ${first}。命令：${String(cmd).slice(0, 120)}` }
    }
  }
  return null
}

/**
 * 从 exec 提取模型标识（最后一公里）。
 * 取值顺序与 postExecuteListener 的成本行模型同源（exec.agent.model / modelId / exec.model），
 * 另加 FG_MODEL_ID 作显式兜底。取不到时返回 null → 画像为 null → 闸按最严 mutating（安全默认）。
 */
function modelIdOf(exec) {
  return (
    (exec && ((exec.agent && (exec.agent.model || exec.agent.modelId)) || exec.model)) ||
    process.env.FG_MODEL_ID ||
    null
  )
}

export function preExecuteListener({ warn, riskOf = riskOfSentinel, observe = OBSERVATION, statePath } = {}) {
  return async (exec, next) => {
    rememberReads(exec)

    // ===== 3.0.7：误伤申辩入口（必须最先处理）=====
    // 申辩参数必然携带被拦的危险命令原文，若走后续红线/资格闸会被同一规则再拦一次（死循环）。
    // DSH 契约：返回 {kind:"ask"} 经 approval seam 交人类一次性裁决（dsh-tools/lib/index.js:3226）。
    // 这是"司法救济"通道——个案当场申辩，不必等修法（见 RULES 第八十三条(四)）。
    if (String((exec && exec.name) || '') === 'fg_appeal') {
      try {
        const { appealAsk } = await import('../adapters/dsh/eligibility-gate.mjs')
        const ask = await appealAsk(exec, warn)
        if (ask) return ask
      } catch (error) {
        warn('申辩处理异常，fail-open 放行：', (error && error.message) || error)
      }
    }

    const layer3 = layer3Check(exec, warn, statePath)
    if (layer3) {
      // trigger 由判定点给出（反规避抽查B 记 random-fuse；其余仍是 evidence-gate），审计才能回答"为什么被拦"。
      auditDeny(exec, layer3.reason, { trigger: layer3.trigger || 'evidence-gate', level: 3 })
      warn('第3层拦截：', layer3.reason)
      return layer3
    }
    warnIfStaleOnce(warn)
    let cmd
    try {
      cmd = commandOf(exec)
      if (cmd) {
        const redline = redlineOf(cmd)
        if (redline) {
          // 3.0.6 P0：上下文豁免——命中片段是被引用的命令字符串（数据）而非要执行的命令。
          // 3.0.7 追加：申辩获批凭据——人类就该红线的某次申辩批准后，本会话内放行该红线。
          const exempt = redlineExempt(cmd, redline)
          let granted = null
          if (!exempt) {
            try {
              const { hasRedlineGrant } = await import('../adapters/dsh/eligibility-gate.mjs')
              granted = await hasRedlineGrant(exec, redline.name)
            } catch {
              granted = null
            }
          }
          if (exempt || granted) {
            const basis = exempt ? exempt.basis : 'appeal-granted'
            const detail = exempt ? exempt.detail : `申辩获批凭据（红线 ${redline.name}）`
            warn(`红线放行（${basis}）：`, `${redline.name} — ${detail}`)
            auditRedlineExempt(exec, cmd, { redline: redline.name, basis, detail })
          } else {
            warn(`已拦截绝对红线（${redline.name}）：`, cmd.slice(0, 120))
            auditDeny(exec, cmd, { trigger: `redline:${redline.name}`, level: 3 })
            return {
              kind: 'deny',
              reason:
                `focus-guard-native: 命中绝对红线「${redline.name}」，直接拒绝（不弹审批）。` +
                `如认为误判（例如危险片段只是被引用的数据），调用 fg_appeal 提交反例锚点（文件:行号或原文引用），由人类一次性裁决。`,
            }
          }
        }
      }
    } catch (error) {
      warn('红线判定异常，fail-open 放行：', (error && error.message) || error)
      return next()
    }

    // 第 1.3 层：Superpowers 动笔闸（模糊开发任务：先加载方法论，再动笔）
    try {
      const spFile = guardStateFile(sessionIdOf(exec))
      const spState = existsSync(spFile) ? loadState(spFile) : null
      const spPrompt = String((spState && (spState.turnPromptFull || spState.turnPrompt)) || '')
      if (spState && isVagueDevTask(spPrompt)) {
        const stamp = promptStamp(spPrompt)
        const spTool = String((exec && exec.name) || '')
        const spArgs = (exec && exec.arguments) || {}
        // 模型已加载方法论 → 本轮放行并记住
        if (/^skill$/i.test(spTool) && SP_SKILLS.test(String(spArgs.name || spArgs.skill || ''))) {
          spState.spLoadedFor = stamp
          saveState(spFile, spState)
          return next()
        }
        if (spState.spLoadedFor === stamp) return next()
        const mutating = SP_MUTATORS.test(spTool) || (cmd && MUTATOR_HEAD_RE.test(cmd))
        if (mutating && spState.spDeniedFor !== stamp) {
          spState.spDeniedFor = stamp
          saveState(spFile, spState)
          warn('Superpowers 动笔闸：', `模糊开发任务未加载方法论即动笔（${spTool || 'shell'}）`)
          auditDeny(exec, `动笔前置：${spTool || 'shell'}`, { trigger: 'superpowers:writing-gate' })
          return {
            kind: 'deny',
            reason:
              'focus-guard-native: [Superpowers] 这是模糊开发任务，先别动笔。' +
              '请先调用 brainstorming 或 writing-plans 工具（skill 工具，name 为其中之一），' +
              '确认需求并给出计划后再改代码。本次只拒一次，重试即放行。',
          }
        }
      }
    } catch (error) {
      warn('Superpowers 动笔闸异常，fail-open 放行：', (error && error.message) || error)
    }

    // 第 1.4 层：整文件读取闸（大文件不许整读，改走 XERJ 检索）
    try {
      const toolName = String((exec && exec.name) || '')
      const args = (exec && exec.arguments) || {}
      let target = null
      let segmented = false
      if (WHOLE_FILE_READ_TOOLS.test(toolName)) {
        // 2026-10-19 修：真实调用传相对路径，必须按会话 cwd 解析，否则 statSync 抛错 → 闸无声跳过。
        target = resolveToolPath(pathOfTool(args), exec)
        segmented = Boolean(args.limit || args.offset)
      } else if (cmd && WHOLE_FILE_SHELL.test(cmd)) {
        segmented = /\||>|-TotalCount|-First|-Tail|--limit/.test(cmd)
        if (!segmented) target = shellFileTarget(cmd, cwdOf(exec))
      }
      if (target && !segmented && exceedsLines(target, WHOLE_FILE_MAX_LINES)) {
        warn('整文件闸拦截：', `${target} 超过 ${WHOLE_FILE_MAX_LINES} 行整读`)
        auditDeny(exec, `整读 ${target}`, { trigger: 'whole-file:lines' })
        return {
          kind: 'deny',
          reason:
            `focus-guard-native: 整文件闸——${target} 超过 ${WHOLE_FILE_MAX_LINES} 行，禁止整文件读取（本次为相对路径，已按会话 cwd 解析）。` +
            WHOLE_FILE_HINT,
        }
      }
    } catch (error) {
      warn('整文件闸异常，fail-open 放行：', (error && error.message) || error)
    }

    // 第 1.5 层：命令硬校验（红线之后、语义预判之前；不依赖 AI 自觉）
    if (cmd) {
      try {
        const hard = hardCheck(cmd, null, warn, cwdOf(exec))
        if (hard) {
          warn('硬校验拦截：', hard.reason)
          auditDeny(exec, cmd, { trigger: 'env-substitute', level: 2 })
          return hard
        }
      } catch (error) {
        warn('硬校验异常，fail-open 放行：', (error && error.message) || error)
      }
    }

    // ===== 3.0.5 第二步：资格审核闸 —— 高危工具须先调 fg_apply 取得授权 =====
    // 按需加载适配层模块：本文件不在顶部静态 import，以免与适配层的注入关系形成环形依赖。
    // 2026-10-18（任务测试 T39 修）：原条件为 `if (cmd)`，而 Write/Edit 没有 command 参数，
    // 于是"写系统路径"这类只能靠 file_path 判定的门槛**从未被执行**。改为命令或路径任一存在即过闸。
    const gateFilePath = (() => {
      const a = (exec && exec.arguments) || {}
      const p = a.file_path ?? a.filePath ?? a.path ?? a.notebook_path
      return typeof p === 'string' ? p : ''
    })()
    if (cmd || gateFilePath) {
      try {
        const { gateToolCall } = await import('../adapters/dsh/eligibility-gate.mjs')
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
    }

    // ===== 3.0.8（移植批 2）：体积刺客三闸 =====
    // 移植自 guard.mjs L579-620。DSH 侧此前完全没有这三道闸——大文件整读会一次灌入上下文、
    // 步步重复计费，是"烧上下文"最直接的来源。
    try {
      const toolName = String((exec && exec.name) || '')
      const args = (exec && exec.arguments) || {}
      const target = resolveToolPath(pathOfTool(args), exec)
      const sessionId = sessionIdOf(exec)
      const stateFile = guardStateFile(sessionId)
      const st = existsSync(stateFile) ? loadState(stateFile) : null
      const turnPrompt = String((st && (st.turnPromptFull || st.turnPrompt)) || '')

      // ① Read 整读体积闸（判定见 core/outputGate.mjs:judgeReadGate）
      //    2.5.3（案二）：审计/盘点/审查类任务整读留痕不罚——法典把审计定为 50 预算
      //    重大专项，体积闸却拦审计最需要的整读，属制度性误伤。
      if (/^read$/i.test(toolName) && !args.limit && target) {
        let kb = 0
        try {
          kb = Math.round(statSync(String(target)).size / 1024)
        } catch {
          kb = 0
        }
        const verdict = judgeReadGate({ bytes: kb * 1024, gateBytes: OUTPUT_GATE_BYTES, turnPrompt })
        if (verdict === 'exempt') {
          auditRedlineExempt(exec, `${target} ${kb}KB 整读`, {
            redline: 'output-gate',
            basis: 'audit-task-exempt',
            detail: `${target} ${kb}KB 整读（审计任务豁免，留痕不罚）`,
          })
          warn('体积刺客·审计豁免：', `${target} ${kb}KB 整读已留痕（审计任务）。预算仍计费，巨量输出仍追责。`)
        } else if (verdict === 'deny') {
          warn('体积刺客拦截：', `${target} ${kb}KB 整读`)
          auditDeny(exec, `${target} ${kb}KB 整读`, { trigger: 'volume:kb' })
          return {
            kind: 'deny',
            reason:
              `focus-guard-native: 体积刺客——${target} ${kb}KB，整读一次灌入、步步重复计费。` +
              `请用 limit+offset 分段读，或交子代理处理。`,
          }
        }
      }

      // ② Grep 收窄闸（判定见 core/outputGate.mjs:judgeGrepGate）
      // 2026-10-19 修：原条件依赖 output_mode/head_limit —— 那是**合成参数**，真实 DSH grep
      // 工具只有 {pattern,path,include}，条件永不成立（实测 session-002c143b 直通）。
      // 2026-10-22 清死分支：`grepContentNoLimit` 已删。它线上永远走不到，却让 decision-bench
      // 里一条用合成参数的用例继续"通过"——死代码在给假测试续命。
      // DSH 侧的"未收窄"语义 = 明确指定了**目录**却没给 include（等价于全目录正文搜索）。
      const broadDir =
        /^grep$/i.test(toolName) && Boolean(args.path) && isDirPath(target) && !args.include && !args.head_limit
      const grepVerdict = judgeGrepGate({ broadDir })
      if (grepVerdict.action === 'deny') {
        warn('体积刺客拦截：', 'Grep 目录级搜索未收窄')
        auditDeny(exec, `Grep 未收窄（path=${String(args.path || '-').slice(0, 60)} include=${args.include || '-'}）`, {
          trigger: 'volume:grep',
        })
        return {
          kind: 'deny',
          reason: `focus-guard-native: 体积刺客——Grep 未收窄。${grepVerdict.reason}`,
        }
      }

      // ③ 裸 cat/type 刷屏闸（判定见 core/outputGate.mjs:judgeCatGate）
      if (cmd && judgeCatGate(cmd) === 'deny') {
        warn('体积刺客拦截：', `裸 cat/type：${cmd.slice(0, 60)}`)
        auditDeny(exec, `裸 cat/type：${cmd.slice(0, 60)}`, { trigger: 'volume:cat' })
        return {
          kind: 'deny',
          reason: 'focus-guard-native: 体积刺客——禁裸 cat/type 刷屏。用 `cat x | head -100`，或先 grep/wc 定位。',
        }
      }
    } catch (error) {
      warn('体积刺客闸异常，fail-open 放行：', (error && error.message) || error)
    }

    // ===== 3.0.8（移植批 2）：污染核实闸 + 风险文件留痕 =====
    try {
      const toolName2 = String((exec && exec.name) || '')
      const args2 = (exec && exec.arguments) || {}
      const target2 = pathOfTool(args2)
      const stateFile2 = guardStateFile(sessionIdOf(exec))
      const st2 = existsSync(stateFile2) ? loadState(stateFile2) : null
      const isMutating = /^(?:Write|Edit|MultiEdit|Delete|Move|Patch|NotebookEdit)$/i.test(toolName2)

      // 污染核实闸（移植自 guard.mjs L534-543）：上轮工具输出与参数矛盾且未核实前，
      // 首个改动类先拦一次（一次性，重试放行）；只读核验不受限。
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

      // 风险文件修改 100% 留痕（不拦，只记录；移植自 guard.mjs L555-558）
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

    // 第 2 层：语义预判（可插拔）。工具调用（write/read 等无命令参数）零打扰透传。
    if (cmd) {
      const tool = String((exec && exec.name) || '')
      let verdict
      try {
        verdict = await riskOf(cmd, tool)
      } catch (error) {
        warn('第2层判定失败，保守走审批：', (error && error.message) || error)
        return buildAsk(cmd, 'error', 'judge_failed', (error && error.message) || String(error))
      }
      const risk = clampRisk(verdict && verdict.risk)
      const category = (verdict && verdict.category) || 'unknown'
      const reasons = (verdict && verdict.reasons) || []
      const backend = (verdict && verdict.backend) || 'unknown'
      observe.judgements += 1
      if (reasons.length > 0) warn(`第2层启发式命中（risk=${risk}）：`, reasons.join(','))
      if (risk > RISK_ASK_THRESHOLD) {
        observe.highRisk += 1
        // 观察模式：留痕 + 告警，但放行（不返回 ask），直到累计判定数达标并由人类启用
        auditDeny(exec, `risk=${risk} category=${category} backend=${backend} | ${String(cmd).slice(0, 100)}`, { trigger: `risk:${category}`, level: 2 })
        warn(
          `第2层高危但观察模式放行（risk=${risk} category=${category} backend=${backend} judgements=${observe.judgements}）：`,
          cmd.slice(0, 120),
        )
        if (!observeNoticeEmitted && observe.judgements >= OBSERVE_UNTIL_JUDGEMENTS) {
          observeNoticeEmitted = true
          warn(
            `观察模式已累计 ${observe.judgements} 次判定（高危 ${observe.highRisk} 次），可评估是否启用 ask（由人类决定）`,
          )
        }
        if (observe.effective) return buildAsk(cmd, risk, category)
      }
    }
    return next()
  }
}

/** ② 系统提示装配：追加成本提示行（改写失败原样放行下游） */
export function systemPromptListener({ warn }) {
  return async (assembly, context, next) => {
    warnIfStaleOnce(warn)
    let downstream
    try {
      downstream = await next()
      const line = promptCostLine()
      if (typeof downstream === 'string') return downstream ? downstream + '\n' + line : line
      if (Array.isArray(downstream)) return [...downstream, line]
      if (downstream && typeof downstream === 'object') {
        // 官方 assembly 形状（dsh-system-prompt/lib/index.js:338-354）：
        // { sections:[{name,text}], contexts, tools, variables } —— 顶层没有 text/system 字段，
        // 因此成本行以新增 section 的方式注入（原实现遍历 text/system 等键，恒不命中）。
        if (Array.isArray(downstream.sections)) {
          return { ...downstream, sections: [...downstream.sections, { name: 'focus-guard-cost', text: line }] }
        }
        for (const k of ['system', 'systemPrompt', 'text', 'prompt']) {
          if (typeof downstream[k] === 'string') {
            return { ...downstream, [k]: downstream[k] + '\n' + line }
          }
        }
      }
    } catch (error) {
      warn('system-prompt 注入异常，原样放行：', (error && error.message) || error)
    }
    return downstream
  }
}

/** ③ 工具执行后：用量折算落台账（只观测；next 缺失时兜底 undefined，不影响下游默认决策） */
export function postExecuteListener({ warn }) {
  return async (exec, result, next) => {
    try {
      const usage =
        usageOf(result && result.usage) ||
        usageOf(exec && exec.usage) ||
        usageOf(result && result.meta && result.meta.usage)
      if (usage) {
        costMissStreak = 0
        const model =
          (exec && ((exec.agent && (exec.agent.model || exec.agent.modelId)) || exec.model)) ||
          (result && result.model) ||
          'unknown'
        const { inPeak } = isPeakAt(new Date())
        appendCostRow(new Date().toISOString(), model, inPeak, usage)
      } else {
        // 2026-10-18 修（REPORT-2026-10-12「成本台账静默停摆」）：原实现无 else——
        // 宿主不提供 usage 时整条成本核算静默失效（台账 10-08 起零新增，没人发现）。
        // 连续多次拿不到就 warn 一次，把"停摆"变成可见信号。
        costMissStreak += 1
        if (costMissStreak === COST_MISS_WARN_AT) {
          warn(
            `成本台账停摆：连续 ${COST_MISS_WARN_AT} 次工具结果都没有 usage 字段（宿主未提供），本会话成本未记账。`,
          )
        }
      }
    } catch (error) {
      warn('成本核算异常（不阻塞）:', (error && error.message) || error)
    }
    return next()
  }
}
