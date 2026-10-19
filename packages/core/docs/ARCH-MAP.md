# 架构主图（长期规划基线）

> 来源：人类提供的 `deepseek_mermaid_20261018_f03162.mermaid`（2026-10-18）。
> 本文件把它固化为**可核对的项目基线**：每一块都给出落地状态、代码锚点、缺口。
> 图见同目录 [`architecture-map.mermaid`](architecture-map.mermaid)。
>
> 维护纪律：新增/删除能力时**同时改本表**，不要只改代码。状态只有三档：✅ 已落地 / 🟡 部分 / ⬜ 未做。

---

## 全景（自上而下）

```
L1 模型底座与画像干预
  ↓
L2 上下文策略与接入存活
  ↓
L3 动作拦截与动态工具暴露（FGA-PTC）
  ↓
L4 跨会话防污染与原生持久化
  ↓
L5 执法引擎与监察（含反规避）
  ↓
L6 处置结果与伪 RLHF 反馈闭环
  ↓（反馈回流 → L1 / L2）
```

---

## 状态总表

| 图块 | 条目 | 状态 | 代码锚点 / 缺口 |
|---|---|---|---|
| **P0** | 存活心跳（`status.json`） | ✅ | `src/dsh/heartbeat.mjs:85`、`status.mjs:73` |
| **P0** | L4 隔离路由（workspace 哈希） | ✅ | `src/dsh/workspace.mjs:38`（sha256(realpath) 前 16 位）|
| **P0** | 压缩监察留痕 | ✅ | `src/dsh/compactionWatch.mjs:239` |
| **P0** | 审计沙箱（自证写入 / 隔离污染） | ✅ | `tests/audit-isolation.mjs`、`src/core/audit-writer.mjs` |
| **L1** | 模型底座（DeepSeek Flash，MoE/字面执行） | ✅ | 画像文件 `src/profiles/deepseek-flash.mjs` |
| **L1** | 画像包 · `evasionRisk: high` | ✅ | 字段在五份画像（`src/profiles/*.mjs`，取值标 TODO(实测)）；解析**唯一真源** `src/core/profileLoader.mjs` 的 `approvalScopeOf()`：显式 `approvalGate.scope` 优先，否则 `low` → `irreversible`、`high`/缺省/非法 → `mutating`；`checkEligibility.profileScope()` 委托它，pre-execute 闸 `gateToolCall` 走同一入口；用例 `tests/profile.test.mjs` g1-g4（含「low 放行 publish、rm-rf 仍转人工」与「显式优先」） |
| **L1** | 画像包 · 相位对抗（A/B/C 变体破 KV 盲区） | ⬜ | 全仓 0 命中（`相位`）|
| **L1** | 画像包 · 神鬼缓冲垫（Nudge 重试 / 微创切除） | ⬜ | 全仓 0 命中（`Nudge`）|
| **L2** | 系统提示 / 示例池 / 严格模式 | ✅ | `src/dsh/pipeline.mjs` assemble 注入（rules + cost + workspace 三段）|
| **L2** | Superpowers 澄清→计划→TDD→验证 | 🟡 | 动笔闸 ✅（`pipeline.mjs` SP 闸）；方法论本体是外部技能 |
| **L2** | 宿主接入 ZCode / DSH | ✅ | `hooks/hooks.json`（ZCode）+ `src/dsh/index.js`（DSH 原生）|
| **L2** | 心跳自证 / 模块就位（**按需自证 Lazy Liveness**，2026-10-19） | ✅ | 心跳只写 `.focus-guard/status.json`（10s，不进 Prompt）；系统提示**不再注入** `focus-guard-degraded` 段。存活徽标 `[FG 存活 n/m]` 只在三处出现：pre-execute 返回 deny/ask 时追加（`index.js` 的 `withLivenessBadge`）、`fg_apply` 结果文本（`src/dsh/tools.mjs`）、压缩落定事件（`compactionWatch.mjs` 的 `noteLivenessEvent` → 下次徽标带 `事件: compaction`，一次性消费）|
| **L3** | 四大机械拦截点 | ✅ | pre-execute 分层：红线 / SP 闸 / 整文件闸 / 硬校验 / 资格闸 / 体积闸 / 取证闸 |
| **L3** | XERJ 检索引擎（file:line / 降 token） | ✅ | 整文件闸直接指向 `xerj search` / `xerj def` |
| **L3** | FGA · 默认只读 | ✅ 开关 | `FG_PTC_READONLY=1`：写类工具与变更型 shell 未授权即拦（`ptcReasonOf`）|
| **L3** | FGA · 隐藏高危工具 | ⬜ | schema 由宿主注入，FG 改不了；只能做"默认拒绝 + 按需解锁"（见上一条）|
| **L3** | FGA · 按需申请 `fg_apply` | ✅ | `adapters/dsh/eligibility-gate.mjs`、工具注册 `src/dsh/tools.mjs` |
| **L3** | FGA · 静默秒批 / 合并出示 | ✅ | 合并出示：原生待批队列 `pendingOf/notePending` + 批量 `tool="Bash,Write"`；秒批：`FG_PTC_AUTO_GRANT=1`（可逆类别自动批，不可逆仍人工）|
| **L3** | FGA · 人工闸门（文件审批） | ✅ **默认开** | `rm-rf` 默认不自证自批：拦截即写 `.focus-guard/approvals/pending_request.json`（id = sha256(工具+命令) 前 12 位），理由带 `node packages/core/tools/focusguard.mjs approve <id>`；人类批准后下一轮消费放行**一次**（`core/approvals.mjs` / `tools/focusguard.mjs`）。逃生口 `FG_PTC_ALLOW_RM_RF=1`，扩展 `FG_PTC_STRICT_ALL=1` |
| **L3** | FGA · TTL 临时权限令牌 | ✅ | `sweepGrants` + `TTL_MAX_MS`（turn 30min / task 4h / persist 24h）|
| **L4** | DSH 原生压缩栈 | ✅ | 宿主 preset `compaction-basic`（1M 窗 / 0.3 触发），FG 只监察 |
| **L4** | 卷宗哈希路由 + 新会话过滤注入 | ✅ | `workspace.mjs:125` 回合落账；hash 不符零注入 |
| **L5** | 无 `[文件:行号]` 打回 | ✅ | `src/dsh/stopGuard.mjs` |
| **L5** | 体积刺客阻断（禁裸 cat 等） | ✅ | `pipeline.mjs` 体积三闸 + 硬校验 |
| **L5** | 高危操作拦截 | ✅ | 红线 + 资格闸 + 语义层观察模式 |
| **L5** | 反规避 · 不可预测检查点 | 🟡 | `RANDOM_AUDIT_EVERY` 存在（随机抽查），但"2-5 次随机熔断"未按此参数化 |
| **L5** | 反规避 · 意图预警（重复试探侦测） | 🟡 | 停滞/无效调用计数存在（`stalledStreak`/`ineffCalls`），未做"意图"级预警 |
| **L5** | 反规避 · 状态一致性 | ✅ | `STATE_GATE` + 熔断/降权单向读 guard 状态 |
| **L5** | 压缩监察 | ✅ | 同 P0 |
| **L6** | 处置结果 allow / deny / ask / 注入记忆 | ✅ | pipeline 决策 + `fg_appeal`（ask）+ workspace 注入 |
| **L6** | 伪 RLHF 闭环（反馈落盘 → A/B 验证） | 🟡 | **半**：`bench:ab` / `bench:tasks` / `task-control` 能测 A/B 与成本；**回流台账已建** `docs/PROFILE-TUNING.md`（人工批准制：建议 → 人类批 → 改画像 → 再测；本轮实测可批改动 **0 条**，因 T2/T3 的校准指标采不到）。仍**不做**自动调参 |
| **L7** | 工作流：提方向 → 验可行 → 下需求 | 🟡 | 指令级（`$DSH_HOME/AGENTS.md`），非代码强制 |
| **L7** | 元审查：L1 输出 / L2 日志 / L3 status | ✅ | `npm run bench:decision`、`.focus-guard/AUDIT.log`、`status.mjs` |
| **K** | 知识输入层 | ✅ | `docs/RULES.md`、`docs/MASTER-PLAN-3.0.0.md`、技能库 |

