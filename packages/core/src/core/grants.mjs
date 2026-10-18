// FocusGuard 母版层 · 授权表（资格审核的独立状态源）
//
// 纪律（领导 2026-10-08 批）：
//   grants 是 FG 自己的状态，**不塞进 guard.mjs 的 state** —— 否则两套状态源会在第 3 层
//   校验时分叉。持久化目标是 FG 自己的状态文件（第五步实现）。
//
// 2026-10-18 补口（HANDOFF 遗留「ttl 只记录不生效」）：
//   三档 ttl 现在**真的回收**，语义按事件而非时钟：
//     turn    —— 本回合结束回收（agent/turn-stopping 调 sweep）
//     task    —— 本任务结束回收（seam 在任务边界调 sweep，缺边界时随 turn 一起清）
//     persist —— 会话内不回收（进程结束自然消失）
//   另设硬上限 expiresAt（TTL_MAX_MS）：防止 persist 授权被长期会话无限续命。

/** 规格 §五 认可的三档有效期。 */
export const TTL_KINDS = ["turn", "task", "persist"];

/** 各档的兜底寿命上限（毫秒）；persist 只受会话进程寿命约束，给一个宽松上限防僵尸。 */
export const TTL_MAX_MS = {
  turn: 30 * 60 * 1000, // 30 分钟：正常回合远短于此
  task: 4 * 60 * 60 * 1000, // 4 小时
  persist: 24 * 60 * 60 * 1000, // 24 小时
};

/**
 * 建一张授权表。工厂而非单例：测试与多会话互不污染。
 * @returns {{ has: Function, get: Function, grant: Function, revoke: Function, list: Function, sweep: Function, clear: Function, readonly size: number }}
 */
export function createGrantTable() {
  /** @type {Map<string, {tool: string, ttl: string, reason: string, layer: string, grantedAt: string, expiresAt: number}>} */
  const table = new Map();

  /** 过期即删；返回条目是否仍然有效。 */
  function alive(tool) {
    const key = String(tool);
    const entry = table.get(key);
    if (!entry) return false;
    if (Number.isFinite(entry.expiresAt) && Date.now() >= entry.expiresAt) {
      table.delete(key);
      return false;
    }
    return true;
  }

  return {
    /** 该工具本会话是否已临时开放（含过期检查）。 */
    has(tool) {
      return alive(tool);
    },
    /** 取授权条目（未授权或已过期返回 undefined）。 */
    get(tool) {
      return alive(tool) ? table.get(String(tool)) : undefined;
    },
    /**
     * 临时开放一个工具。ttl 非法即抛错——不静默归一，早暴露。
     * @param {string} tool
     * @param {{ttl?: string, reason?: string, layer?: string|number, now?: number}} [opts]
     */
    grant(tool, { ttl = "turn", reason = "", layer = "6", now = Date.now() } = {}) {
      if (!TTL_KINDS.includes(ttl)) {
        throw new RangeError(`ttl 必须是 ${TTL_KINDS.join(" | ")} 之一，收到：${String(ttl)}`);
      }
      const entry = {
        tool: String(tool),
        ttl,
        reason: String(reason || ""),
        layer: String(layer),
        grantedAt: new Date(now).toISOString(),
        expiresAt: now + (TTL_MAX_MS[ttl] ?? TTL_MAX_MS.turn),
      };
      table.set(entry.tool, entry);
      return entry;
    },
    /** 回收授权；返回是否确有一条被撤销。 */
    revoke(tool) {
      return table.delete(String(tool));
    },
    /** 全部授权条目（副本，只含未过期的）。 */
    list() {
      return [...table.keys()].filter((k) => alive(k)).map((k) => table.get(k));
    },
    /**
     * 按 ttl 档回收（事件驱动）。
     * @param {"turn"|"task"} kind 回收哪一档
     * @returns {string[]} 被回收的工具名
     */
    sweep(kind) {
      const removed = [];
      for (const [key, entry] of table) {
        if (kind === "task" && entry.ttl === "persist") continue;
        if (kind === "turn" && entry.ttl !== "turn") continue;
        table.delete(key);
        removed.push(key);
      }
      return removed;
    },
    /** 清空（会话结束或测试用）。 */
    clear() {
      table.clear();
    },
    get size() {
      return [...table.keys()].filter((k) => alive(k)).length;
    },
  };
}
