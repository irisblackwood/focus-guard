# 架构主图（长期规划基线）

> **状态**：权威 · 适用版本 3.3.0 · 最后核对 2026-10-28

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

## FG 工具链（2026-10-27 内置化，零依赖）

四个自研工具替代了此前"临时目录里跑第三方"的做法。**全部零依赖**（不装包、不进 `node_modules`），
判定逻辑抽到 `tools/lib/` 以便测试。`dependencies` 与 `devDependencies` 至今为空。

| 工具 | 替代谁 | 口径 | 现状数字 |
|---|---|---|---|
| `tools/lint.mjs` | `dsh-code-check`（ESLint fallback） | 5 条规则：死 import / 重复 import / `var` / 宽松相等 / `console` 留在母版或适配层。**不报** `curly`（本仓房规）、`== null`（惯用法）、空 catch（三级兜底） | 128 文件，54 条，**全在已封存 `hooks/`**；活跃层 0 条 |
| `tools/smells.mjs` | `dsh-refactor-insight` | 文件行数 400 / 函数行数 80 / 嵌套 5 层；源文件与测试文件**分开报**；**不报** `todo-density`（分不出"已申报"与"已遗忘"） | 源文件 **8 条** / 测试 5 条；头三名 `guard.mjs` 1169 行（封存）、`eligibility-gate.mjs` 639 行、`postProgress.mjs` 506 行 |
| `tools/health.mjs` | `brooks-lint` | 四维加权（房规 .25 / 结构 .30 / 测试 .25 / 口径 .20），扣分**不封顶**（每维扣满 70 为止，保底 30） | **93/100**，唯一扣分项是结构维（76 分） |
| `tools/mutate.mjs` | `@stryker-mutator/*`（按需） | 6 类算子 + **import 图选测试**；跑在 `packages/` 临时副本里，真实源码永不被改；变异前后各验一次基线 | `postProgress` 145 变异体 → 杀 41（28.3%）；`toolName` 2 个 → 1 杀 1 活（50%） |

三条共同纪律，都是踩出来的：

1. **闸门用债务上限（棘轮），不用"有问题就红"。** `--strict` 曾经是"有任何一条就 exit 1"，
   而存量 54 条房规 / 28 条结构问题短期清不到零 → 闸门**永远红** → 训练人忽略告警
   （`schema:verify` 上踩过同一个坑）。现为：房规只数活跃层（上限 0）、结构上限 **8**、健康分下限 **93**，只许降不许升。
2. **已封存代码的债务不算当前债务。** 54 条房规全在 `hooks/`（4.0 要废弃的挂脚本），
   算进健康分会重演 `dsh-code-check` 的 0/100。现在 src 层计分、`hooks/` 只报不计。
