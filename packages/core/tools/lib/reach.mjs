/**
 * 可达闭包（tools/lib/reach.mjs，2026-11-02）。
 *
 * 为什么抽出来：同一段 BFS 在 `health-core.mjs` 与 `import-graph.mjs` 各有一份，
 * 逐字相同 12 行。`smells` 的重复块棘轮正是盯这个——两份实现必然分叉，
 * 本仓已经栽过一次（`stripLiterals` 各写一份，其中一份漏了正则字面量）。
 *
 * 语义只有一句话：从若干**种子**出发，沿依赖边反向（`depsOf` 给出的方向）走，
 * 只收集落在 `srcSet` 里的文件。种子自己不算——种子是测试文件，我们问的是"它够到哪些源码"。
 *
 * @param {Set<string>} srcSet  允许被收集的集合（源码文件）
 * @param {string[]} seeds      起点（测试文件或其它入口）
 * @param {(f: string) => string[]} depsOf 依赖展开
 * @returns {Set<string>}
 */
export function reachClosure(srcSet, seeds, depsOf) {
  const reached = new Set()
  const queue = []
  const push = (f) => {
    if (srcSet.has(f) && !reached.has(f)) {
      reached.add(f)
      queue.push(f)
    }
  }
  for (const s of seeds) for (const d of depsOf(s)) push(d)
  while (queue.length) for (const d of depsOf(queue.pop())) push(d)
  return reached
}
