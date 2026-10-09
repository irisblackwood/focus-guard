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
import { redlineExempt } from '../core/redlines.mjs'
import { loadProfile } from '../core/profileLoader.mjs'
import { isPeakAt, isSaveStreamEnabled } from '../peak-cost.mjs'
import { statSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

/** 每次改动本文件递增；用于磁盘/内存版本一致性提示 */
const PIPELINE_VERSION = '3.0.6-m1'

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
// rm 递归强删根/HOME 族：rm -rf / ... 、rm -rf ~ ...（后随任意字符即命中本档）
const RM_RF_ROOT = /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*(?:r\w*f|f\w*r)\w*\s+["']?[\/~][\/\s"']*(?=\s|["']|$)/
/** 破坏库结构：DROP DATABASE / DROP SCHEMA / TRUNCATE TABLE */
const DROP_DB = /\b(?:drop\s+(?:database|schema)|truncate\s+table)\b/i
/** 强制推送：git push -f / --force / --force-with-lease */
const GIT_PUSH_FORCE = /\bgit\s+push\b[^\n]*\s(?:-f|--force(?:-with-lease)?)\b/i

export const ABSOLUTE_REDLINES = [
  { name: 'rm-rf-root', re: RM_RF_ROOT },
  { name: 'drop-database', re: DROP_DB },
  { name: 'git-push-force', re: GIT_PUSH_FORCE },
]

/** 命中哪条绝对红线；未命中返回 null */
export function redlineOf(cmd) {
  if (!cmd) return null
  return ABSOLUTE_REDLINES.find((r) => r.re.test(cmd)) || null
}

/** 提取命令类参数；非命令类工具（write/read 等）返回 null，不做检查 */
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
  { re: /[>]{1,2}\s*\S/, cat: 'redirect', w: 0.3 },
  { re: /\b(?:child_process|execSync|spawnSync|subprocess|os\.system)\b/, cat: 'subprocess', w: 0.5 },
  { re: /\b(?:shutil\.rmtree|fs\.rmSync|Remove-Item)\b/i, cat: 'destructive_api', w: 0.6 },
  { re: RM_RF, cat: 'fs_mutation', w: 0.3 },
  { re: /\b(?:mv|dd|truncate)\s/, cat: 'fs_mutation', w: 0.3 },
  { re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+\.)/, cat: 'history_overwrite', w: 0.6 },
]

/**
 * 启发式兜底实现（本阶段 mock 语义）：命中规则累加权重、上限 0.99。
 * 当前规则最高累加 0.6 —— 设计上**恒不越过 0.85 阈值**，因此不产生 ask；
 * 阈值分支由测试/未来 Needle 2 实现驱动（见 preExecuteListener 的 riskOf 注入）。
 * @returns {{risk:number, category:string, reasons:string[]}}
 */
export function riskOfHeuristic(cmd, tool) {
  const hits = HEURISTIC_RULES.filter((r) => r.re.test(cmd ?? ''))
  return {
    risk: clampRisk(hits.reduce((a, r) => a + r.w, 0)),
    category: hits.slice().sort((a, b) => b.w - a.w)[0]?.cat || 'benign',
    reasons: hits.map((r) => r.cat),
  }
}

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
 */
export function riskOfSentinel(cmd) {
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
const pathOfTool = (args) => {
  const a = args || {}
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

const nativeReadSet = new Set()
const evidenceBlockedOnce = new Set()

/** 记录本会话内已读过的文件（第 3 层取证判定的原生侧证据） */
function rememberReads(exec) {
  if (READ_TOOL.test(String((exec && exec.name) || ''))) {
    const p = pathOfTool(exec && exec.arguments)
    if (p) nativeReadSet.add(String(p))
  }
}

/** 第 3 层判定：返回 deny 决策或 null（放行到下游）；读失败一律 fail-open + warn */
function layer3Check(exec, warn, statePathOverride) {
  const tool = String((exec && exec.name) || '')
  if (!MUTATING_TOOL.test(tool)) return null

  const gs = readGuardState(statePathOverride)
  if (gs === null) {
    warn('第3层：读不到 guard 会话状态（fail-open 放行；目录内无 15 分钟内更新的 focus-guard-*.json）')
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

  if (EVIDENCE_GATE.effective) {
    const fp = pathOfTool(exec && exec.arguments)
    if (fp) {
      const key = String(fp)
      const known =
        nativeReadSet.has(key) ||
        (state.readSet && typeof state.readSet === 'object' && Object.hasOwn(state.readSet, key))
      // 3.0.7（HANDOFF §十一 任务 C）：取证闸只对"**已存在**目标的修改"有意义。
      // 新建文件没有可读的既有内容 —— 文件不存在 → 读不了 → 永远进不了 readSet →
      // 只能靠"拒一次后豁免"逃生，是死锁。故目标不存在（新建）时直接放行，不要求先读。
      // existsSync 失败（权限/异常）一律视为"不存在"，与取证闸其余分支的 fail-open 口径一致。
      if (!known && existsSync(key) && !evidenceBlockedOnce.has(key)) {
        evidenceBlockedOnce.add(key)
        return {
          kind: 'deny',
          reason: `focus-guard-native 第3层状态校验：卷宗无取证记录（本会话未读 ${fp}），改动类调用被拒一次；先读取该文件再重试（避免盲写）`,
        }
      }
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

/**
 * 命令硬校验：任一段（|、;、&&、||、换行）的段首命令词命中 map 的 key → deny。
 * 白名单：① 引号内字符串字面量（先剥离）② 参数值（只判段首 token）③ 文件路径（含分隔符或以 . 开头）。
 */
export function hardCheck(cmd, map, warn) {
  const m = map || readEnvMap(warn)
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
      auditDeny(exec, layer3.reason)
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
            auditDeny(exec, cmd)
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

    // 第 1.5 层：命令硬校验（红线之后、语义预判之前；不依赖 AI 自觉）
    if (cmd) {
      try {
        const hard = hardCheck(cmd, null, warn)
        if (hard) {
          warn('硬校验拦截：', hard.reason)
          auditDeny(exec, cmd)
          return hard
        }
      } catch (error) {
        warn('硬校验异常，fail-open 放行：', (error && error.message) || error)
      }
    }

    // ===== 3.0.5 第二步：资格审核闸 —— 高危工具须先调 fg_apply 取得授权 =====
    // 按需加载适配层模块：本文件不在顶部静态 import，以免与适配层的注入关系形成环形依赖。
    if (cmd) {
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
          command: cmd,
          profile: modelId ? loadProfile(modelId) : null,
        })
        if (gate.kind === 'deny') {
          warn('资格审核闸拦截：', gate.reason)
          auditDeny(exec, cmd)
          return { kind: 'deny', reason: `focus-guard-native: ${gate.reason}` }
        }
      } catch (error) {
        warn('资格审核闸异常，fail-open 放行：', (error && error.message) || error)
      }
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
        auditDeny(exec, `risk=${risk} category=${category} backend=${backend} | ${String(cmd).slice(0, 100)}`)
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
        const model =
          (exec && ((exec.agent && (exec.agent.model || exec.agent.modelId)) || exec.model)) ||
          (result && result.model) ||
          'unknown'
        const { inPeak } = isPeakAt(new Date())
        appendCostRow(new Date().toISOString(), model, inPeak, usage)
      }
    } catch (error) {
      warn('成本核算异常（不阻塞）:', (error && error.message) || error)
    }
    return next()
  }
}