---

## 缺口清单（按优先级）

| # | 缺口 | 影响 | 建议做法 |
|---|---|---|---|
| 1 | **FGA 默认只读 / 隐藏高危工具** | 每步固定前缀实测 **≈127k tokens（253 个工具）**——主图里唯一真正压 token 的一块 | 需宿主支持"按任务动态暴露工具"；FG 侧只能建议。落地前先用 `bench:ab` 记基线 |
| 2 | 画像包剩余两件（相位对抗 / Nudge 缓冲垫） | 影响"越狱抵抗"与重试成本，不影响主流程；`evasionRisk` **已接**（见状态表，取值未实测） | 相位对抗需要 KV 缓存盲区的测量手段，当前没有 → 记缺不做；Nudge 缓冲垫同理（先有测量再加机制）|
| 3 | 伪 RLHF 闭环缺的是**测量侧**，不是回流侧 | 回流台账（`docs/PROFILE-TUNING.md`）已建，但熔断/预算的校准指标（熔断后浪费步数、延期次数/会话）没有采集工具 → 台账只能写"保持" | 先补两个只读统计（可并入 `bench:cost`），再让台账产出**可批的数值**；在此之前保持参数不动 |
| 4 | 反规避的随机熔断未参数化 | 抽查有、随机熔断没有 | 用 `RANDOM_AUDIT_EVERY` 之外的独立参数，2-5 次随机一次，勿与抽查混 |
| 5 | **缺 3.0.8 面板基线**（人类 2026-10-19 确认暂无数据） | 没有基线，L1/L6 的任何"优化了多少"都无法复算，只能写条件性结论 | 按 `AB-PROMPTS.md` P0 节采集：同 web profile、同 8 任务、每轮开新会话、被拦禁止重试，连跑 ≥5 次；只记面板六项 + session id + steps/denies，取中位数；判定口径必须能由「3 个面板数 + 1 个 session id + 1 个公式」复算 |

