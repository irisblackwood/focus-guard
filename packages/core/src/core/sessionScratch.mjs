/**
 * 会话级内存态（session scratch）—— 按 sessionId 分表的临时数据，进程内有效、不落盘。
 *
 * ── 为什么集中（2026-10-29 重构）──────────────────────────────────────
 * 原来三个容器散在两个文件里，各自 `new Map()` / `new Set()`：
 *   guard/evidence.mjs  `nativeReadSet`（sid → Set<path>）
 *   guard/evidence.mjs  `evidenceBlockedOnce`（sid → Set<path>）
 *   guard/wholeFile.mjs `remindedNoBackend`（Set<sid>）
 * 各自能跑，但**没有统一生命周期**，代价有三层：
 *
 *   ① 测试无法重置 —— 同一 sessionId 跑第二次就串味。实测基准里固定会话后
 *      准确率从 100% 掉到 94%，9 个用例被上一轮的内存态带偏，而没有任何 API 能清。
 *   ② 变异测试杀不死记账分支 —— 测试只断言"吐出的 reason"，不断言 readSet 记账，
 *      因为断言之前没法把状态摆回已知起点（`ARCH-MAP.md` 缺口 #7 的存活分析）。
 *   ③ 长驻进程只增不减 —— DSH 单进程多会话，会话结束后这些表没人清。
 *
 * ── 设计取舍 ────────────────────────────────────────────────────────
 * 只做「按会话分表 + 能清」这一件事，不引入 TTL、不自动过期：
 * 过期需要时钟，时钟会让测试变成"有时序的测试"，比现在更难写。
 * 内存上限用**插入序剪枝**（`MAX_SESSIONS`）兜底，不靠调度。
 */

/** 每个表最多保留多少个会话的 scratch；超出按插入序删最旧。 */
const MAX_SESSIONS = 200

/** name → { kind: 'set' | 'flag', data: Map<sid, Set|true> } */
const REGISTRY = new Map()

function tableOf(name, kind) {
  let t = REGISTRY.get(name)
  if (!t) {
    t = { kind, data: new Map() }
    REGISTRY.set(name, t)
  }
  return t
}

/** 插入序剪枝：Map 保持插入序，删最早的。 */
function trim(t) {
  while (t.data.size > MAX_SESSIONS) {
    const oldest = t.data.keys().next().value
    t.data.delete(oldest)
  }
}

/**
 * 每会话一个 `Set<T>`（如「本会话读过的路径」）。
 *
 * 用法与原 `Map<sid, Set>` 一致，但取集合改走 `of(sid)`：
 *   const readSet = sessionSet('nativeReadSet')
 *   readSet.of(sid).add(path)
 *
 * @param {string} name 表名（同名返回同一张表）
 */
export function sessionSet(name) {
  const t = tableOf(name, 'set')
  return {
    /** 取该会话的集合，不存在则建。 */
    of(sid) {
      let s = t.data.get(sid)
      if (!s) {
        s = new Set()
        t.data.set(sid, s)
        trim(t)
      }
      return s
    },
    has(sid, item) {
      return t.data.get(sid)?.has(item) || false
    },
    add(sid, item) {
      this.of(sid).add(item)
    },
    /** 该会话有几个条目（测试断言记账是否发生用）。 */
    sizeOf(sid) {
      return t.data.get(sid)?.size || 0
    },
    clear(sid) {
      return t.data.delete(sid)
    },
    clearAll() {
      t.data.clear()
    },
    /** 当前表里有多少个会话（测试与自检用）。 */
    sessions() {
      return t.data.size
    },
  }
}

/**
 * 每会话一个「已做过某事」标记（如「已提醒过没装检索工具」）。
 *
 * @param {string} name 表名
 */
export function sessionFlag(name) {
  const t = tableOf(name, 'flag')
  return {
    has(sid) {
      return t.data.has(sid)
    },
    add(sid) {
      t.data.set(sid, true)
      trim(t)
    },
    clear(sid) {
      return t.data.delete(sid)
    },
    clearAll() {
      t.data.clear()
    },
    sessions() {
      return t.data.size
    },
  }
}

/**
 * 清掉某会话在**所有**表里的 scratch。
 *
 * 这是本模块存在的核心理由：测试里一行就能把状态摆回已知起点，
 * 不必逐个模块 import 各自的 clear 函数（以前根本没有）。
 *
 * @param {string} sid 会话标识
 * @returns {number} 清掉的表数
 */
export function clearSession(sid) {
  let n = 0
  for (const t of REGISTRY.values()) {
    if (t.data.delete(sid)) n += 1
  }
  return n
}

/** 清空全部会话的全部 scratch（测试用；生产不调用）。 */
export function clearAllSessions() {
  for (const t of REGISTRY.values()) t.data.clear()
}

/** 只读快照：每张表有几个会话（自检/调试用）。 */
export function scratchStats() {
  const out = {}
  for (const [name, t] of REGISTRY) out[name] = t.data.size
  return out
}

export const SCRATCH_MAX_SESSIONS = MAX_SESSIONS
