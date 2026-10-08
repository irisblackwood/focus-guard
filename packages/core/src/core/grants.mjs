// FocusGuard 母版层 · 授权表（资格审核的独立状态源）
//
// 纪律（领导 2026-10-08 批）：
//   grants 是 FG 自己的状态，**不塞进 guard.mjs 的 state** —— 否则两套状态源会在第 3 层
//   校验时分叉。持久化目标是 FG 自己的状态文件（第五步实现）。
// 本步（第一步）只提供内存表与查询：ttl 只记录、不生效；计时与自动回收见第五步。

/** 规格 §五 认可的三档有效期。 */
export const TTL_KINDS = ["turn", "task", "persist"];

/**
 * 建一张授权表。工厂而非单例：测试与多会话互不污染。
 * @returns {{ has: (tool: string) => boolean, get: Function, grant: Function, revoke: Function, list: Function, clear: Function, readonly size: number }}
 */
export function createGrantTable() {
  /** @type {Map<string, {tool: string, ttl: string, reason: string, layer: string, grantedAt: string}>} */
  const table = new Map();

  return {
    /** 该工具本会话是否已临时开放。 */
    has(tool) {
      return table.has(String(tool));
    },
    /** 取授权条目（未授权返回 undefined）。 */
    get(tool) {
      return table.get(String(tool));
    },
    /**
     * 临时开放一个工具。ttl 非法即抛错——不静默归一，早暴露。
     * @param {string} tool
     * @param {{ttl?: string, reason?: string, layer?: string|number}} [opts]
     */
    grant(tool, { ttl = "turn", reason = "", layer = "6" } = {}) {
      if (!TTL_KINDS.includes(ttl)) {
        throw new RangeError(`ttl 必须是 ${TTL_KINDS.join(" | ")} 之一，收到：${String(ttl)}`);
      }
      const entry = {
        tool: String(tool),
        ttl,
        reason: String(reason || ""),
        layer: String(layer),
        grantedAt: new Date().toISOString(),
      };
      table.set(entry.tool, entry);
      return entry;
    },
    /** 回收授权；返回是否确有一条被撤销。 */
    revoke(tool) {
      return table.delete(String(tool));
    },
    /** 全部授权条目（副本）。 */
    list() {
      return [...table.values()];
    },
    /** 清空（会话结束或测试用）。 */
    clear() {
      table.clear();
    },
    get size() {
      return table.size;
    },
  };
}
