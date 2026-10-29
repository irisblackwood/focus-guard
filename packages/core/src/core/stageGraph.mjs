/**
 * 阶段拓扑排序（母版，纯函数，零依赖）
 *
 * 为什么 FG 自己要有这个：`pre-execute` 的顺序此前只存在于**数组的书写位置**里——
 * 想把「红线必须最先」这条意图写下来，只能写注释，而注释不会被测试执行。
 * 挪一行数组，行为就变了，没有任何东西会红。
 *
 * 这里把顺序变成**声明**：每条边都是 `before` / `after` 写出来的，排序结果由约束推出。
 * 于是「顺序对不对」从纪律问题变成断言问题。
 *
 * 设计取舍：
 * - **稳定**：并列时保持输入顺序。没有这条，无约束的图会打乱既有行为——
 *   而 FG 的 9 段里绝大多数并没有强制的先后，只是碰巧那么写的。
 * - **未知目标忽略**：`after: ['某个还没加载的段']` 不施加约束。跨模块声明不能假设对端存在。
 * - **成环响亮失败**：静默取一个顺序，等于让「谁都没想到的顺序」上线。
 */

export class StageCycleError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StageCycleError'
  }
}

/**
 * @typedef {object} Stage
 * @property {string} id 唯一标识，供 before/after 引用
 * @property {Function} [run] 实际执行体；本模块只排序，不调用
 * @property {string[]} [before] 本段必须先于这些 id
 * @property {string[]} [after] 本段必须后于这些 id
 */

/**
 * 稳定拓扑排序。
 *
 * @param {Stage[]} stages 输入顺序即「无约束时的期望顺序」
 * @returns {Stage[]} 排序后的新数组（不修改入参）
 * @throws {StageCycleError} 约束成环时抛出，并点名被阻塞的段
 */
export function orderStages(stages) {
  if (!Array.isArray(stages)) throw new TypeError('orderStages 需要数组')

  const index = new Map()
  for (let i = 0; i < stages.length; i++) {
    const id = stages[i] && stages[i].id
    if (typeof id !== 'string' || !id) throw new TypeError(`第 ${i} 段缺少 id`)
    if (index.has(id)) throw new TypeError(`阶段 id 重复：${id}`)
    index.set(id, i)
  }

  /** @type {Map<string, Set<string>>} from → 必须在其后的 id */
  const out = new Map()
  /** @type {Map<string, number>} */
  const indeg = new Map()
  for (const s of stages) {
    out.set(s.id, new Set())
    indeg.set(s.id, 0)
  }

  const link = (from, to) => {
    if (from === to) return
    if (!index.has(from) || !index.has(to)) return // 未知目标 = 无操作
    const set = out.get(from)
    if (set.has(to)) return
    set.add(to)
    indeg.set(to, indeg.get(to) + 1)
  }

  for (const s of stages) {
    for (const t of s.before || []) link(s.id, t)
    for (const t of s.after || []) link(t, s.id)
  }

  const byInputOrder = (a, b) => index.get(a) - index.get(b)
  const ready = stages.filter((s) => indeg.get(s.id) === 0).map((s) => s.id)
  /** @type {Stage[]} */
  const ordered = []

  while (ready.length) {
    ready.sort(byInputOrder)
    const id = ready.shift()
    ordered.push(stages[index.get(id)])
    for (const to of out.get(id)) {
      const left = indeg.get(to) - 1
      indeg.set(to, left)
      if (left === 0) ready.push(to)
    }
  }

  if (ordered.length !== stages.length) {
    const blocked = stages.filter((s) => indeg.get(s.id) > 0).map((s) => s.id)
    throw new StageCycleError(`阶段约束成环，无法定序：${blocked.join(' → ')}`)
  }
  return ordered
}

/**
 * 只取 id 序列——测试与自检用，避免把执行体拖进断言。
 * @param {Stage[]} stages
 * @returns {string[]}
 */
export function stageIds(stages) {
  return stages.map((s) => s.id)
}
