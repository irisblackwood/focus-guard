# 版本计划（3.5 文档重置 / 4.0 Hook 改革）

> 状态：**计划，未开工**。创建 2026-10-19；当前主线版本仍为 **3.0.8（in-tree，未发 npm）**。
> 纪律：计划只在本文件维护；能力状态仍以 `ARCH-MAP.md` 为准，版本历史仍以 `CHANGELOG.md` 为准。
> 改计划 = 改本文件 + `ARCH-MAP.md` 的「版本路线」行，两处必须一致。

---

## 0. 起点

| 项 | 事实 |
|---|---|
| 版本 | 3.0.8 已进仓库，未发 npm；npm 最新 3.0.7（MIT，不可撤销） |
| 回归 | `npm run check` → 346/346；`bench:decision` 100% / p95 2.79ms；`bench:tasks --ab` 57/57、误伤 0 |
| 分支 | 本地领先 `origin/main`（按纪律等下一个 20:00 统一推） |
| 已知缺口 | 面板基线（#5）、契约探针、抽查B 已默认开、缺口 #1 等宿主接口 |

---

## 1. 下一步（近程，3.0.9 候选）

> 3.5（文档重置）与 4.0（Hook 改革）都是远期计划，二者都依赖同一件事：**先有可验证的基线、先证明已提交的机制真的在跑**。
> 本节是眼前 1–2 周的动作，按此顺序做；每项都要能复跑验证。

| ID | 动作 | 谁做 | 验收（可复跑） |
|---|---|---|---|
| **N1** | **3.0.8 面板基线**：同 web profile、同 8 任务、每轮新会话、被拦禁止重试，连跑 ≥5 轮；只抄面板六项（总/未缓存/缓存读/输出/命中率/USD/耗时）+ session id | 人类采数 → 我用 `bench:ab` 补 steps/denies 并出中位数 | 每个百分比能由「3 个面板数 + 1 个 session id + 1 个公式」复算；`BENCH.md` 数据快照单点更新 |
| **N2** | **重启后验证已提交能力真的生效**：① 新审计行带 `turn`/`step` ② 制造一次真熔断 → 出现 `fuse-waste` 行 ③ `bench:cost` 的 `fuseWaste.bySession` 非空 | 我（需重启宿主） | `rg '"action":"fuse-waste"' .focus-guard/AUDIT.log` ≥1 行；`bench:cost --json` 的 `bySession` 含该会话 |
| **N3** | **抽查B 观测**（已默认开）：跑 1–2 天后统计 `random-fuse` 行数/会话、`appealsGranted`、误伤比（扣除 `evidence-gate`） | 我 | 误伤率 >0 或噪音明显 → 交你批后调 `RANDOM_FUSE_MIN/MAX` 或改回默认关；不擅自改 |
| **N4** | **契约探针（需你批）**：最小版 ≈30 行，只在首次 `agent/pre-step` 断言载荷含 `turn`/`step`、首次 `turn-stopping` 断言含 `agent`；失败写 `contract-probe` 审计 + `status.json` 标 degraded，**不拦截** | 我 | 用坏载荷模拟 → `status.json` 显示 degraded 且审计有行；正常会话 0 误报 |
| **N5** | **推送批次**：当前 `ahead 11` 按纪律等下一个 20:00 一次推，不逐条推 | 我 | 推送后 `ahead 0`；20:00 之前不再 push |
| **N6** | **3.0.9 是否发 npm**：等 N1（有基线）+ N4（契约）之后再决定；AGPL 发布不可回退 | 人类 | 决策与理由写入 `CHANGELOG.md`「未发版」区 |

近程明确不做：缺口 #1（等宿主接口）、#2（相位对抗/Nudge，无测量手段）、自动调参回流。

---

## 2. 3.5 · 文档重置

**目标**：把「事实源」收敛成单点，把「入口页」降到可读体量，让新会话 10 分钟能接手。
**不做**：不 bump 版本、不改许可、不动判定代码（文档 + `check` 脚本除外）。

### 工作项