3. **工具的分数可能是假的，明细通常是真的。** 第三方评分先问"扣分项里有多少是本项目房规"；
   自己写的工具也一样——`mutate` 首次跑出 `toolName` 2/2 全杀，复跑变 0/2，
   真相是某次测试的残留状态偶发失败被算成"杀死"。现加了**循环后基线复验**，红就标"不可信"而不报数字。

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
| **L2** | 系统提示 / 示例池 / 严格模式 | ✅ | `src/dsh/pipeline.mjs` 编排 + `src/dsh/guard/runtime.mjs` 的 `systemPromptListener` 注入（rules + cost + workspace 三段；2026-10-27 起熔断期间追加第四段 `focus-guard-fuse`，文案在母版 `constants.FUSE_NOTICE`，见 `src/dsh/index.js` 装配缝）|
| **L2** | Superpowers 澄清→计划→TDD→验证 | 🟡 | 动笔闸 ✅（`guard/superpowers.mjs` 的 `superpowersStage`）；方法论本体是外部技能 |
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
| **L4** | 卷宗哈希路由 + 新会话过滤注入 | ✅ | `workspace.mjs` 回合落账；hash 不符零注入 |
| **L4** | **跨会话快速交接**（2026-10-22） | ✅ | `workspace.mjs` 的 `snapshot`（工具调用/被拦/KPI/委托，覆盖式、只存 FG 数得出的量）+ `shouldInjectHandoff()`（仅换会话时注入快照行，同会话不重复）+ `renderWorkspaceSection(record,{sid})`；CLI `npm run handoff` 打印简报。**不推断"做到哪了"** |
| **L5** | 无 `[文件:行号]` 打回 | ✅ | `src/dsh/stopGuard.mjs` |
| **L5** | 体积刺客阻断（禁裸 cat 等） | ✅ | `guard/volume.mjs` 体积三闸 + `guard/hardCheck.mjs` 硬校验 |
| **L5** | 高危操作拦截 | ✅ | 红线 + 资格闸 + 语义层观察模式 |
| **L5** | 反规避 · 不可预测检查点 | ✅ **默认开** | 抽查A：`RANDOM_AUDIT_EVERY`（确定性每 5 次全量审计，`postProgress.mjs:362`）。抽查B（2026-10-19 参数化）：独立参数 `FG_RANDOM_FUSE=1`（间隔 `[2,5]` 随机，`core/constants.mjs` 的 `RANDOM_FUSE_MIN/MAX`）或 `FG_RANDOM_FUSE_EVERY=N`（固定）；post-execute 只挂检查点（`postProgress.mjs:374`）。**2026-10-27 改：默认只留痕不打断**——pre-execute 第 3 层只清 `randomFusePending`，不再 deny（理由：拒一次必然多一次工具往返，而它不核对任何内容，理由原文就是"重试即放行"；实测 20 天 61 次全在 1 个长会话）。旧语义保留在 `FG_RANDOM_FUSE_BLOCK=1`（`guard/evidence.mjs` 的 `layer3Check`）。与抽查A 完全独立。**默认开**（2026-10-19 晚人类批示；FG_RANDOM_FUSE=0 关闭） |
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
| 3 | 伪 RLHF 闭环缺的是**测量侧**，不是回流侧 | 回流台账（`docs/PROFILE-TUNING.md`）已建。**T2 已有数字缺判据**（`budget-extend` 19 行 / 3 会话，分母 53 会话 ≈ 5.7%，但"多高算偏紧"没有经验阈值）。**T3 的指标 2026-10-19 已补**：审计行带 `turn`/`step`（`src/dsh/traceMeta.mjs` + `core/audit-writer.mjs` provider），回合结束结算 `fuse-waste`（`bench:cost` 的 `fuseWaste`，按会话独立计数）；但历史 57 次熔断无元数据 → 仍需新会话样本 | T2：攒样本定判据；T3：等新会话真熔断后读 `fuseWaste.bySession`，样本够再谈调阈值。在此之前保持参数不动 |
| 4 | 反规避抽查B **默认开**，但**已不打断**（2026-10-27） | 原"每 2–5 次写操作拒一次"必然多一次工具往返，且不核对任何内容；现改为只留痕。手感变化已消失；`FG_RANDOM_FUSE=0` 可关，`FG_RANDOM_FUSE_BLOCK=1` 恢复旧"拒一次" | 按 `AUDIT.log` 的 `random-fuse` 行观察留痕密度；若确需时序干扰再开 `FG_RANDOM_FUSE_BLOCK` |
| 5 | **缺 3.0.8 面板基线**（人类 2026-10-19 确认暂无数据） | 没有基线，L1/L6 的任何"优化了多少"都无法复算，只能写条件性结论 | 按 `AB-PROMPTS.md` P0 节采集：同 web profile、同 8 任务、每轮开新会话、被拦禁止重试，连跑 ≥5 次；只记面板六项 + session id + steps/denies，取中位数；判定口径必须能由「3 个面板数 + 1 个 session id + 1 个公式」复算 |
| 6 | ~~**质量门强度不可测 + 增补章 14 条未交代**~~ → **口径侧已归零；强度侧已能测（抽样）**（2026-10-27 二修） | **口径侧**：增补章 18 条逐条核实，5 条补映射、9 条进未机械化清单，`npm run quality:audit` 报 **0 未交代**。**强度侧**：已内置 `tools/mutate.mjs`（零依赖抽样变异），用 import 图选测试，不跑全量。**首次测得真实数字**：`dsh/postProgress.mjs` 145 个变异体 → 杀 41 / 存活 104（28.3%）；`dsh/toolName.mjs` 2 个 → 1 杀 1 活（50%），`zcodeToolName` 的工具名回退链只被间接覆盖。读法见缺口 #7 的说明：存活里混着等价变异体，**不可与 Stryker 覆盖率分数直接比** | 强度：`npm run mutate -- <模块>`（明细）、`npm run mutate:smoke`（1 秒冒烟）；完整度量仍用 `npm run quality:mutate`（Stryker，需联网拉包，`break: 80`）。**注意**：变异跑在 `packages/` 的临时副本里，真实源码永不被改；基线红或循环后变红一律判"不可信"而不报假分数 |
| 7 | **宿主缝仍承担判定（阶段 2 第三刀未做）**（2026-10-27 brooks 复核） | ~~`src/dsh/postProgress.mjs` 的 `postProgressListener` 单闭包 320 行，按段落堆放 7 个互不相干的职责~~ → **2026-10-27 已拆**：9 个命名函数，监听器 **320 → 46 行**（文件 427→502，涨的是签名与段落注释）。**仍欠**：① ~~`preExecuteListener` 400 行、9 个段落，同一个 Divergent Change~~ → **2026-10-27 第六批已拆**：`pipeline.mjs` 只留 106 行编排（`PRE_STAGES` 顺序表），实现分到 `guard/` 10 个模块；② 拆开只解决"一个函数多职责"，判定逻辑本身仍在宿主缝；③ `seams.mjs` 498 行仍是浅模块 | **`preExecuteListener` 暂不拆，风险不对称**：`postProgress` 拆坏 → 事后记账错，测试能抓；它拆坏 → **闸门变松**，而测试抓的是"该拦的没拦"，抓不住"不该放的放了"。拆它需先有"闸门强度"度量兜底 → **`npm run mutate` 已能给出该度量**（见缺口 #6），下一步是给 9 个闸门各跑一遍，拿到杀伤率再动。**先看 postProgress 的 104 个存活**：其中大量集中在 `sidOf`/`projDirOf`/`trackReadSet` 的 `&&`/`\|\|` 回退链——测试只断言"吐出的 reason"，不断言 state 记账（readSet / caseCache / scriptFiles）。这是拆 `preExecuteListener` 之前必须补的一层——**2026-10-27 第六批已按层拆完**（10 模块 / 106 行编排，`npm run check` 522/522） |
| 8 | **`dsh-code-check` 的评分对 FG 归零**（2026-10-27 实测） | 其线性模型 `100 − errors×8 − warnings×3 − …` 代入 681 warnings 得 0/100。归零唯一原因是 `curly` 586 条——FG 房规"单语句块不加大括号" vs ESLint 默认 `curly: all`。**是配置错配不是缺陷**，关掉后同批代码 95 warnings。该分数不能当质量门，只可取明细 | 若要引入，先在其 `eslint.fallback.config.mjs` 层把 `curly` 设 `off`、`eqeqeq` 设 `smart`、`globals` 补 `performance`；否则分数永远是 0，会重演"质量门没用" |

