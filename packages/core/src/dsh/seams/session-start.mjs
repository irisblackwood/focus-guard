/**
 * ① `agent/created` → SessionStart：建立/载入本会话状态 + 环境检测 + 卷宗载入 + 巡视。
 *
 * 移植自 guard.mjs 的 start 模式（L90-193），**唯一的取舍**：原文把常驻规则 `SESSION_RULES`
 * 混在 `hookSpecificOutput.additionalContext` 里用 stdout 输出（Claude hooks 协议）；
 * DSH 原生插件不走 stdout，注入缝是 `system-prompt/assemble` —— 故规则改由
 * `prompt-rules.mjs` 的 `systemPromptRulesListener` 承担，本缝只管状态与环境。
 *
 * 去掉脚本特有部分：rmSync(path)（原文每次 start 都清状态；DSH 的会话状态要跨回合保留，
 * 清空会丢取证记录）、cleanStaleTemp 之外的 ZCode 注册表核验（`~/.zcode/...` 在 DSH 下无意义）。
 *
 * 2026-10-27 拆分：本文件从 `seams.mjs` 原样搬出（函数体超 80 行、嵌套 7 层），
 * 只做「主流程 + 私有 helper」的切分，**判定与文案一字未改**。
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  statePath,
  loadState,
  saveState,
  casePath,
  ensureCaseFile,
  loadCaseRecords,
  fmtTime,
} from '../../core/state.mjs'
import { noteFail } from '../../core/audit.mjs'
import { detectEnv, probeShells, quickShellId } from '../../core/env.mjs'
import { ENGINE_VERSION } from '../../core/constants.mjs'
import { sidOf, projDirOf, isSubagent, auditRow } from './shared.mjs'

/** 42条 版本核验的候选清单（封存版单列，命中即豁免——见下方 checkVersionDrift 注释）。 */
const SEALED = new Set(['packages/core/hooks/guard.mjs'])
const VERSION_CANDIDATES = ['hooks/guard.mjs', 'focus-guard/hooks/guard.mjs', 'packages/core/hooks/guard.mjs']

/** 指纹生成器（安装后目录结构不变：src/dsh/seams → ../../../tools）。 */
const ENV_FP_TOOL = fileURLToPath(new URL('../../../tools/env-fingerprint.mjs', import.meta.url))

export function sessionStartListener({ warn } = {}) {
  return async ({ agent } = {}) => {
    try {
      const sid = sidOf(agent)
      const file = statePath(sid)
      const projDir = projDirOf(agent)
      const state = loadState(file)
      const first = !existsSync(file)

      // ── 子代理：只落一份最小状态，跳过环境检测 / 卷宗读写 / 规则备案 / 巡视 ──
      // （理由见 isSubagent 注释：这些对短命的子代理没有意义，且会重写工作区卷宗、误读其 prompt）
      if (isSubagent(agent)) {
        if (first) {
          saveState(file, state)
          auditRow(sid, 'subagent-start', `子代理会话（轻量初始化，跳过卷宗与环境检测）：${file}`)
        }
        return
      }

      detectEnvInto(state, projDir)
      if (projDir) prepareProject({ sid, projDir, state })

      state.taskChain = (state.taskChain || 'S') + ''
      if (first) state.taskChain = 'S' + Date.now().toString(36) // 3.0.0 因果链：会话根链
      saveState(file, state)
      if (first) {
        auditRow(sid, 'start-fired', `本会话状态初始化（DSH 原生插件自持）：${file}`)
      }
      // 立法法·第七章 规则备案
      auditRow(sid, 'rules-registered', `立法法(试行)v1.0 生效2026-09-29; 监督办法v1.0(docs/RULES.md); 引擎v${ENGINE_VERSION}`)
    } catch (error) {
      if (typeof warn === 'function') warn('会话启动缝异常（不阻塞）:', (error && error.message) || error)
    }
  }
}

/**
 * 本宿主应当使用的执行体标识。
 *
 * 2026-11-09 修：原先 win32 恒返回 `'powershell'`，注释称「DSH 的 shell 工具执行体由宿主固定
 * （win32 上是 pwsh）」。**实测不成立**——DSH Desktop 只有 `dsh-tool-bash`，执行 argv 是
 * `["bash", "-c", cmd]`（`@deepseek-ai/dsh-bash-local/lib/index.js:141`），没有 pwsh 工具。
 * 那条注释是 2.x 时代的遗留假定，从未核对；后果是卷宗【一】写 powershell、平台禁令按
 * PowerShell 规则选，而每条命令实际跑在 bash 里。
 *
 * 也不能退回 `quickShellId()`：宿主进程 `SHELL` 未定义、`ComSpec` 指向 cmd.exe，它会猜成 `cmd`。
 * 现在的判据是**探测**：扫 PATH，能解析到 `bash` 就认 bash（DSH 的 Bash 工具就是 `bash -c`）；
 * 探不到才退回宿主推断。不写死任何安装路径——装在 D 盘、scoop 目录、或压根没装，都能判对。
 * `FG_SHELL` 仍可覆盖，供测试与特殊部署使用。
 */
