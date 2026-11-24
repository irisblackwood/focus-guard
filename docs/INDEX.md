# 文档索引（docs/INDEX.md）

> **状态**：权威 · 适用版本 3.5.3 · 最后核对 2026-11-19

> 3.3 D2：新会话按本页在 **10 分钟**内定位到该读的那份文档。
> 状态口径：**权威** = 与实现同步、可据此裁决；**参考** = 有价值但可能滞后；**台账** = 过程记录，读取前先看日期；**归档** = 已过期，仅作历史。
> 最后核对日期由 `npm run docs:lint` 的版本面 + 链接可达两项兜底；D2 完成后每份权威文档另带状态头。

## 一、10 分钟接手路径

1. 安装 / 部署 → [INSTALL.md](../INSTALL.md)
2. 法条（判定依据）→ [RULES.md](../packages/core/docs/RULES.md)
3. 架构状态与缺口 → [ARCH-MAP.md](../packages/core/docs/ARCH-MAP.md)
4. 版本计划 / 里程碑语义 → [VERSION-PLAN.md](../packages/core/docs/VERSION-PLAN.md)
5. 发版规矩 → [RELEASE-POLICY.md](../packages/core/docs/RELEASE-POLICY.md)
6. 基准与数字单点 → [BENCH.md](../packages/core/docs/BENCH.md)
7. 变了什么 → [CHANGELOG.md](../CHANGELOG.md)；为什么这么改 / 排到哪 → [VERSION-PLAN.md](../packages/core/docs/VERSION-PLAN.md)；过程记录 → [HANDOFF-2026-10-27.md](archive/HANDOFF-2026-10-27.md)（已归档；3.2.x 时期那一轮，**此后未再写 HANDOFF**）
8. **发现新缺口怎么记账** → [RULES.md](../packages/core/docs/RULES.md) **第十五章之四（第九十二条）**：适用范围、标记编排版本、两条必写理由、记录不等于动手、验收须可复跑
9. **记忆改革要抄什么、不抄什么** → [MEMORY-4.5-PLAN.md](../packages/core/docs/MEMORY-4.5-PLAN.md) **§五·补**：外部参照 `memory-brain` 的**48 条可抄清单**（判据 7 / 参数 8 / 工程 9 / 开机包 10 / 注入 4 / 输出护栏 6 / 幂等 4），**三个最大差距**是「没有降级为倾向这一档」「据是结论不是方法」「没有开机包」；另有**8 件不抄**、**3D 脑 UI 与 CC BY-SA 3.0 红线**、不接运行时的两条硬理由，以及写死的判据「记忆的消费者是闸门，不是模型」
10. **改判定链之前查什么、这些约束从哪来** → 两份配对读：[DESIGN-CONSTRAINTS.md](DESIGN-CONSTRAINTS.md)（判据）+ [THEORY-BASIS.md](THEORY-BASIS.md)（来源）。前者十一条约束、失效模式与落点；后者七层理论、50 脑区归类、记忆与神经元机制、8 篇文献。**约束必须能说出「不做会怎么坏」，说不出的不进判据页**
11. **哪些漏洞要修、哪些按判据不做** → [THREAT-MODEL.md](../packages/core/docs/THREAT-MODEL.md)：判据是「**本插件不防攻击者，防的是插件自己把用户的机器/数据弄坏**」。含四类损害（删用户东西 / 漏凭据 / 写坏文件 / 静默失效）、2026-11-01 红队的已修清单，以及**三条明确不做**（属主校验 / 状态签名 / `FG_PYTHON` 白名单）——**别再把它们当缺口翻出来**
12. **文档自身怎么校验** → `npm run docs:lint`（状态头 / 链接 / 版本面）+ `npm run docs:drift`（文档里的 npm 命令、仓库路径、`FG_*` 变量是否真实存在；`--strict` 已进 `check`）+ `npm run modules:table`（模块最后一次改动）

## 二、文档目录

> **状态 / 适用版本 / 最后核对 / 落后几档，统一看 [STATUS.md](STATUS.md)，本页不抄。**
> **份数、模块数、行数一类会变的计数，本页也不抄**——写「40 份」的那行在文档涨到 42 份时就成了假话，
> 而没有任何判据盯着本页的描述列（它只查链接可达与覆盖完整）。要数字就去源表取。
>
> 2026-11-19 之前本页手抄过这三列，结果 **18 处与文档自己的状态头对不上**：
> `RULES.md` 自己写 3.3.0·10-28，本页写 3.2.1·10-27；`ARCH-MAP.md` 自己写 3.5.2，本页写 3.2.1。
> 旧判据只查「链接点不点得到」，**不查抄的数字对不对**，两份真值就这样分叉了二十多天。
> 修法是**取消手抄**：真值只有一个（每份文档开头那行 `> **状态**：…`），
> `npm run docs:status` 把它拼成 [STATUS.md](STATUS.md)，手改会被 `docs:lint` 判 `status-table-stale`。

