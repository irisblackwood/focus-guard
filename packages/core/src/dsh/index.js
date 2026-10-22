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
import { startHeartbeat } from './heartbeat.mjs'
import { degradedModules, livenessBadge, markModule } from './heartbeat.mjs'
import { readWorkspace, recordWorkspaceTurn, renderWorkspaceSection } from './workspace.mjs'
import { registerGateTools } from './tools.mjs'
import { installTraceMeta, recordFuseWaste } from './traceMeta.mjs'

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
  const withLivenessBadge = (factory) => (opts) => {
    const base = factory(opts)
    return async (exec, next) => {
      const decision = await base(exec, next)
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
        } catch {
          /* fail-open：卷宗读取失败不影响系统提示 */
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
