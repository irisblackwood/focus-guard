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
| **L1** | 画像包 · `evasionRisk: high` | ⬜ | 全仓 0 命中（`evasionRisk`） |
| **L1** | 画像包 · 相位对抗（A/B/C 变体破 KV 盲区） | ⬜ | 全仓 0 命中（`相位`）|
| **L1** | 画像包 · 神鬼缓冲垫（Nudge 重试 / 微创切除） | ⬜ | 全仓 0 命中（`Nudge`）|
| **L2** | 系统提示 / 示例池 / 严格模式 | ✅ | `src/dsh/pipeline.mjs` assemble 注入（rules + cost + workspace 三段）|
| **L2** | Superpowers 澄清→计划→TDD→验证 | 🟡 | 动笔闸 ✅（`pipeline.mjs` SP 闸）；方法论本体是外部技能 |
| **L2** | 宿主接入 ZCode / DSH | ✅ | `hooks/hooks.json`（ZCode）+ `src/dsh/index.js`（DSH 原生）|
| **L2** | 心跳自证 / 模块就位 | ✅ | 同上，模块自检 15 项 |
| **L3** | 四大机械拦截点 | ✅ | pre-execute 分层：红线 / SP 闸 / 整文件闸 / 硬校验 / 资格闸 / 体积闸 / 取证闸 |
| **L3** | XERJ 检索引擎（file:line / 降 token） | ✅ | 整文件闸直接指向 `xerj search` / `xerj def` |
| **L3** | FGA · 默认只读 / 隐藏高危 | ⬜ | **工具暴露在宿主层，FG 改不了 schema**；要做得改宿主或加中间层 |
| **L3** | FGA · 按需申请 `fg_apply` | ✅ | `adapters/dsh/eligibility-gate.mjs`、工具注册 `src/dsh/tools.mjs` |
| **L3** | FGA · 静默秒批 / 合并出示 | ✅ | 2026-10-18 补：原生待批队列 `pendingOf/notePending` + 批量 `tool="Bash,Write"` |
| **L3** | FGA · TTL 临时权限令牌 | ✅ | 2026-10-18 补：`sweepGrants` + `TTL_MAX_MS`（turn 30min / task 4h / persist 24h）|
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
| **L6** | 伪 RLHF 闭环（反馈落盘 → A/B 验证） | 🟡 | **半**：`bench:ab` / `bench:tasks` / `task-control` 已能做 A/B 与成本对照；缺"反馈自动回流到 L1/L2 参数" |
| **L7** | 工作流：提方向 → 验可行 → 下需求 | 🟡 | 指令级（`$DSH_HOME/AGENTS.md`），非代码强制 |
| **L7** | 元审查：L1 输出 / L2 日志 / L3 status | ✅ | `npm run bench:decision`、`.focus-guard/AUDIT.log`、`status.mjs` |
| **K** | 知识输入层 | ✅ | `docs/RULES.md`、`docs/MASTER-PLAN-3.0.0.md`、技能库 |

---

## 缺口清单（按优先级）

| # | 缺口 | 影响 | 建议做法 |
|---|---|---|---|
| 1 | **FGA 默认只读 / 隐藏高危工具** | 每步固定前缀实测 **≈127k tokens（253 个工具）**——主图里唯一真正压 token 的一块 | 需宿主支持"按任务动态暴露工具"；FG 侧只能建议。落地前先用 `bench:ab` 记基线 |
| 2 | 画像包三件（evasionRisk / 相位对抗 / Nudge） | 影响"越狱抵抗"与重试成本，不影响主流程 | 先做 `evasionRisk` 字段（纯参数）→ 再评估相位对抗（对抗同前缀缓存盲区）|
| 3 | 伪 RLHF 闭环只做了一半 | 有 A/B 与成本数据，但**没有回流** | 把 `bench:ab` 结论写回 `src/profiles/*.mjs` 的参数（人工批准制），形成"测量→调参→再测" |
| 4 | 反规避的随机熔断未参数化 | 抽查有、随机熔断没有 | 用 `RANDOM_AUDIT_EVERY` 之外的独立参数，2-5 次随机一次，勿与抽查混 |

---

## 成本事实（2026-10-18 实测，供后续判断）

```
单步固定前缀    ≈ 127,435 tokens（253 工具 schema 496,915 字符 + 系统提示 12,825 字符）
其中 mcp:rea    170 个工具 / 436,414 字符 ≈ 109,104 tok = 87.9%   ← 已于当日关闭，见下
A/B 会话对比    A(FG 关) 538,599 tok / $0.0306   B(FG 开) 1,510,638 tok / $0.0311
缓存命中        A 65.5% / B 88.8%
真实贵的部分    A 未缓存+输出 187,751 → B 172,270（−8.3%）
```

### 已执行的裁剪（2026-10-18）

`web` profile 的 `cordis.patch.yml` 里 `mcp-client-rea` 整块已注释（保留原文，去三行 `#` 即恢复）。
关闭后 `dsh --profile web --dump-config` 条目 320 → 319，`serverName: rea` 命中 0。

预期收益（按 B 组 9 步实测外推）：单步前缀 124k → ~15k tok，该会话成本 $0.0311 → ≈$0.012（**−60%**）。
备份：`cordis.patch.yml.bak-rea-off-20261018-211011`。**恢复需托盘退出并重启 Desktop。**

结论：现状 FG **成本几乎持平（+1.6%）**；主图落地后预期 **−30%～−60%**，全部收益来自第 1 项（工具面收窄）。
