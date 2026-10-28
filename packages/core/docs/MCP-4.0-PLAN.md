# FG 4.0 · Claude Code MCP 常驻形态方案（调研稿）

> **状态**：参考 · 适用版本 4.0 前置 · 最后核对 2026-10-28

> 状态：调研 + 方案草案，**未开工**。目标：回答「MCP Server 能否替代旧 Hook、让 FG 在 Claude Code 满血复活」。
> 信息来源：Claude Code 官方文档（`code.claude.com/docs`，2026-10 抓取），三条链接见文末。文档是外部资料，以实测为准。
> 结论先行：**MCP 能当“体”，当不了“神经”**。FG 可以变成常驻 MCP Server（状态、热更新、审计、审批全部常驻），
> 但**工具调用拦截的官方唯一入口仍是 hooks**。4.0 正确的形态是「MCP 常驻内核 + HTTP hooks 当触发线」，
> 而“彻底抛弃旧 Hook”应理解为**抛弃 `hooks/guard.mjs` 的外挂脚本/冷启动模型**，不是抛弃 hook 事件本身。

---

## 一、三个问题逐一回答

### Q1. MCP 网关能否拦截/接管 Claude Code 的 bash、write？能否强制走 `fg_execute`？

**拦截：MCP 不行，hooks 才行（但可以不再冷启动）。**

- MCP 工具是**模型可调用的工具**，没有“拦截原生工具调用”的能力；官方文档没有任何 MCP 侧 pre-tool 拦截点。
- 官方拦截点是 `PreToolUse` hook：可返回 `permissionDecision: "allow" | "deny" | "ask"`（+ `permissionDecisionReason`），
  `allow` 时可带 `updatedInput` 改写参数（**仅 allow**，且改写后会重新过 deny/ask 规则）。
- 关键进化（这正是 4.0 的机会）：hook handler 类型有 **`type:"http"`**——Claude Code 把事件 JSON **POST 到 URL**，
  不再每条 spawn 一个进程。FG 常驻后，冷启动成本归零，只剩一次本地 HTTP 往返。
- 另一条路：`mcp_tool` 类型 hook（调用 MCP 工具）也能拿到事件，但返回的是“工具文本输出”，
  语义不如 HTTP 直返 JSON 干净；推荐 HTTP。

**强制 `fg_execute`：能，用 deny 规则把原生工具从上下文里摘掉。**

- 官方明确：裸工具名 deny（如 `"Bash"`）**会把工具从 Claude 的上下文中移除**，模型根本看不到它；
  带 specifier 的 deny（`Bash(rm *)`）只是拦匹配调用，工具仍在。这是“强制换工具”的机制。
- 做法：`permissions.deny: ["Bash", "PowerShell"]` + FG 暴露 `mcp__fg__fg_execute`。
  deny 优先于 allow / ask / hook 的 allow；hook 返回 allow 也不能绕过 deny。
- 代价与边界（必须写进方案）：
  1. 同时要 deny `PowerShell`，否则换壳绕过；Cowork 会话还走 `mcp__workspace__bash`，官方说**裸 `Bash` deny 会同样作用于它**。
  2. 只 deny shell 不够：`Write`/`Edit`/`NotebookEdit` 仍是原生工具；要“全走 FG”就一并 deny 并提供 `fg_write`，
     但会显著改变使用手感——建议**默认只接管 shell**，写类工具用 PreToolUse 分级（红/黄/绿），而不是全量替换。
  3. 有些工具 deny 摘不掉（`EndConversation` 例外），别在方案里假设能 100% 收口。
  4. `bypassPermissions` 会跳过权限提示；本方案的硬约束依赖 deny 规则与 managed settings，
     真实边界要在 P0 spike 里实测（不要凭文档推断“deny 一定压过 bypass”）。

### Q2. 常驻进程如何热更新规则/心跳阈值？

