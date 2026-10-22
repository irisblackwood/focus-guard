# 真实调用夹具（自动生成，禁止手改）

由 `node packages/core/tools/capture-fixtures.mjs` 从**真实会话**导出：
每条 = 一次真实 `tool/call` 的参数形状 + 宿主返回的 `tool/result` 判定。

- `verdict: "deny"` = 当时 FG 拦下了（真实拦截文案前 160 字）
- `verdict: "pass"` = 当时放行（每工具最多 2 条）

**纪律**：测试只准读这里 + 自己的合成参数（合成必须标注）。手改本目录等于毁掉证据链。