| 文档 | 角色 |
|---|---|
| [docs/README.md](README.md) | **文档导读（先读这页）**：按角色选路 / 文档为什么分三处放 / 逐份「它回答什么、什么时候读、别拿它干什么」；**不知道读什么时从这里进**，本页只管「某份在哪」 |
| [STATUS.md](STATUS.md) | **全仓文档的状态总表（自动生成）**：谁落后几档、谁多久没核对，一页看完；份数以表内「合计」为准，本页不抄数字 |
| [MODULES.md](MODULES.md) | **代码模块修订台账（自动生成）**：35 个功能模块各自的最新/中位/最久修订位置，以及「其后全仓又提交了多少次」；防某块被遗忘 |
| [README.md](../README.md) | 入口页：30 秒速览 / 快速开始 / 文档地图 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 机制正文（触发/处罚/预算/卷宗/审批/资格/委派/配置/环境变量） |
| [GOVERNANCE-LAYERS.md](GOVERNANCE-LAYERS.md) | 五层治理对账 + 四条待裁决 + 编排版本 |
| [DESIGN-CONSTRAINTS.md](DESIGN-CONSTRAINTS.md) | 十一条设计约束 + 失效模式 + 落点；零件→约束转换规则 |
| [THEORY-BASIS.md](THEORY-BASIS.md) | 约束的来源：七层理论 / 脑区归类 / 记忆与神经元机制 / 文献清单 |
| [THREAT-MODEL.md](../packages/core/docs/THREAT-MODEL.md) | 四类损害 + 已修清单 + 三条明确不做 |
| [INSTALL.md](../INSTALL.md) | 唯一安装源 |
| [CHANGELOG.md](../CHANGELOG.md) | 发布记录（变了什么） |
| [RULES.md](../packages/core/docs/RULES.md) | 法条与未机械化清单 |
| [ARCH-MAP.md](../packages/core/docs/ARCH-MAP.md) | 能力状态 + 代码锚点 + 缺口 |
| [VERSION-PLAN.md](../packages/core/docs/VERSION-PLAN.md) | **计划唯一载体**：3.3→4.0 排期与完成态语义，含 §1.7 测试债务六档（3.5.4→3.5.9）与退出判据 |
| [RELEASE-POLICY.md](../packages/core/docs/RELEASE-POLICY.md) | 计数 / 受众口径 / 版本面 |
| [WRITING-STYLE.md](../packages/core/docs/WRITING-STYLE.md) | 文档排版判据 |
| [BENCH.md](../packages/core/docs/BENCH.md) | 基准跑法与数字快照 |
| [MEMORY-RECALL-EVAL.md](../packages/core/docs/MEMORY-RECALL-EVAL.md) | 记忆检索离线评测：结构化全量注入 vs 向量检索；**向量是 TF-IDF 稀疏向量，非语义**，qrels 为词项启发式 |
| [MEMORY-HYBRID.md](../packages/core/docs/MEMORY-HYBRID.md) | 记忆检索混合接入：三档 × 四档规模的 token/召回/延迟定量对比，分档阈值、钉选硬上限、四阶段迁移；**检索做成工具而非自动注入**（否则毁前缀稳定） |
| [PROFILE-TUNING.md](../packages/core/docs/PROFILE-TUNING.md) | 画像回流台账（人工批准制） |
| [MCP-4.0-PLAN.md](../packages/core/docs/MCP-4.0-PLAN.md) | 4.0 Hook 完全态调研 |
| [MEMORY-4.5-PLAN.md](../packages/core/docs/MEMORY-4.5-PLAN.md) | 4.5 记忆系统独立 / 静态知识库 / 伪 RLHF 联动；**§八 沉淀与检索三层路线**（先修沉淀再谈检索） |
| [MEMORY-RECALL-EVAL.md](../packages/core/docs/MEMORY-RECALL-EVAL.md) | 记忆检索离线评测：结构化全量注入 vs 向量 top-k，召回率与 token 对照 |
| [BRAIN-VIZ.md](../packages/core/docs/BRAIN-VIZ.md) | 脑可视化渲染实现：一个脚本三种跑法 / 星空与黑洞怎么画 / draw call 拆分 |
| [LEGISLATION-LAW.md](../packages/core/docs/LEGISLATION-LAW.md) | 立法程序 |
| [HOOK-ORDERING.md](../packages/core/docs/HOOK-ORDERING.md) | 钩子定序核查（四条路与各自代价） |
| [packages/core/README.md](../packages/core/README.md) | 核心包英文说明 |
| [packages/core/README.zh-CN.md](../packages/core/README.zh-CN.md) | 核心包中文说明 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 提交与 CLA |
| [packages/extended/bridges/README.md](../packages/extended/bridges/README.md) | 外接桥契约 |
| [vault-notes/](vault-notes/) | 外部资料摘录：厂商研读 + FG3 要点摘录。**正文被 `.git/info/exclude` 屏蔽，仓内只有题录清单**（换机后用 `npm run privacy:gate` 重建）；非项目事实源，**不作裁决依据** |