---

## 版本路线（2026-10-19 人类定；执行清单见 [`VERSION-PLAN.md`](VERSION-PLAN.md)）

| 版本 | 目标 | 前置 |
|---|---|---|
| **3.3**（已切，2026-10-30） | **校验链补漏**：A 行内路径校验、A′ 引用修复、B 棘轮台账、C 评估口径；E/F/D 见 §1.3 | 见 [`VERSION-PLAN.md`](VERSION-PLAN.md) §1.2 的执行台账 |
| **近程**（3.0.9 候选） | 面板基线 → 重启验证 turn/step 与 fuse-waste → 抽查B 观测 → 契约探针（需批） → 20:00 推送；发版另行决定 | 见 [`VERSION-PLAN.md`](VERSION-PLAN.md) §1 的 N1–N6 |
| **3.5** | 文档重置：D1 README 瘦身（402→≤160 行）、D2 `docs/INDEX.md`、D3 旧交接归档、D4 数字单点化、D5 `docs:lint` 并入 check、D6 `RULES` 技术映射表核对 | 面板基线（缺口 #5）先有，否则文档里的成本口径仍是条件性 |
| **4.0** | 废除外挂脚本 Hook（`hooks/guard.mjs`），内核迁入 **MCP 常驻进程**，Hook 降级为 HTTP 触发线（方案 [`MCP-4.0-PLAN.md`](MCP-4.0-PLAN.md)） | 3.5 文档重置完成；P0 spike 先实测 deny / `updatedInput` / turn-step 三件事 |

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
A/B 会话对比    ⚠ 2026-10-22 起**已作废**，数字唯一源改到 BENCH.md「历史样本」
                A(FG 关) 538,599 tok / 3 步 / 0 拦截；B(FG 开) 1,510,638 tok / 9 步 / 7 拦截
                （作废原因：两臂步数 3 vs 9 不可比；10-19 另一组为带病测量）
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
