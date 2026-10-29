/**
 * 工具 schema 漂移判定（2026-10-29）——纯函数，不读文件、不打印。
 *
 * 病根：原 `tools/schema-fingerprint.mjs` 只有两档——「hash 相等 = PASS」和「不等 = 漂移」。
 * 于是「整批工具因为某个 MCP 服务器没连上而消失」被当成 schema 漂移，红得没有信息量；
 * 而基线缺 `tools_map` 时连 diff 都算不出，只剩一句「无法判断」。
 *
 * 本模块把判定拆成五种结局，让「少了一大批」和「改了几个参数」分开报：
 *   match · suspect-plugin-gone · unknown-baseline · environment-switch · drift
 *
 * 分层纪律：这里只做判定（母版层），读会话、打印、退出码都留在 `tools/schema-fingerprint.mjs`。
 */

/**
 * `mcp__<server>__<tool>` → server 名；非 MCP 工具返回 ''。
 * server 名可以带横杠（`cities2-mcp`），所以按「第一个 `__` 之后到下一个 `__`」截。
 */
export function serverOf(name) {
  const m = /^mcp__(.+?)__/.exec(String(name || ''))
  return m ? m[1] : ''
}

/** 工具名列表 → `Map<server, count>`（只统计 MCP 工具）。 */
export function groupByServer(names = []) {
  const map = new Map()
  for (const n of names) {
    const server = serverOf(n)
    if (!server) continue
    map.set(server, (map.get(server) || 0) + 1)
  }
  return map
}

/** Map → 按数量降序的 `[[server, count]]`。 */
export function topServers(map, limit = 5) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
}

/**
 * 消失的工具里，是否有一批同源（同一个 MCP 服务器）占绝对多数。
 *
 * 判据（两个都要满足）：
 *   · 该服务器消失数 ≥ `minCount`——太少了说明不了什么，可能是零星改名；
 *   · 占全部消失数的比例 ≥ `share`——散落在多个服务器上就是真漂移。
 *
 * @returns {{server: string, count: number, share: number} | null}
 */
export function suspectPluginGone({ removed = [], minCount = 10, share = 0.8 } = {}) {
  if (!removed.length) return null
  const [entry] = topServers(groupByServer(removed), 1)
  if (!entry) return null
  const [server, count] = entry
  const ratio = count / removed.length
  if (count < minCount || ratio < share) return null
  return { server, count, share: ratio }
}

/**
 * 判定漂移结局。
 *
 * @param {{
 *   baseHash?: string, baseTools?: number, baseNames?: string[],
 *   curHash: string, curNames: string[],
 *   ratioThreshold?: number, minCount?: number, share?: number
 * }} p
 * @returns {{
 *   kind: 'match'|'suspect-plugin-gone'|'unknown-baseline'|'environment-switch'|'drift',
 *   added: string[], removed: string[], overlap: number,
 *   ratio: number, server?: string, serverCount?: number, servers: [string, number][]
 * }}
 */
export function judgeDrift({
  baseHash,
  baseTools = 0,
  baseNames = [],
  curHash,
  curNames = [],
  ratioThreshold = 0.6,
  minCount = 10,
  share = 0.8,
} = {}) {
  const cur = [...curNames]
  const base = [...baseNames]
  const servers = topServers(groupByServer(cur))
  const ratio = baseTools ? cur.length / baseTools : 1

  if (baseHash && curHash && baseHash === curHash) {
    return { kind: 'match', added: [], removed: [], overlap: cur.length, ratio, servers }
  }

  // 存量基线没有工具名表（2026-10-22 之前 `--update` 把它剥掉了）：算不出 diff，
  // 但数量比还能区分「少了一大批」和「基本没动」。这不是精确判断，所以要如实标注。
  if (!base.length) {
    if (baseTools > 0 && ratio < ratioThreshold) {
      return { kind: 'suspect-plugin-gone', added: [], removed: [], overlap: 0, ratio, servers }
    }
    return { kind: 'unknown-baseline', added: [], removed: [], overlap: 0, ratio, servers }
  }

  const added = cur.filter((n) => !base.includes(n))
  const removed = base.filter((n) => !cur.includes(n))
  const overlap = cur.length - added.length

  // 换宿主/换 profile：整批不同，交集为零。真漂移永远是「大部分还在、个别增删」。
  if (overlap === 0) {
    return { kind: 'environment-switch', added, removed, overlap, ratio, servers }
  }

  const gone = suspectPluginGone({ removed, minCount, share })
  if (gone) {
    return {
      kind: 'suspect-plugin-gone',
      added,
      removed,
      overlap,
      ratio,
      servers,
      server: gone.server,
      serverCount: gone.count,
      share: gone.share,
    }
  }

  return { kind: 'drift', added, removed, overlap, ratio, servers }
}
