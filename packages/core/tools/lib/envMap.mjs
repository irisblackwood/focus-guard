/**
 * 环境指纹的 `map` 表：只保留**替代品真实存在**的条目。
 *
 * 病根（2026-11-07）：原实现是 `map: { ...MAP }`——无条件写全 5 条。
 * 没装 `bat` 的机器上照样生成 `cat → bat`，于是第 1.5 层拒绝 `cat`，并建议一个
 * 不存在的命令。拦得对（确实该换工具），但替代品是空的——这是**假阳性的生成器**。
 * 当时 `missingAlt` 只打印警告、不改表，警告与行为正好相反。
 *
 * 为什么抽成纯函数：判据要能单独被测量。生成器本体要探测真实工具，测它就得伪造 PATH，
 * 而"按可用性裁剪"这件事本身与探测无关，不该绑在子进程上。
 */

/**
 * @param {Record<string,string>} map 候选替代表（原命令 → 更好的替代品）
 * @param {string[]} available 本机探测到可用的工具名
 * @returns {Record<string,string>} 只含替代品可用的条目
 */
export function buildEnvMap(map, available) {
  const have = new Set(available)
  const out = {}
  for (const [from, to] of Object.entries(map)) if (have.has(to)) out[from] = to
  return out
}

/** 被剔除的条目，形如 `cat→bat`；用于生成器提示「本机没有更好的替代品」。 */
export function droppedAlternatives(map, available) {
  const have = new Set(available)
  return Object.entries(map)
    .filter(([, to]) => !have.has(to))
    .map(([from, to]) => `${from}→${to}`)
}