> **2026-11-07 核对范围（只报核过的）**：`ARCHITECTURE.md` 只核了卷宗 / 留痕 / 环境变量三节——发现并改正 3 处（TTL 判据还写着已废弃的四档阶梯、3 个 `FG_*` 漏登记、计数与表行数不符），并补了两条保留上限；其余章节沿用上次核对日期，未逐条复核。`CHANGELOG.md` 核了段划分：≤3.0.7 的 16 个版本段已原样移入 [archive/CHANGELOG-3.0.7-and-earlier.md](archive/CHANGELOG-3.0.7-and-earlier.md)。

## 三、过程台账（读前看日期，不作裁决依据）

> **出口规则**（2026-10-31 补）：满足任一条即移入第四节归档——
> ① 超过 30 天未更新；② 它对应的版本/里程碑已发布；③ 已被更新的同类文件取代。
>
> 补这条的理由：原先只有「读前看日期」，没有**什么时候该走**。结果是台账只进不出——
> HANDOFF 攒到第 6 份，前 5 份都归档了，最新那份永远留在原地；历史计划也从没被移走。
> **有入口、没出口，是这一类问题的通病**（同日发现的棘轮台账、豁免清单同理）。

| 文档 | 内容 | 状态 |
|---|---|---|
| [HANDOFF-2026-10-27.md](archive/HANDOFF-2026-10-27.md) | 审计工具三连跑 → 分层拆分 → 健康分 | 台账（已归档，2026-11-22） |
| [AB-PROMPTS.md](../packages/core/docs/AB-PROMPTS.md) | A/B 采集协议 | 台账（测量协议，可复用） |
| [AB-SESSION.md](../packages/core/docs/AB-SESSION.md) | 一次 A/B 会话记录 | 台账（一次记录，属证据） |
| [deepseek-pricing-audit.md](../packages/core/docs/deepseek-pricing-audit.md) | 价目核对 | 台账（外部事实，带日期可追溯） |

> 「待归档两份物理未搬」那段已删（2026-11-19）：指的是 `MASTER-PLAN-2.0.0` / `3.0.0`，
> 它们早在 `6e2ffe5` 就真搬进 `docs/archive/` 了，说明文字却一直留着。
> **说明留在原地、被说明的对象已经走了，是台账最常见的假话形态**——和「40 份」同一类。

## 四、归档（勿引用）

| 文档 | 原因 |
|---|---|
| [HANDOFF.md](../HANDOFF.md) | 3.0.5 阶段一交接，正文已过期（**勿读作现状**）。**物理留在仓根、不可搬**：`seams/session-start.mjs` 按此路径做交叉巡视（存在性检查），源码另有 15 处注释以「HANDOFF §八/§九/§十」为锚点——搬走或删节会把它们变成断链。2026-11-24 补登（此前本页 0 次提及） |
| [archive/HANDOFF-TO-EXTERNAL.md](archive/HANDOFF-TO-EXTERNAL.md) | 2026-10-09 对外说明，已过期 |
| [archive/HANDOFF-2026-10-18.md](archive/HANDOFF-2026-10-18.md) | 2026-10-18 交接，已过期（现行台账是 10-27） |
| [archive/HANDOFF-2026-10-19.md](archive/HANDOFF-2026-10-19.md) | 2026-10-19 交接，已过期 |
| [archive/HANDOFF-2026-10-19-evening.md](archive/HANDOFF-2026-10-19-evening.md) | 2026-10-19 晚间交接，已过期 |
| [archive/HANDOFF-2026-10-22.md](archive/HANDOFF-2026-10-22.md) | 2026-10-22 交接，已过期 |
| [archive/HANDOFF-2026-10-26.md](archive/HANDOFF-2026-10-26.md) | 2026-10-26 交接，已过期 |
| [archive/MASTER-PLAN-2.0.0.md](archive/MASTER-PLAN-2.0.0.md) | 2.0 卷宗重构总纲，2.0 已发布（命中出口规则②） |
| [archive/MASTER-PLAN-3.0.0.md](archive/MASTER-PLAN-3.0.0.md) | 3.0 协作治理总纲，3.0 已完成（命中出口规则②） |
| [docs/vault-notes/README.md](vault-notes/README.md) | 外部资料摘录，非项目事实源 |

## 维护

- 新增权威文档必须进本页**与 [README.md](README.md)**；过期文档先改状态、再移归档。
- 两页分工：本页是**表**（按名字/任务查），`README.md` 是**路**（按角色读）。新增文档两页一起改，删归档也一起改。
- `docs/INDEX.md` 自身由 `npm run docs:lint` 检查链接；版本面由 `check` 兜底。
