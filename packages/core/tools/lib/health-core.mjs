/**
 * 健康分的纯逻辑（tools/lib/health-core.mjs，2026-10-27）。
 *
 * 为什么抽出来：`tools/health.mjs` 是个 CLI——它在模块顶层就 spawn 子进程跑 lint/smells/audit，
 * 一 import 就会执行。这种文件**没法被测试**，而本仓已经因为"工具自己没被测"翻过三次车
 * （合成参数假绿、比率分母被操纵、关键词匹配测不出改写采入）。
 * 所以判定逻辑全部搬到这里，CLI 只做"取数 → 调这里 → 打印"。
 *
 * 三个导出都是纯函数：不碰 fs、不 spawn、同输入必同输出。
 */

/**
 * 房规问题按层分栏。
 *
 * 为什么分层：全仓 54 条房规问题全在 `hooks/`（已封存不维护）。把封存代码的债务算进
 * 当前健康分，与 `dsh-code-check` 的 0/100 是同一个病——**扣分项与"当前该修的"不对齐**。
 * 计分只认 src/ 活跃层，其余单列（不藏，只是不计分）。
 */
export function splitLintByLayer(findings) {
  const out = { src: [], tools: [], tests: [], hooks: [] }
  for (const f of findings) {
    const rel = String(f.file || '').replace(/\\/g, '/')
    if (/^packages\/core\/src\//.test(rel)) out.src.push(f)
    else if (/^packages\/core\/tests\//.test(rel)) out.tests.push(f)
    else if (/^packages\/core\/hooks\//.test(rel)) out.hooks.push(f)
    else out.tools.push(f)
  }
  return out
}

/**
 * 可达性分类：src 模块分成三档。
 *
 *   active     从测试可达                → 正常
 *   frozenOnly 只从 hooks/（已封存）可达  → 不扣分，单列
 *   orphan     两组种子都到不了           → 确定没人用，扣分
 *
 * 为什么要区分 frozenOnly（2026-10-27）：`core/approval.mjs` 的四个导出只被
 * `hooks/guard.mjs` 引，原生侧已由 `adapters/dsh/eligibility-gate.mjs` 替代。
 * 它不是"缺测试"，是**只服务封存路径**——给不维护的代码补测试是浪费。
 * 这与"已封存代码的债务不算当前债务"是同一条原则。
 *
 * `depsOf(file)` 由调用方注入（CLI 传 fs 实现，测试传假 Map）。这样这个函数不碰磁盘。
 *
 * @param {{ srcFiles: string[], testSeeds: string[], frozenSeeds: string[], depsOf: (f: string) => string[] }} p
 */
export function classifyReach({ srcFiles, testSeeds, frozenSeeds, depsOf }) {
  const srcSet = new Set(srcFiles)

  const closure = (seeds) => {
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

  const byTests = closure(testSeeds)
  const byFrozen = closure(frozenSeeds)
  const notTested = srcFiles.filter((f) => !byTests.has(f))
  return {
    total: srcFiles.length,
    active: srcFiles.length - notTested.length,
    frozenOnly: notTested.filter((f) => byFrozen.has(f)).sort(),
    orphan: notTested.filter((f) => !byFrozen.has(f)).sort(),
  }
}

/**
 * 加权总分。**不做四舍五入以外的任何平滑**，也不封顶——
 * 每维扣分由调用方自己封顶（扣满 70 为止），总分直接加权求和。
 * 分数难看是故意的：上一轮 brooks-lint 每维封顶 3 条，91 分读起来像"只差 9 分"。
 *
 * @param {{ score: number, weight: number }[]} dims
 */
export function weightedScore(dims) {
  const w = dims.reduce((s, d) => s + d.weight, 0)
  if (Math.abs(w - 1) > 1e-9) throw new Error(`维度权重之和应为 1，实际 ${w}`)
  return Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0))
}

/**
 * 单维得分：100 起扣，**扣到 70 为止**，所以保底 30 分、不归零。
 *
 * 为什么保底不归零：归零会抹掉"这一维已经烂到什么程度"的信息——
 * `dsh-code-check` 打 0/100 之后，没人再关心它到底是 66 条还是 681 条。
 * 保底 30 让"继续变坏"仍有可见的位移，也让总分不被单维拖死。
 *
 * 拆成两个函数是因为「口径」维的罚分是混合的（未交代 ×10 + 重复行 ×5），
 * 不能表达成"条数 × 单一罚分"。`cappedScore` 收总罚分，`dimensionScore` 是它的简写。
 */
export function cappedScore(totalPenalty) {
  return 100 - Math.min(70, totalPenalty)
}

export function dimensionScore(hits, penaltyPerHit) {
  return cappedScore(hits * penaltyPerHit)
}
