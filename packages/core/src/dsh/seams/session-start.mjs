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
import {
  statePath,
  loadState,
  saveState,
  casePath,
  ensureCaseFile,
  loadCaseRecords,
} from '../../core/state.mjs'
import { noteFail } from '../../core/audit.mjs'
import { detectEnv, quickShellId } from '../../core/env.mjs'
import { ENGINE_VERSION } from '../../core/constants.mjs'
import { sidOf, projDirOf, isSubagent, auditRow } from './shared.mjs'

/** 42条 版本核验的候选清单（封存版单列，命中即豁免——见下方 checkVersionDrift 注释）。 */
const SEALED = new Set(['packages/core/hooks/guard.mjs'])
const VERSION_CANDIDATES = ['hooks/guard.mjs', 'focus-guard/hooks/guard.mjs', 'packages/core/hooks/guard.mjs']

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
 * 本宿主应当使用的执行体标识：DSH 的 shell 工具执行体由宿主固定（win32 上是 pwsh），
 * 不由用户 shell 会话决定——所以这里直接给出期望值，不靠 quickShellId 猜。
 */
function expectedShellId() {
  return process.platform === 'win32' ? 'powershell' : quickShellId()
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
 * 在 DSH 路径上它不是缺口——插件是常驻进程，执行体由宿主配置（cordis.patch.yml 的
 * pwshPath）在启动时固定，回合之间不会变。需要每进程重检的是封存版 `guard.mjs`
 * （每次调用都是新进程，SHELL 可能不同），那条路本来就有。
 */
function detectEnvInto(state, projDir) {
  // 2026-10-18：DSH 的 shell 工具执行体是 pwsh（cordis.patch.yml 的 pwshPath），
  // 但 Node 进程自身的 ComSpec 是 cmd —— 不显式声明就会把执行体记成 cmd。
  // 用参数传，不写环境变量（否则会被子进程继承，污染测试）。
  const cached = state.envCache
  if (cached && cached.os === process.platform && cached.shellIdKey === expectedShellId()) return
  try {
    state.envCache = detectEnv(projDir, process.platform === 'win32' ? { shell: 'powershell' } : {})
  } catch {
    /* 环境检测失败不阻断 */
  }
}

/** 2.0~42条：卷宗载入 + 环境声明落卷 + 交叉巡视 + 部署版本核验。 */
function prepareProject({ sid, projDir, state }) {
  loadCaseInto(state, sid, projDir)
  writeEnvDeclaration(state, sid, projDir)
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
    const envRow = `- OS=${env.os} / Shell=${env.shellIdKey} / 大小写=${env.caseSensitive === false ? '不敏感' : '敏感'} / 编码=${env.encoding || '-'} / 检测于 ${new Date().toISOString()}`
    t = t.replace(/### 【一】[\s\S]*?(?=\n### |\n## |$)/, () => `### 【一】环境声明（会话级检测，全程复用）\n\n${envRow}\n`)
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
