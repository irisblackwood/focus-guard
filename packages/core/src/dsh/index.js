/**
 * focus-guard 原生 Cordis 插件 · 薄装配层（3.0.5）
 *
 * 职责只余 name + apply：把 pipeline.mjs 的三缝监听注册到宿主 ctx。
 *   判定流水线 → ./pipeline.mjs（pre-execute 拦截 / system-prompt 成本提示 / post-execute 台账）
 *   卷宗写入   → ./audit.mjs（AUDIT.log 留痕 / CASE_FILE 成本台账）
 *   价目与峰谷 → ../peak-cost.mjs（官方 2026-09-10 价目，核对底稿见 docs/deepseek-pricing-audit.md）
 *
 * fail-open 纪律：任一缝注册失败只降级该缝，绝不阻塞 DSH 主流程；
 * 拆薄前的单文件实现备份于 .ai/backup/index.js.bak-20261007-peakcost。
 */

import { postExecuteListener, preExecuteListener, systemPromptListener } from './pipeline.mjs'
import { preStepListener, sessionStartListener, systemPromptRulesListener, turnStoppingListener } from './seams.mjs'
import { postProgressListener } from './postProgress.mjs'
import { stopGuardListener } from './stopGuard.mjs'
import { preGuardListener } from './preGuard.mjs'
import { announceWatchReady, compactionEventListener, contextOverflowListener } from './compactionWatch.mjs'
// 2026-10-27：两行 import 同一模块（ESLint no-duplicate-imports 命中），已合并。
import { startHeartbeat, degradedModules, livenessBadge, markModule } from './heartbeat.mjs'
import { readWorkspace, recordWorkspaceTurn, renderWorkspaceSection } from './workspace.mjs'
import { augmentDeny } from './repeatGuard.mjs'
import { registerGateTools } from './tools.mjs'
import { setProjectDirProvider } from '../core/audit.mjs'
// 熔断告知（2026-10-27）：文案在母版，宿主缝只决定"何时注入"。
import { FUSE_NOTICE } from '../core/constants.mjs'
import { loadState, statePath } from '../core/state.mjs'
import { createPrefixTracker, describeShift } from '../core/prefixStability.mjs'
import { appendAudit, buildAuditRow } from '../core/audit-writer.mjs'

// 分层纪律（2026-10-22）：项目目录由宿主层注入；DSH 侧用中立变量 FG_PROJECT_DIR，
// 母版 `core/audit.mjs` 不再读 ZCODE_/CLAUDE_（那是替别的宿主代言）。
setProjectDirProvider(() => process.env.FG_PROJECT_DIR || '')
import { installTraceMeta, recordFuseWaste } from './traceMeta.mjs'

/**
 * 前缀抖动跟踪（2026-10-29）
 *
 * 缓存命中要前缀逐字节相同。实测（`tools/prefix-drift.mjs`）四个真实会话里
 * `tools` / `user` 段全程 1 个版本，`system` 段却 2 个版本、分歧点恒定落在 FG 自己的
 * `[FG-WORKSPACE]` 段。修内容是一半，**能测出来**是另一半——
 * 否则下次谁再往注入里塞易变内容，还是没人知道。
 *
 * 只比 `focus-guard-*` 段，且只比同一会话内：换会话本来就会变，拿它报警等于报假阳性。
 */
const prefixTracker = createPrefixTracker({
  audit: ({ sid, diff }) => {
    appendAudit(
      buildAuditRow(sid, 'prompt-prefix-shift', {
        trigger: 'system-prompt/assemble',
        evidence: describeShift(diff),
      }),
    )
  },
})

function notePrefixShift(context, downstream, extra) {
  const header = context && context.agent && context.agent.session ? context.agent.session.header : null
  const sid = header ? header.id : null
  if (!sid) return null
  return prefixTracker.note(sid, [...((downstream && downstream.sections) || []), ...(extra || [])])
}

// 导出给测试：接线本身（2 条 assemble 监听 + 这个函数）必须能被单独验证，
// 否则"审计会不会真的写"只能靠跑真宿主才知道。
export { notePrefixShift, prefixTracker }

export const name = 'focus-guard'
// 2026-10-18：`ctx.tools` 是 Cordis 服务，未声明 inject 就访问会抛
// `cannot get property "tools" without inject` —— 这正是 fg_apply/fg_appeal
// 注册失败的真实原因（此前只写进 warn，模块自检里看不到）。
export const inject = ['tools']