function expectedShellId() {
  const forced = String(process.env.FG_SHELL || '').trim().toLowerCase()
  if (forced) return forced
  return probeShells().includes('bash') ? 'bash' : quickShellId()
}

/**
 * 2.0 环境检测：会话级一次，写入 state.envCache（总纲三 / MASTER-PLAN §三）。
 *
 * 2026-10-29 修：MASTER-PLAN §三 写的是「`envCache` 非空即代表已检测」「SessionStart
 * 环境检测（若未检测）」，但此前这里**没有**那个判断，每次 SessionStart 都重算。
 * 而 `agent/created` 会对同一会话反复触发——实测 82 次调用落在 21 个会话上，
 * 单会话最多 33 次（跨重启/热重载恢复都算一次），每次白付约 228ms。
 *
 * 现在只在两种情况下重算：① 还没检测过；② 平台或执行体与缓存对不上。
 * 后者是「缓存不能比它的输入活得久」——缓存 key 必须包含输入，否则换环境还拿旧结果。
 *
 * 关于「shell 变化重检」：`pre-step.mjs` 注释说该分支「留待后续批次」，实际从未移植。
 * 在 DSH 路径上它不是缺口——插件是常驻进程，执行体由宿主决定，回合之间不会变。
 * 需要每进程重检的是封存版 `guard.mjs`（每次调用都是新进程，SHELL 可能不同），那条路本来就有。
 */
function detectEnvInto(state, projDir) {
  // 2026-11-09：注释与实现一并更正。原写「执行体是 pwsh（cordis.patch.yml 的 pwshPath）」——
  // 实测 DSH Desktop 走 `["bash","-c",cmd]`，且根本没有 pwsh 工具（详见 expectedShellId）。
  // 仍要显式传参：Node 进程自身的 ComSpec 是 cmd，不传就会记成 cmd（也不是 bash）。
  // 用参数传，不写环境变量（否则会被子进程继承，污染测试）。
  const cached = state.envCache
  if (cached && cached.os === process.platform && cached.shellIdKey === expectedShellId()) return
  try {
    // 命令语法表（grep/sed/find 是 GNU 还是 BSD）来自环境档案。生成器要跑子进程探测，
    // 会话启动不该付这个钱——读一次 JSON 就够。读不到时 `platformBashViolation` 退回 OS 推断。
    let commands = {}
    try {
      const t = JSON.parse(readFileSync(join(projDir, '.ai', 'env-fingerprint.json'), 'utf8'))
      if (t && t.commands) commands = t.commands
    } catch {
      /* 档案缺失或损坏：按无命令语法表处理，不阻断 */
    }
    state.envCache = detectEnv(projDir, { shell: expectedShellId(), commands })
  } catch {
    /* 环境检测失败不阻断 */
  }
}

/**
 * 环境指纹自动补齐（2026-11-07）。
 *
 * 病根：全仓没有任何生成入口——`INSTALL.md` 没写、会话启动不做、`postinstall` 也不做。
 * 于是第 1.5 层命令硬校验在**大多数机器上等于没开**（缺文件即 fail-open），
 * 而作者机上恰好有一份手工生成的，造成「同一条命令这边拦、那边放」。
 *
 * 为什么后台 spawn 而不是同步算：探测 5 个工具正常几百毫秒，但工具挂起时最坏要 7 秒以上，
 * 不该压在会话启动路径上。生成后下一回合即生效；本次仍 fail-open，与旧行为一致。
 */
/**
 * 环境指纹的有效期。过期即重新探测。
 *
 * 2026-11-08 补：`ensureEnvFingerprint` 原先只有「不存在才生成」（`if (existsSync(fp)) return`），
 * 生成一次就永久冻结——作者机上那份停在 2026-10-08，31 天没动。
 * 而这个文件不只是留痕：`hardCheck.mjs` 第 1.5 层的命令映射（`grep→rg` / `find→fd`）
 * **直接读它**。shell 换版本、工具装了或卸了，规则表照旧用旧的 → 同一条命令
 * 「这边拦、那边放」，且没有任何信号。留痕件同时是规则源，就必须有保质期。
 */