---

## 成本事实（2026-10-18 实测，供后续判断）

> 口径经 2026-10-19 专家团复核修正（数据工程师 / 分析报表专员 / 可视化工程师）：以下所有 token 数凡标 `est4` 者均为 `字符/4` 折算，**不是账单**；面板成本可用官方谷价逐项反算到 `$1e-6`。

```
工具 schema     253 个 / 496,915 字符 → est4 124,229 tok
                 其中 mcp:rea 170 个 / 436,414 字符 ≈ 109,104 tok
                 = 工具 schema 的 87.87%（⚠ 不是"单步前缀"的 87.9%；占全前缀 85.6%）
系统提示        12,693 字符（B 臂）→ est4 3,173 tok；A 臂 11,648 字符（无 FG 注入）
单步固定前缀    127,429 tok = 124,229（工具）+ 3,200（系统，两臂均值近似）
FG 固定开销     工具 +1,244 字符（≈311 tok）+ 系统注入 +1,045 字符（≈261 tok）≈ 572 tok/步
                 （占昨日前缀 0.45%，占今日 ≈18.3k 前缀 ≈3.1%）
A/B 会话对比    A(FG 关) 538,599 tok / $0.0306412 / 3 步 / 0 拦截
                B(FG 开) 1,510,638 tok / $0.0311278 / 9 步 / 7 拦截
缓存命中        A 65.53% / B 88.76%（分母 = 缓存读取 + 未缓存输入，不含输出）
真实贵的部分    A 未缓存+输出 187,751 → B 172,270（−8.25%，四舍五入 −8.2%）
```

**A/B 差异的来源是步数，不是每步开销**：A/B 工具面几乎相同（251 vs 253 个，差的就是 FG 的 `fg_apply`/`fg_appeal`），
总量 2.80× 主要来自 B 组 7 次拦截触发的 6 个额外 step。因此**不能把 2.8× 读成"FG 每步更贵"**，
也不能把"成本仅 +1.59%"读成"FG 省了钱"（真实机制是缓存读取单价 = 未缓存价的 1/50）。

### 已执行的裁剪（2026-10-18）

`web` profile 的 `cordis.patch.yml` 里 `mcp-client-rea` 整块已注释（保留原文，去三行 `#` 即恢复）。
关闭后 `dsh --profile web --dump-config` 条目 320 → 319，`serverName: rea` 命中 0。
裁剪后工具面实测（2026-10-19 会话 `request/header`）：83 个工具 / 60,436 字符 → est4 15,109 tok。

预期收益（按 B 组 9 步外推）：单步前缀 **127,429 → ≈18,282** tok（−85.7%），该会话成本 $0.0311 → ≈$0.012（**−60%**）。
⚠ 这是**配置变更**（REA MCP 关闭）的收益，与 3.0.8 版本本身无关；3.0.8 的 Lazy Liveness 在正常态节省 = 0。
备份：`cordis.patch.yml.bak-rea-off-20261018-211011`。**恢复需托盘退出并重启 Desktop。**

结论：现状 FG **成本几乎持平（+1.59%）**；主图落地后预期 **−30%～−60%**，全部收益来自第 1 项（工具面收窄）。