- 传输选 **HTTP**（`type:"http"`，`streamable-http` 别名）而不是 stdio：stdio 的生命周期跟一个 session 走，
  进程随会话结束被杀；HTTP server 由你/系统托管，**跨会话常驻**，内存态才是真常驻。
  （stdio 退出时序官方也写了：SIGINT→SIGTERM→SIGKILL；不要在这种进程里放唯一状态。）
- 三条更新通道，按优先级：
  1. **管理工具**：`mcp__fg__fg_admin`（标 `_meta["anthropic/requiresUserInteraction"]: true`，每次调用必弹人审），
     人类在 Claude Code 里直接下指令：`reload` / `set heartbeat.staleAfterMs=45000` / `rule add ...`。
  2. **文件监听**：FG 自己的 `rules.json`（或 `profiles/*.mjs`）被 `fs.watch` 监视；也可让 Claude Code 的
     `FileChanged` / `ConfigChange` hook 通知 daemon，做到“改文件即生效”。
  3. **MCP elicitation**：daemon 需要人类确认时主动发起 elicitation（表单模式），人类在对话里填；
     反过来人类也可用 `/fg:reload` 这类 **MCP prompt 变 slash command** 触发（`/mcp__fg__reload`）。
- 原子性：规则版本号单调递增；每次变更写 `AUDIT.log`（`rule-change`，含旧/新值与批准人），失败回滚上一版；
  heartbeat 阈值属安全参数，单独一档，改动需 `fg_admin` 人工确认（防“静默放松”）。
- 心跳本身不依赖 Claude Code：daemon 自己每 N 秒写 `status.json`（保持现有 3.0.8 语义），
  阈值热改只影响 `stale_after_ms`，不影响判定链。

### Q3. MCP Server 能否触发/接管 Task（子代理）？

**不能直接触发**：MCP 的工具只能被模型调用；协议里没有“server 主动调用宿主工具”的能力。
官方 subagent 的入口是 `Agent` 工具（原 Task），由模型发起。

**但可以强约束 + 全程接管生命周期**：

- `permissions.deny` 支持 `Agent(AgentName)`（如 `Agent(Explore)`），可直接禁用某类子代理；
  deny `Agent` 整工具 = 禁止一切委派。
- `Agent` 工具是权限参数可匹配的：`Agent(model:opus)`、`Agent(isolation:worktree)`、`Agent(isolation:*)`
  这类 deny/ask 规则**能在派发前强制隔离方式**；配合 `updatedInput`（hook 返回 allow 时）可注入/改写参数。
- `SubagentStart` / `SubagentStop` 是两个官方事件（matcher = agent 类型，含 `agent_id` / `agent_type`），
  FG 可据此做：开局注入隔离要求、收尾审计、污染判定、未取证回滚提示。**hooks 在子代理内同样触发**，
  输入带 `agent_id`/`agent_type`——这是“高污染任务隔离”的真正抓手。
- 子代理定义可带 `tools` / `disallowedTools` / `mcpServers` / `permissionMode` / `hooks` / `isolation: worktree`；
  **但 plugin 提供的 subagent 会忽略 `hooks`/`mcpServers`/`permissionMode`**——所以“插件分发 subagent”要在
  插件 `hooks/hooks.json` + `.mcp.json` 层做，而不是写进 subagent frontmatter。
- 结论：FG 不能“命令 Claude 开子代理”，但能“拒绝/强制隔离/审计子代理”，并把 `fg_delegate` 做成
  返回“派发指令模板”的工具（模型拿到模板再调 `Agent`），形成软引导。

---

## 二、4.0 架构草图（MCP 常驻内核 + HTTP hooks）