export const ENV_FP_TTL_MS = 30 * 86400e3

/**
 * 指纹是否过期。读不到 / 解析不了 / 没有 generated_at 一律算过期——
 * 宁可多探测一次（后台、几百毫秒），也不要拿着一份坏掉的规则表继续判。
 */
export function envFpStale(fp, now = Date.now()) {
  try {
    const t = JSON.parse(readFileSync(fp, "utf8"))
    // 2026-11-09：v2 档案自带 nextAt（自适应 TTL，6h 起、连续未变翻倍、上限 30 天）。
    // 旧文件没有 probe 字段 → 退回 generated_at + 30 天，保证升级期不会突然全员重探。
    const nextAt = Date.parse(t?.probe?.nextAt || "")
    if (Number.isFinite(nextAt)) return now >= nextAt
    const at = Date.parse(t.generated_at || "")
    if (!Number.isFinite(at)) return true
    return now - at >= ENV_FP_TTL_MS
  } catch {
    return true
  }
}

function ensureEnvFingerprint(projDir) {
  if (process.env.FG_ENV_FP_AUTO === '0') return
  try {
    const fp = join(projDir, '.ai', 'env-fingerprint.json')
    if (existsSync(fp) && !envFpStale(fp)) return
    // 2026-11-08：**不能加 `detached: true`**。Windows 上它会为子进程新开一个控制台窗口
    // （`windowsHide: true` 拦不住），而且实测那个子进程从不产出——`.ai/env-fingerprint.json`
    // 等 3 秒仍不存在、目录为空。非 detached + `unref()` 既能活过父进程，又不弹窗，实测立刻落盘。
    // 判据：这个子进程只是写一个 JSON，不需要独立进程组；要的是「别阻塞会话启动」，不是「脱离父进程」。
    // 2026-11-09：**也不传 `cwd`**。工具只往 `--out` 写、只探 PATH，不读项目目录；而把 cwd 设成
    // 项目目录等于让这个后台进程**攥住项目目录的句柄**——Windows 上期间删/改/移动该目录一律 EBUSY
    // （实测：`env-cache-reuse` 用例在 after 清理时报 rmdir EBUSY）。
    // 2026-11-09：`--shell` 把**本会话实际执行体**传进去。档案里的 `platform.shell` 原本由
    // 生成器自己猜（优先 pwsh），于是同一台机器上卷宗写 bash、档案写 pwsh，两份记录互相打架。
    const child = spawn(process.execPath, [ENV_FP_TOOL, '--out', fp, '--shell', expectedShellId()], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch {
    /* 生成失败不阻断：缺文件时该层仍 fail-open，与旧行为一致 */
  }
}

/** 2.0~42条：卷宗载入 + 环境声明落卷 + 交叉巡视 + 部署版本核验。 */
function prepareProject({ sid, projDir, state }) {
  loadCaseInto(state, sid, projDir)
  writeEnvDeclaration(state, sid, projDir)
  ensureEnvFingerprint(projDir)
  // 36条 异地交叉巡视：新会话接手 → 复核前任结论
  inspectHandover(sid, projDir)
  checkVersionDrift(sid, projDir)
}

/** 2.0 卷宗载入：重建取证记录与 TTL 表（总纲七）。 */
function loadCaseInto(state, sid, projDir) {
  try {
    state.caseCache = loadCaseRecords(ensureCaseFile(projDir))
    // 2.5.3（案一）：从卷宗重建的记录标为"继承"——内容不在本会话上下文中，
    // 据此免重读会挡住合法首读。继承记录只提示不拦，本会话真读过（post 重录指纹）后转正。
    for (const k of Object.keys(state.caseCache)) state.caseCache[k].inherited = 1
  } catch {
    noteFail(sid, '卷宗初始化（工作区可能只读，降级继续）')
  }
}

/** 卷宗【一】环境声明落卷（原子写：tmp + rename）。 */
function writeEnvDeclaration(state, sid, projDir) {
  try {
    const cp = casePath(projDir)
    let t = readFileSync(cp, 'utf8')
    const env = state.envCache || {}
    // 「可用=」是本机扫 PATH 探到的执行体（按推荐顺序）。写进卷宗，是为了让读到这一行的人
    // （模型或人类）知道**该用哪个 shell**——实测本机 pwsh7 装在 E 盘、powershell 5.1 才是自带的。
    // 自带的不标（省地方），额外安装的标「(额外)」——这个区别决定模型该不该建议"去装一个"。
    // OS 用 `Windows/x64` 而不是 `win32`：后者是 Node 的 API 名，模型会误读成 32 位系统。
    const shells = (env.shells || []).map((s) => `${s.id}${s.origin === 'extra' ? '(额外)' : ''}`).join(',')
    const envRow = `- OS=${env.osLabel || env.os} / Shell=${env.shellIdKey}${shells ? ` / 可用=${shells}` : ''} / 大小写=${env.caseSensitive === false ? '不敏感' : '敏感'} / 编码=${env.encoding || '-'} / 检测于 ${fmtTime(Date.now())}`
    // 命令语法行：同一台机器上 grep/sed/find 是 GNU 还是 BSD，决定 `-P`、`-i` 能不能那样写。
    // 这是"写命令前就该知道"的事，等被拦一次再说太晚——所以直接摆在【一】里给模型看。
    const cmdText = Object.entries(env.commands || {})
      .map(([k, v]) => `${k}=${v.impl}${v.version ? ' ' + v.version : ''}`)
      .join(' / ')
    const engineRows = [envRow, ...(cmdText ? [`- 命令语法：${cmdText}`] : [])]
    // 只换引擎自己写的那一行，不整段重写【一】。原先是 `[\s\S]*?` 一路吃到下一个标题，
    // 人类在【一】里补的注（"本机 rg 在 D:\tools" 之类）每次会话启动都被抹掉——与 2026-11-01
    // 红队 A3 修【三】【四】是同一类病，当时漏了【一】。判据：引擎只拥有它写的那几行。
    t = t.replace(/(### 【一】[^\n]*\n)([\s\S]*?)(?=\n### |\n## |$)/, (_m, head, body) => {
      const kept = body
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => {
          const s = line.trim()
          if (!s) return false
          if (/^-\s*OS=/.test(s)) return false // 上一次的检测行，由本次覆盖
          if (/^-\s*命令语法[:：]/.test(s)) return false // 同上：引擎自己的行，由本次覆盖
          if (/^（.*）$/.test(s)) return false // 模板占位语，检测行到位后就没有意义
          return true
        })
      return `${head}\n${[...engineRows, ...kept].join('\n')}\n`
    })
    const tmp = cp + '.' + process.pid + '.tmp'
    writeFileSync(tmp, t)
    renameSync(tmp, cp)
  } catch {
    noteFail(sid, '卷宗【一】环境声明落卷')
  }
}

/** 36条 异地交叉巡视：新会话接手 → 复核前任结论。 */
function inspectHandover(sid, projDir) {
  try {
    readFileSync(join(projDir, 'HANDOFF.md'), 'utf8')
    auditRow(sid, 'handover-inspect', '36条 交叉巡视：发现 HANDOFF.md')
  } catch {
    /* 无 HANDOFF 属正常 */
  }
}

/**
 * 42条 部署版本核验：运行引擎 vs 工作区源码。
 *
 * ⚠ 排除 `packages/core/hooks/guard.mjs`——它是**封存版、版本号独立**（header 写明不随 FG 主版本更新，
 * 见 HANDOFF §九）。拿它的 v 号与 ENGINE_VERSION 比较会**每次会话误报部署漂移**（2026-10-10 实测）。
 * 2026-10-18 销旧账：原实现写 `for (const rel of [...候选, ...SEALED])`，把封存版**拼进了**比对列表
 * ——语义正好反了（本意是排除，实际是加入）。而前两个候选在仓库根并不存在（catch 后试下一个），
 * 于是必然命中封存版、必然失配，每次会话一条假警报（实测 evidence：
 * `42条 引擎 v3.0.6 vs 源码 v3.0.4 (packages/core/hooks/guard.mjs)`）。
 * 正确语义：候选里可以列出封存版（记录"它存在但被豁免"），**命中 SEALED 一律跳过**。
 */
function checkVersionDrift(sid, projDir) {
  for (const rel of VERSION_CANDIDATES) {
    if (SEALED.has(rel)) continue
    try {
      const m = readFileSync(join(projDir, rel), 'utf8').slice(0, 400).match(/v(\d+\.\d+\.\d+)/)
      if (m && m[1] !== ENGINE_VERSION) {
        auditRow(sid, 'version-check', `42条 引擎 v${ENGINE_VERSION} vs 源码 v${m[1]} (${rel})`)
      }
      break
    } catch {
      /* 该路径不存在，试下一个 */
    }
  }
}
