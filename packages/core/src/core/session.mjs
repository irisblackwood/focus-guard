// FocusGuard 母版层 · 会话上下文（v3.0.5；《资料与代码分层总规范》二·1）
// 会话 ID 的唯一定义处：母版各模块读活绑定 sid，入口调用 bindSession 注入。

export let sid = "";
export function bindSession(id) {
  sid = String(id || "");
}