```
┌───────────────────────────── Claude Code (宿主) ─────────────────────────────┐
│  模型 ──调用──> 原生工具(Bash/Write/…)        模型 ──调用──> mcp__fg__* 工具   │
│      │                                              │                        │
│      ├─ PreToolUse hook  (type:"http") ─────────────┼──> POST /hooks/pre     │
│      ├─ PermissionRequest/PermissionDenied (http) ──┤                        │
│      ├─ SubagentStart/Stop, PostToolBatch (http) ───┤                        │
│      ├─ UserPromptSubmit / Stop / PreCompact (http) ┤                        │
│      └─ MCP 客户端 (type:"http") ──── POST /mcp ────┘                        │
└──────────────────────────────────────────────────────────────────────────────┘
                                  │  localhost only (+token)
┌─────────────────────────────────▼───────────────────────────────────────────┐
│                        FG 常驻 daemon（单进程/机器）                          │
│  ┌────────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │ HTTP 入站   │  │ 规则引擎      │  │ 会话注册表     │  │ 管理面           │  │
│  │ /hooks/*   │─>│ 分层判定      │  │ sid→state     │  │ fg_admin / elicitation│
│  │ /mcp       │  │ (L0-L6)      │  │ turn/step 自编号│ │ rules.json 热加载 │  │
│  └────────────┘  └──────┬───────┘  └───────────────┘  └──────────────────┘  │
│                         │                                                    │
│  ┌──────────────────────▼───────────────────────────────────────────────┐   │
│  │ 副作用：AUDIT.log(JSONL) · 卷宗 hash 路由 · 审批/授权表(TTL) · 心跳    │   │
│  │        status.json(10s) · 成本台账(面板口径)                          │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

时序（一次工具调用）：

1. Claude Code 触发 `PreToolUse` → `POST /hooks/pre`（含 `session_id`、`tool_name`、`tool_input`、`agent_id?`）
2. daemon 分层判定 → 返回 `{permissionDecision: deny|ask|allow, reason?}`（需要时 `updatedInput`）
3. deny 规则优先：即使 hook 返回 allow，命中 deny 仍被拦
4. 执行后 `PostToolUse` / `PostToolBatch` → daemon 更新会话态、写审计、结算抽查
5. 回合结束 `Stop` → 结算 KPI/TTL/熔断浪费；`SubagentStop` → 子代理审计收口
6. 人类/规则变更 → `fg_admin` / `rules.json` / `FileChanged` → 原子换规则，写 `rule-change` 审计

---

## 三、能力映射（现有 FG → MCP 形态）

| 现能力 | 4.0 承载 | 说明 |
|---|---|---|
| 分层拦截（红线/SP/整文件/取证/资格/体积） | HTTP PreToolUse + daemon 规则引擎 | 判定逻辑可直接复用 `pipeline.mjs` 分层函数 |
| `fg_apply` / `fg_appeal` | MCP 工具（`mcp__fg__*`） | 审批/申辩语义不变，状态进 daemon |
| 人工闸门（`pending_request.json`） | daemon 审批表 + `requiresUserInteraction` | 人类在对话里批（或终端 CLI 二选一） |
| TTL 授权 | daemon 会话注册表 | 跨会话常驻，三档回收 |
| 审计 `turn`/`step` | **待实测**：hook 输入无 turn/step | 可由 `UserPromptSubmit`+`PostToolBatch` 编号，或解析 transcript；P0 先验证 |
| 心跳/存活 | daemon 自写 `status.json` | 与 Claude Code 生命周期解耦，更稳 |
| 压缩监察 | `PreCompact`/`PostCompact` hook | 官方事件，替换 DSH 的 `session/event` 观察 |
| 画像/`evasionRisk` | daemon 规则引擎读画像 | 纯参数，热加载 |
| 卷宗（L4） | daemon 持久化 + `SessionStart` hook | `SessionStart` 有 startup/resume/clear/compact/fork |
| 子代理隔离 | `Agent` 权限规则 + `SubagentStart/Stop` | 强约束 + 生命周期审计；不能主动 spawn |
| 工具面瘦身 | MCP tool search（默认开） | 正是 4.0 想要的“按需暴露”：server instructions + `alwaysLoad` 控制 |

---

## 四、迁移阶段（建议）

- **P0 spike（1–2 天）**：最小 HTTP MCP server + 两个 HTTP hook（PreToolUse/Stop）；实测三件事：
  ① `deny ["Bash"]` 后模型是否真的看不到 Bash；② hook 的 `updatedInput` 在真实调用里是否生效；
  ③ hook 输入里到底有没有 turn/step（没有就定编号方案）。
- **P1 判定内核（1 周）**：把 `pipeline.mjs` 分层判定搬进 daemon，HTTP hook 只做转发；与 3.0.8 判定基准对齐（`bench:decision` 100%）。
- **P2 状态与审批（1 周）**：会话注册表、审批表、TTL、审计（含 rule-change）、心跳；跨会话常驻验证。
- **P3 接管模式（按需）**：deny Bash/PowerShell + `fg_execute`；写类工具分级而非全量替换；子代理强制隔离规则。
- **P4 分发**：做成 Claude Code plugin（`.mcp.json` + `hooks/hooks.json` + agents），一条命令安装。

验收口径（与 3.0.8 一致）：判定准确率 100% / 误伤 0；P0/P1 阶段必须给出 hook 往返延迟（本地 HTTP 应 <5ms）；
热更新必须“旧规则立即失效、新规则同一回合生效”，且每次变更可审计。

---

## 五、风险与未决

1. **hook 输入无 turn/step**（待 P0 实测）：没有就退回“FG 自编号”（UserPromptSubmit 递增 turn，工具调用递增 step），
   与 DSH 侧 `traceMeta` 语义对齐。
2. **deny vs bypassPermissions 的真实边界**：文档说 deny 优先于 hook/allow，但 `bypassPermissions` 只谈“跳过提示”；
   P0 必须在受控环境实测，别在方案里假设。
3. **MCP 输出上限**：单响应 16MiB、文本 50k 字符默认落盘、`MAX_MCP_OUTPUT_TOKENS` 25k；大结果要走资源或分页。
4. **plugin subagent 限制**：plugin 的 subagent 忽略 `hooks`/`mcpServers`/`permissionMode`，
   所以“插件分发 + 子代理策略”要放在 plugin hooks/`.mcp.json` 层。
5. **多会话并发**：daemon 需按 `session_id` 分表；HTTP 端口冲突与鉴权（仅回环 + token）必须写死。
6. **许可**：FG 4.0 若采用 MCP SDK 依赖，需核对 AGPL 兼容性（MCP SDK 多为 MIT，兼容）。

---

## 六、结论：能不能“满血复活”

**能，但要换一个说法**：

- 比旧 hook 生态**更强**的部分：常驻内存态、跨会话、热更新、审批/授权/审计集中、MCP 工具与资源统一入口、
  tool search 天然按需暴露（直接解决 3.0.8 的 253 工具 / 127k 前缀问题）。
- **不能**的部分：MCP 没有工具拦截点（必须靠 hooks 触发）；MCP 不能主动派发子代理（只能约束/审计）；
  `updatedInput` 只在 allow 路径生效。
- 所以 4.0 的准确表述是：**“废除外挂脚本 Hook（guard.mjs），把 Hook 降级为 HTTP 触发线，内核迁入 MCP 常驻进程”**。
  这既满足“跟上新功能”，也不与宿主能力对抗。

---

## 参考（官方文档，外部资料）

- Hooks reference（HTTP hooks、PreToolUse、`updatedInput`、事件清单）：https://code.claude.com/docs/en/hooks
- Permissions（deny 裸工具移除上下文、`Agent(...)`、`Bypass` 语义）：https://code.claude.com/docs/en/permissions
- MCP（HTTP/stdio 传输、`requiresUserInteraction`、elicitation、tool search、prompts/resources）：https://code.claude.com/docs/en/mcp
- Sub-agents（frontmatter、`isolation: worktree`、plugin 限制、SubagentStart/Stop）：https://code.claude.com/docs/en/sub-agents