| ID | 工作 | 现状证据（2026-10-19 只读盘点） | 验收 |
|---|---|---|---|
| **D1** | **README 瘦身为入口页** | `README.md` 402 行 / 30 标题 / 124 表格行 / 49 处 ≥3 位数字；承担 5 份文档职责 | 行数 ≤160；标题 ≤10；表格行 ≤30；`README.md` 内 ≥3 位数字只剩版本号 |
| **D2** | 建 `docs/INDEX.md` | 54 份 md 无地图；新会话不知道读哪份 | 每份文档有状态头（权威/参考/归档 + 适用版本 + 最后核对日期） |
| **D3** | 建 `docs/archive/` 并归档 | 5 份 HANDOFF，其中 `HANDOFF.md`(10-09, 188 行)、`docs/HANDOFF-TO-EXTERNAL.md`(10-09)、`HANDOFF-2026-10-18` 已过期且无标记；`docs/archive` 不存在 | 旧交接移入并在顶部标「已归档，勿引用」；现行交接只剩 10-19 两份且标「参考」 |
| **D4** | 数字单点化 | `127,429`/`124,229`/`87.87` 各 3 份；`538,599`/`1,510,638` 3 份；`p95 2.37` 4 份；10-19 的 A/B（739,083 / 231,544）与 ARCH-MAP 的旧 A/B 同标签不同值 | `BENCH.md`「数据快照」为唯一数字源；`ARCH-MAP.md` 只留结论+链接；`rg '538,599'` 只命中一处且带 session id + 日期 |
| **D5** | `npm run docs:lint` 并入 `check` | 仓库无任何文档 lint（无 markdownlint/remark/prettier）；测试只锁「七处版本号 = CHANGELOG 最新」 | lint 覆盖：版本面、相对链接可达、状态头、README 硬指标、单点白名单外的重复数字；故意改坏一链接时 lint 必红 |
| **D6** | 核对 `RULES.md` 第三部分技术映射表 | 该表按条映射到实现，最容易随代码过期（本轮才补 3.0.8 条目） | 每条映射给出 `file:line` 且抽查 5 条与代码一致 |

### D1 的拆分去向（照此迁，不新造概念）

| README 现有内容 | 去向 |
|---|---|
| `:104-238` 核心机制（空气层/触发层/处罚/预算/卷宗/监察/审批/资格/子代理/指引/自证） | 新 `docs/ARCHITECTURE.md`（教学性叙述）；`ARCH-MAP.md` 保持「状态 + 锚点」 |
| `:260-307` 工作原理 | 同上（`ARCHITECTURE.md`） |
| `:75-103` 安装 | `INSTALL.md` 为唯一安装源；README 留 5 行 + 链接 |
| `:308-329` 测试与质量闸 | `BENCH.md`；README 留一句 + 链接 |
| `:330-345` 双包架构 | `ARCHITECTURE.md` |
| `:346-357` 设计取舍与已知边界 | `ARCHITECTURE.md`（边界）或 `RULES.md`（约束）择一，不两写 |
| `:358-376` 版本与变更 | `CHANGELOG.md`；README 只留「当前 3.0.8」一行 |
| `:222-238` 运行面自证（写「未 bump 版本」） | `ARCHITECTURE.md`，且删除「版本号仍记 3.0.6」这类过期叙述 |
| `:80-82` 注释掉的 npm 安装（404） | 删除或改为「未发布」一句 |

### 3.5 验收（整批）

- `npm run check` 全绿（含新 `docs:lint`）。
- 新会话按 `docs/INDEX.md` 能在 10 分钟内定位：安装 → `INSTALL.md`、机制 → `ARCHITECTURE.md`、状态 → `ARCH-MAP.md`、基准 → `BENCH.md`、法条 → `RULES.md`、台账 → `PROFILE-TUNING.md`。
- 数字单点抽查：`538,599`、`127,429`、`p95 2.37`、`572 tok` 各只命中一处（或其白名单文档）。
- README 硬指标全部达标。

### 3.5 明确不做

