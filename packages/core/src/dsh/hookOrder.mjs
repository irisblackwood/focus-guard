/**
 * 钩子顺序自检（2026-10-29）
 *
 * 背景：Cordis 的 waterfall 按**注册顺序**派发监听器，而注册顺序由 `inject` 的激活时机
 * 决定——互不相关的插件之间是不确定的。FG 的 `tools/pre-execute` 因此可能被别的护栏
 * 插件抢先或插队。
 *
 * 为什么不用 `@zfdx123/dsh-hooks-ordering` 的 participant 接口来解决：**它不消费返回值**。
 * 协调器的 `runPhase` 是 `for (const e of topoSort(entries)) await e.run(...payload)`，
 * 返回值被丢弃，而 FG 的拦截正是靠 `return {kind:'deny'}`。接上去的后果是
 * 「plan() 显示排第一，实际一次都没拦住」——比不装更糟。完整核查（四条路与各自的代价）见
 * `packages/core/docs/HOOK-ORDERING.md`；实测数据（真包 1.0.15 + 最小 ctx：FG 排第一、
 * run 返回 deny，派发结果仍是 HOST-DEFAULT）见 CHANGELOG 里「FG 自己做定序者」那条。
 *
 * 所以这里只做**观测**：探测协调器在不在、FG 在不在参与者列表里，如实报出去。
 * 与 `policy-audit.mjs` 同纪律：只报不改，不改任何判定。
 */

/** 值得盯的钩子：FG 在这些钩子上有监听器，顺序影响可观测性 */
export const WATCHED = ['tools/pre-execute', 'system-prompt/assemble', 'tools/post-execute']

/** FG 在协调器里注册时应该用的名字（如果将来真的接入） */
export const SELF_NAME = 'focus-guard'

/**
 * 三态判定（纯函数，可测）。
 *
 * @param {object} input
 * @param {boolean} input.hasService 协调器服务是否存在
 * @param {Record<string, {front: string[], back: string[]} | null>} [input.plans]
 *        `plan(hook, phase)` 的结果；拿不到时为 `null`
 * @returns {{state: 'uncontrolled'|'controlled-not-participant'|'participant', hooks: string[], message: string}}
 */
export function judgeOrdering({ hasService, plans = {} }) {
  if (!hasService) {
    return {
      state: 'uncontrolled',
      hooks: [],
      message:
        '未检测到 hooks-ordering：pre-execute 顺序由插件注册时机决定（Cordis 按数组位置派发）。' +
        'FG 的拦截不依赖先后（拦截单调），但「谁先拦 / 谁记的账」不可控。',
    }
  }

  const where = []
  for (const hook of WATCHED) {
    const plan = plans[hook]
    if (!plan) continue
    const front = Array.isArray(plan.front) ? plan.front : []
    const back = Array.isArray(plan.back) ? plan.back : []
    if (front.includes(SELF_NAME)) where.push(`${hook}:front#${front.indexOf(SELF_NAME) + 1}`)
    if (back.includes(SELF_NAME)) where.push(`${hook}:back#${back.indexOf(SELF_NAME) + 1}`)
  }

  if (where.length) {
    return {
      state: 'participant',
      hooks: where,
      // 正常情况下不该出现：waterfall 参与者无法承载 deny，FG 若出现在这里说明有人接错了
      message:
        `FG 出现在 hooks-ordering 的参与者列表（${where.join('、')}）——` +
        'waterfall 参与者的返回值会被协调器丢弃，FG 的 deny 不会生效（实测：runPhase 的 for-of 丢弃返回值，只有 serial 那条有 isBailed）。',
    }
  }

  return {
    state: 'controlled-not-participant',
    hooks: [],
    message:
      'hooks-ordering 已接管但 FG 未接入参与者（这是预期状态：waterfall 参与者承载不了 deny）。' +
      '其他插件的先后由协调器拓扑排序决定，FG 仍在原生链上按注册位置派发。',
  }
}

/**
 * 从 Cordis ctx 上探测。任何异常都降级为 `uncontrolled`——自检失败不能影响执法缝。
 *
 * @param {object} ctx Cordis 上下文
 * @returns {ReturnType<typeof judgeOrdering>}
 */
export function probeHookOrdering(ctx) {
  let service = null
  try {
    service = ctx && typeof ctx.get === 'function' ? ctx.get('hooksOrdering') : null
  } catch {
    service = null
  }
  if (!service || typeof service.plan !== 'function') return judgeOrdering({ hasService: false })

  /** @type {Record<string, {front: string[], back: string[]} | null>} */
  const plans = {}
  for (const hook of WATCHED) {
    try {
      plans[hook] = { front: service.plan(hook, 'front'), back: service.plan(hook, 'back') }
    } catch {
      // 未被该协调器控制的钩子会抛 HookControlError；那是正常情况，不是失败
      plans[hook] = null
    }
  }
  return judgeOrdering({ hasService: true, plans })
}