export function apply(ctx) {
  // 2026-10-18：执行体声明改为**参数传递**（见 seams.mjs 的 detectEnv 调用），
  // 不再写 process.env.FG_SHELL —— 宿主进程设的环境变量会被子进程（含 npm test）继承，
  // 实测直接打红 4 条环境检测用例。
  const warn = (...parts) => {
    console.warn('[focus-guard-native]', ...parts)
    if (ctx && typeof ctx.logger?.warn === 'function') ctx.logger.warn(...parts)
  }
  const register = (event, factory, label) => {
    try {
      ctx.on(event, factory({ warn }))
      markModule(label, true)
    } catch (error) {
      markModule(label, false, (error && error.message) || error)
      warn(label + ' 注册失败（不影响其他缝）：', (error && error.message) || error)
    }
  }

  // 按需自证（Lazy Liveness，2026-10-19）：存活状态只在这一刻对模型可见——
  // 判定返回 deny/ask 时，给理由补一个 `[FG 存活 n/m]` 徽标（异常时带降级模块名）。
  // 其余时候（放行、正常回合）零注入：心跳只写 status.json。
  // 2026-10-22（人类反馈"工作流没做好"）：再叠一层「重复被拦」改写——同一条调用第 2 次被拒时，
  // 理由改成"重试无效 + 该换哪条路"，抑制实测中"拦了还重试"多出来的 step。
  const withLivenessBadge = (factory) => (opts) => {
    const base = factory(opts)
    return async (exec, next) => {
      let decision = await base(exec, next)
      if (decision && decision.kind === 'deny') {
        try {
          decision = augmentDeny(exec, decision, warn)
        } catch (error) {
          warn('重复被拦改写失败（不影响判定）：', (error && error.message) || error)
        }
      }
      if (decision && (decision.kind === 'deny' || decision.kind === 'ask')) {
        const reason = String(decision.reason || '')
        if (!reason.includes('[FG 存活')) return { ...decision, reason: `${reason} ${livenessBadge()}` }
      }
      return decision
    }
  }

  // 2026-10-19 人类批示：AUDIT.log 补 turn/step 元数据（熔断浪费按会话独立计数）。
  // 位置只有 `agent/pre-step` 拿得到，注册 provider 后所有审计行自动带 turn/step；
  // 回合结束时由 recordFuseWaste 结算"熔断后步数"。失败只降级可观测性，不影响执法缝。
  try {
    installTraceMeta()
  } catch (error) {
    warn('位置元数据装配失败（审计仍写，只是没有 turn/step）:', (error && error.message) || error)
  }

  register('tools/pre-execute', withLivenessBadge(preExecuteListener), 'tools/pre-execute')
  // 3.0.8 移植批 5：结构性执法（图书馆隔离/环境规则/大小写冲突/子代理闸/熔断白名单/L2·L5）
  register('tools/pre-execute', withLivenessBadge(preGuardListener), 'tools/pre-execute(structural)')
  register('system-prompt/assemble', systemPromptListener, 'system-prompt/assemble')
  // 3.0.8 移植批 4：常驻规则注入（guard.mjs 的 SESSION_RULES，原文走 stdout，原生改走注入缝）
  // 2026-10-18：再包一层——启动自检缺模块时追加 `focus-guard-degraded` 段，让模型自己也看得见。
  register(
    'system-prompt/assemble',
    (opts) => {
      const base = systemPromptRulesListener(opts)
      return async (assembly, context, next) => {
        const downstream = await base(assembly, context, next)
        if (!downstream || !Array.isArray(downstream.sections)) return downstream
        /** @type {{name: string, text: string}[]} */
        const extra = []
        // 2026-10-19 按需自证：存活状态不再进系统提示（原 focus-guard-degraded 段已移除）。
        // 需要知道 FG 是否在场时，看拦截理由 / fg_apply 返回里的 `[FG 存活 n/m]` 徽标。
        // L4 跨会话卷宗（2026-10-18）+ 快速交接（2026-10-22）：只有 workspace_hash 与当前路径一致才注入；
        // 路径改变 → readWorkspace 返回 null → 一条都不加（DCR 的病根就是没这条）。
        // 交接快照行只在"换会话"时出现（同一会话里重复自己的快照是噪音）。
        try {
          const header =
            context && context.agent && context.agent.session ? context.agent.session.header : null
          const cwd = header ? header.cwd : null
          const sid = header ? header.id : null
          const section = renderWorkspaceSection(readWorkspace(cwd), { sid })
          if (section) extra.push({ name: 'focus-guard-workspace', text: section })
          // 熔断告知（2026-10-27）：熔断此前只写 warn（日志），模型完全看不见——
          // 实测 turn 128 熔断后仍白走 16 步只读探索。这里在熔断期间追加固定文案，
          // 让模型在下一次请求就知道该收尾。文案固定 → 前缀只变一次，不会每步抖动。
          if (sid) {
            const st = loadState(statePath(sid))
            if (st && st.fused) extra.push({ name: 'focus-guard-fuse', text: FUSE_NOTICE })
          }
        } catch {
          /* fail-open：卷宗读取失败不影响系统提示 */
        }
        // 前缀稳定性（2026-10-29）：装配完算一次 FG 段指纹，同一会话内变了就留一条审计。
        // 只观测，不改任何段——段内容由上面决定，这里只负责"抖了要说出来"。
        try {
          notePrefixShift(context, downstream, extra)
        } catch {
          /* 指纹失败不影响装配 */
        }
        if (!extra.length) return downstream
        return { ...downstream, sections: [...downstream.sections, ...extra] }
      }
    },
    'system-prompt/assemble(rules)',
  )
  register('tools/post-execute', postExecuteListener, 'tools/post-execute')
  // 3.0.8 移植批 3：进度检测 / 三预算池 / 污染检测 / 委派 KPI / 抽查（与上条同事件并列监听）
  register('tools/post-execute', postProgressListener, 'tools/post-execute(progress)')
  // 3.0.8：补上 guard.mjs 六缝中 DSH 侧缺失的三条。映射照官方桥
  //（@deepseek-ai/dsh-hooks-claude-code）的实测代码，不是猜测。
  register('agent/created', sessionStartListener, 'agent/created')
  // 策略可达性自检（2026-10-24）：用当前会话真实工具 schema 校验判定里引用的参数键，
  // 报警式（warn + 审计），不改变任何判定。只跑一次，失败 sink 到 warn。
  register(
    'agent/created',
    () => async (payload, next) => {
      try {
        const tools = ctx.tools && typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas() : []
        const { runPolicyAudit } = await import('./policy-audit.mjs')
        const { ghost, reachable, scanned } = runPolicyAudit({
          schemas: tools,
          files: [new URL('./pipeline.mjs', import.meta.url).pathname, new URL('./preGuard.mjs', import.meta.url).pathname],
          ignore: ['cmd', 'script', 'pages', 'head_limit', 'output_mode'],
        })
        if (ghost.length) {
          warn(`策略可达性自检：${ghost.length}/${scanned} 个参数键在真实 schema 里不存在（规则可能永不触发）——` +
            ghost.map((g) => g.key).join('、'))
        } else if (scanned > 0) {
          warn(`策略可达性自检：${scanned} 个参数键全部可达（工具 ${tools.length} 个）`)
        }
        void reachable
      } catch (error) {
        warn('策略可达性自检失败（不影响执法）：', (error && error.message) || error)
      }
      return typeof next === 'function' ? next(payload) : undefined
    },
    'agent/created(policy-audit)',
  )
  // 钩子顺序自检（2026-10-29）：Cordis 的 waterfall 按注册顺序派发，互不相关的插件之间
  // 顺序不确定。**不能**用 @zfdx123/dsh-hooks-ordering 的 participant 接口解决——它的
  // runPhase 丢弃返回值，而 FG 的拦截正是靠 `return {kind:'deny'}`（实测见 docs/HOOK-ORDERING.md）。
  // 这里只观测：协调器在不在、FG 在不在参与者列表里。只报不改，与 policy-audit 同纪律。
  register(
    'agent/created',
    () => async (payload, next) => {
      try {
        const { probeHookOrdering } = await import('./hookOrder.mjs')
        const verdict = probeHookOrdering(ctx)
        warn(`钩子顺序[${verdict.state}]：${verdict.message}`)
      } catch (error) {
        warn('钩子顺序自检失败（不影响执法）：', (error && error.message) || error)
      }
      return typeof next === 'function' ? next(payload) : undefined
    },
    'agent/created(hook-order)',
  )
  // 工具类别覆盖自检（2026-10-29）：装了插件却没在适配层登记语义类别 → 熔断期被误拒、
  // 且调用算执行池而不是侦查池。只报 MCP 前缀（内置工具的欠账由 tool-kinds.mjs 自己补），
  // 只 warn 不改判定，与 policy-audit / hook-order 同纪律。
  register(
    'agent/created',
    () => async (payload, next) => {
      try {
        const tools = ctx.tools && typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas() : []
        const { auditToolKinds, renderToolKindNotice } = await import('./toolKindAudit.mjs')
        const notice = renderToolKindNotice(auditToolKinds({ schemas: tools }))
        if (notice) warn(notice)
      } catch (error) {
        warn('工具类别自检失败（不影响执法）：', (error && error.message) || error)
      }
      return typeof next === 'function' ? next(payload) : undefined
    },
    'agent/created(tool-kinds)',
  )
  register('agent/pre-step', preStepListener, 'agent/pre-step')
  // 回合结束自动落账（L4，2026-10-18）：只记 FG 亲眼看到的事实（人类指令 / 被人否决的命令），
  // 不推断、不编造；写失败只 warn。与 DCR 不同：这里不 cancel、不 reject、不碰 surface。
  register(
    'agent/turn-stopping',
    (opts) => {
      const base = turnStoppingListener(opts)
      return async (payload, ...rest) => {
        const decision = await base(payload, ...rest)
        try {
          recordWorkspaceTurn(payload && payload.agent)
        } catch (error) {
          warn('工作区卷宗写入失败（不阻断回合）:', (error && error.message) || error)
        }
        // 熔断浪费结算（2026-10-19 人类批示，按会话独立计数）：
        // 只在本回合真熔断过时写一行 fuse-waste，正常回合零写入。
        try {
          recordFuseWaste(payload && payload.agent)
        } catch (error) {
          warn('熔断浪费结算失败（不阻断回合）:', (error && error.message) || error)
        }
        return decision
      }
    },
    'agent/turn-stopping',
  )
  // 3.0.8 移植批 4：收尾核验（授权识别 / 熔断声明 / 无锚点）——与上条 KPI 结算并列监听
  register('agent/turn-stopping', stopGuardListener, 'agent/turn-stopping(guard)')

  // 申请/申辩通道（2026-10-18 补洞）：资格闸会拦高危操作，但没有通道时模型只能绕过 DSH。
  // 这两个工具此前从未接线（adapters 里的 defineTool 版本缺 output，一导入就抛）。
  try {
    for (const toolName of registerGateTools(ctx, { warn })) markModule(`tools:${toolName}`, true)
  } catch (error) {
    warn('申请/申辩工具注册失败（资格闸将无通道）：', (error && error.message) || error)
  }

  // 压缩监察（2026-10-18）：DSH 0.2 自带压缩栈（preset 层 compaction-basic +
  // command-compact + tool-result-pruner），FG 不重复实现，只做留痕与看门狗。
  // 详见 compactionWatch.mjs 头部：自建压缩引擎与内置抢跑，正是当日回合被打死的根因。
  register('session/event', compactionEventListener, 'session/event(compaction-watch)')
  register('agent/request-error', contextOverflowListener, 'agent/request-error(compaction-watch)')

  // 心跳（2026-10-18）：每 10s 覆写 .focus-guard/status.json，宿主外由 status.mjs 判存活。
  // 失败只降级本条，不影响上面任何执法缝。
  try {
    const disposeHeartbeat = startHeartbeat({ warn })
    if (typeof ctx.effect === 'function') ctx.effect(() => disposeHeartbeat)
    markModule('heartbeat', true)
  } catch (error) {
    markModule('heartbeat', false, (error && error.message) || error)
    warn('心跳启动失败（不影响执法缝）：', (error && error.message) || error)
  }

  // 启动自检汇总（2026-10-19 按需自证）：缺模块只在宿主日志喊一次。
  // 模型侧**不再常驻注入** FG-DEGRADED 段——改为在"拦截 / fg_apply / 压缩事件"三处附 `livenessBadge()`。
  const missing = degradedModules()
  if (missing.length > 0) {
    warn(`启动自检：${missing.length} 个模块未报到 —— ${missing.join('、')}（不注入 Prompt；将在拦截/申请时附带徽标）`)
  }

  // 启动自证（2026-10-18）：无条件往 AUDIT.log 写一条 compaction-watch-ready / -degraded。
  // 位置必须在此处 —— 两条 register() 与心跳都已跑完，快照才是最终装配结果；
  // 提前调用会漏掉心跳、报出错误的完成度。每进程一次，详见 compactionWatch.mjs 末段。
  announceWatchReady({ warn })
}
