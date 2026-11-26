// FocusGuard 母版层 · 会话上下文（v3.0.5；《资料与代码分层总规范》二·1）
// 会话 ID 的唯一定义处：母版各模块读活绑定 sid，入口调用 bindSession 注入。

export let sid = "";
export function bindSession(id) {
  sid = String(id || "");
}

/**
 * 从载荷解析会话标识（2026-11-25）。
 *
 * 为什么在母版：解析链本身与宿主无关——`agent.session.header.id` 是各宿主桥共同的形状，
 * 只是取不到时**用什么哨兵值**是宿主决定的。所以链在这里，哨兵由调用方传入。
 * 哨兵不能写死在本文件：`dsh-native` 是宿主专属标识，出现在 `src/core/` 就是分层泄漏
 *（`layering-audit` 的 HOST_MARKS 会红）。
 *
 * 两种入参形状都收：`exec`（`{ agent, sessionId }`）与裸 `agent`。
 * 此前 `audit.mjs` / `tooling.mjs` / `seams/shared.mjs` / `traceMeta.mjs` /
 * `eligibility-gate.mjs` 各写一份，其中 `eligibility-gate` 那份**漏了 `header.id`**——
 * 于是所有会话退化成同一个桶（真实 AUDIT.log 里 439 条记在哨兵名下）。同一段逻辑写五遍，
 * 漏的那一遍会安静地错很久。
 */
export function resolveSid(x, fallback = "") {
  const a = (x && x.agent) || x;
  return (
    (a && ((a.session && a.session.header && a.session.header.id) || a.sessionId || a.id)) ||
    (x && x.sessionId) ||
    fallback
  );
}