- 不引入文档插件（markdownlint/prettier/站点生成）：痛点 P1-P4 都属「事实源 + 校验」，插件只解决格式，且有改写正文风险。
- 不做「只留 6 份文档、其余全删」的激进方案（过程材料靠 git 可回溯，但当前无必要）。
- 不改 `ARCH-MAP` 的能力状态语义（只加链接，不重写状态）。

---

## 3. 4.0 · Hook 改革（MCP 常驻内核）

**目标**：废除外挂脚本 Hook（`hooks/guard.mjs`），把 FG 内核迁入 **MCP 常驻进程**，Claude Code 侧只保留
「HTTP hooks 触发线 + deny 规则」。完整调研与引用见 **[`MCP-4.0-PLAN.md`](MCP-4.0-PLAN.md)**。

**边界（写死，避免误读）**：

- MCP **不能**拦截原生工具，拦截入口是 `PreToolUse` hook；4.0 只是把 hook 从「每条 spawn 脚本」改成 **`type:"http"`**。
- MCP **不能**主动派发子代理；只能通过 `Agent(...)` 权限规则 + `SubagentStart/Stop` 做约束与审计。
- `updatedInput` 仅在 hook 返回 `allow` 时生效，改写后仍会重过 deny/ask 规则。

### 阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 spike** | 最小 HTTP MCP server + `PreToolUse`/`Stop` 两个 HTTP hook；实测三件事：① `deny ["Bash"]` 后模型是否真看不到 Bash ② `updatedInput` 是否真实生效 ③ hook 输入有没有 `turn`/`step` | 三项各有一行实测结论；没有 turn/step 就定「FG 自编号」方案 |
| **P1 判定内核** | `pipeline.mjs` 分层判定搬入 daemon，hook 只转发 | 与 3.0.8 `bench:decision` 对齐：100% / 误伤 0 / p95 不劣化 |
| **P2 状态与审批** | 会话注册表、审批表、TTL、审计（含 `rule-change`）、心跳 | 跨会话常驻；热更新同一回合生效；审计可回放 |
| **P3 接管模式** | `deny ["Bash","PowerShell"]` + `fg_execute`；写类工具分级而非全量替换；子代理强制隔离规则 | 与 3.0.8 判定基准一致；误伤 0；可一键回滚到「只分级」 |
| **P4 分发** | 打包为 Claude Code plugin（`.mcp.json` + `hooks/hooks.json` + agents） | 一条命令安装；plugin subagent 的 hooks/mcpServers 限制已在方案里注明 |

### 4.0 前置

1. **3.5 完成**（`docs/INDEX.md` + 单点事实源）：4.0 要重写 `RULES.md` 技术映射表（hook → MCP），没有单点会重演同步债。
2. P0 spike 的三项实测结论（尤其 deny vs `bypassPermissions` 的真实边界）。
3. 许可兼容核对：若引入 MCP SDK 依赖，确认 AGPL-3.0-only 兼容（MCP SDK 多为 MIT）。

---

## 4. 顺序与依赖

```
3.0.8（当前，in-tree）
   └─ 3.5 文档重置（D1→D6，先 D1 立样板，再 D5 上锁）
        └─ 4.0 P0 spike → P1 → P2 → P3 → P4
```

- 3.5 与 4.0 之间**没有版本号空档要求**：3.5 完成后即可开 4.0 P0，是否合并发版由人类决定。
- 任何一步都不自动 bump 版本；发布仍按「满批一次 bump + 20:00 推送窗口」。

---

## 5. 变更记录

- **2026-10-28 补近程**：**3.2.1**（plugin_manager 只读口修复 + 结构债 27→8 / 健康分 79→93 + CHANGELOG 全 21 段重排）；3.5 / 4.0 排期未动，N1 面板基线仍是最近的前置。
- **2026-10-19 补近程**：新增 §1 下一步（N1 面板基线 / N2 重启验证 / N3 抽查B 观测 / N4 契约探针 / N5 推送 / N6 发版决策），3.5 与 4.0 顺延为 §2 / §3。
- **2026-10-19 创建**：登记 3.5（D1-D6）与 4.0（P0-P4），吸收本会话的 README 复杂度评估与 `MCP-4.0-PLAN.md` 调研结论。
