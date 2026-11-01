# 文档索引（docs/INDEX.md）

> **状态**：权威 · 适用版本 3.3.1 · 最后核对 2026-10-31

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
7. 变了什么 → [CHANGELOG.md](../CHANGELOG.md)；为什么 → 最新一份 HANDOFF
8. **发现新缺口怎么记账** → [RULES.md](../packages/core/docs/RULES.md) **第十五章之四（第九十二条）**：适用范围、标记编排版本、两条必写理由、记录不等于动手、验收须可复跑
9. **记忆改革要抄什么、不抄什么** → [MEMORY-4.5-PLAN.md](../packages/core/docs/MEMORY-4.5-PLAN.md) **§五·补**：外部参照 `memory-brain` 的**48 条可抄清单**（判据 7 / 参数 8 / 工程 9 / 开机包 10 / 注入 4 / 输出护栏 6 / 幂等 4），**三个最大差距**是「没有降级为倾向这一档」「据是结论不是方法」「没有开机包」；另有**8 件不抄**、**3D 脑 UI 与 CC BY-SA 3.0 红线**、不接运行时的两条硬理由，以及写死的判据「记忆的消费者是闸门，不是模型」
10. **哪些漏洞要修、哪些按判据不做** → [THREAT-MODEL.md](../packages/core/docs/THREAT-MODEL.md)：判据是「**本插件不防攻击者，防的是插件自己把用户的机器/数据弄坏**」。含四类损害（删用户东西 / 漏凭据 / 写坏文件 / 静默失效）、2026-11-01 红队的已修清单，以及**三条明确不做**（属主校验 / 状态签名 / `FG_PYTHON` 白名单）——**别再把它们当缺口翻出来**

## 二、权威文档

| 文档 | 角色 | 状态 | 适用版本 | 最后核对 |
|---|---|---|---|---|
| [README.md](../README.md) | 入口页：30 秒速览 / 快速开始 / 文档地图 | 权威 | 3.2.1 | 2026-10-28 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 机制正文（触发/处罚/预算/卷宗/审批/资格/委派/配置/环境变量） | 权威 | 3.2.1 | 2026-10-29 |
| [INSTALL.md](../INSTALL.md) | 唯一安装源 | 权威 | 3.2.1 | 2026-10-24 |
| [CHANGELOG.md](../CHANGELOG.md) | 发布记录（变了什么） | 权威 | 3.2.1 | 2026-10-28 |
| [RULES.md](../packages/core/docs/RULES.md) | 法条与未机械化清单 | 权威 | 3.2.1 | 2026-10-27 |
| [ARCH-MAP.md](../packages/core/docs/ARCH-MAP.md) | 能力状态 + 代码锚点 + 缺口 | 权威 | 3.2.1 | 2026-10-27 |
| [VERSION-PLAN.md](../packages/core/docs/VERSION-PLAN.md) | 3.3→4.0 排期与完成态语义 | 权威 | 3.2.1 | 2026-10-28 |
| [RELEASE-POLICY.md](../packages/core/docs/RELEASE-POLICY.md) | 计数 / 受众口径 / 版本面 | 权威 | 3.2.1 | 2026-10-28 |
| [WRITING-STYLE.md](../packages/core/docs/WRITING-STYLE.md) | 文档排版判据 | 权威 | 3.2.1 | 2026-10-27 |
| [BENCH.md](../packages/core/docs/BENCH.md) | 基准跑法与数字快照 | 权威 | 3.2.1 | 2026-10-22 |
| [PROFILE-TUNING.md](../packages/core/docs/PROFILE-TUNING.md) | 画像回流台账（人工批准制） | 权威 | 3.2.1 | 2026-10-29 |
| [MCP-4.0-PLAN.md](../packages/core/docs/MCP-4.0-PLAN.md) | 4.0 Hook 完全态调研 | 参考 | 4.0 前置 | 2026-10-19 |
| [MEMORY-4.5-PLAN.md](../packages/core/docs/MEMORY-4.5-PLAN.md) | 4.5 记忆系统独立 / 静态知识库 / 伪 RLHF 联动 | 参考 | 4.5 前置 | 2026-10-30 |
| [LEGISLATION-LAW.md](../packages/core/docs/LEGISLATION-LAW.md) | 立法程序 | 参考 | 3.2.1 | 2026-10-27 |
| [HOOK-ORDERING.md](../packages/core/docs/HOOK-ORDERING.md) | 钩子定序核查（四条路与各自代价） | 参考 | 3.3.0 | 2026-10-29 |
| [packages/core/README.md](../packages/core/README.md) | 核心包英文说明 | 参考 | 3.2.1 | 2026-10-27 |
| [packages/core/README.zh-CN.md](../packages/core/README.zh-CN.md) | 核心包中文说明 | 参考 | 3.2.1 | 2026-10-27 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 提交与 CLA | 参考 | 3.2.1 | 2026-10-19 |
| [packages/extended/bridges/README.md](../packages/extended/bridges/README.md) | 外接桥契约 | 参考 | 3.2.1 | 2026-10-08 |

## 三、过程台账（读前看日期，不作裁决依据）

> **出口规则**（2026-10-31 补）：满足任一条即移入第四节归档——
> ① 超过 30 天未更新；② 它对应的版本/里程碑已发布；③ 已被更新的同类文件取代。
>
> 补这条的理由：原先只有「读前看日期」，没有**什么时候该走**。结果是台账只进不出——
> HANDOFF 攒到第 6 份，前 5 份都归档了，最新那份永远留在原地；历史计划也从没被移走。
> **有入口、没出口，是这一类问题的通病**（同日发现的棘轮台账、豁免清单同理）。

| 文档 | 内容 | 状态 |
|---|---|---|
| [HANDOFF-2026-10-27.md](../packages/core/docs/HANDOFF-2026-10-27.md) | 审计工具三连跑 → 分层拆分 → 健康分 | 台账（最新，2026-10-27） |
| [AB-PROMPTS.md](../packages/core/docs/AB-PROMPTS.md) | A/B 采集协议 | 台账（测量协议，可复用） |
| [AB-SESSION.md](../packages/core/docs/AB-SESSION.md) | 一次 A/B 会话记录 | 台账（一次记录，属证据） |
| [deepseek-pricing-audit.md](../packages/core/docs/deepseek-pricing-audit.md) | 价目核对 | 台账（外部事实，带日期可追溯） |

> 「待归档」两份**物理未搬**：各被 6 处引用（含 `changelog-format` 测试），搬一份要同步改 6 处，
> 改漏就断链。先标状态、不搬文件——**标记是判据，搬运是动作，判据可以先落地**。

## 四、归档（勿引用）

| 文档 | 原因 |
|---|---|
| [archive/HANDOFF-TO-EXTERNAL.md](archive/HANDOFF-TO-EXTERNAL.md) | 2026-10-09 对外说明，已过期 |
| [archive/HANDOFF-2026-10-18.md](archive/HANDOFF-2026-10-18.md) | 2026-10-18 交接，已过期（现行台账是 10-27） |
| [archive/HANDOFF-2026-10-19.md](archive/HANDOFF-2026-10-19.md) | 2026-10-19 交接，已过期 |
| [archive/HANDOFF-2026-10-19-evening.md](archive/HANDOFF-2026-10-19-evening.md) | 2026-10-19 晚间交接，已过期 |
| [archive/HANDOFF-2026-10-22.md](archive/HANDOFF-2026-10-22.md) | 2026-10-22 交接，已过期 |
| [archive/HANDOFF-2026-10-26.md](archive/HANDOFF-2026-10-26.md) | 2026-10-26 交接，已过期 |
| [archive/MASTER-PLAN-2.0.0.md](archive/MASTER-PLAN-2.0.0.md) | 2.0 卷宗重构总纲，2.0 已发布（命中出口规则②） |
| [archive/MASTER-PLAN-3.0.0.md](archive/MASTER-PLAN-3.0.0.md) | 3.0 协作治理总纲，3.0 已完成（命中出口规则②） |
| [docs/vault-notes/README.md](vault-notes/README.md) | 外部资料摘录，非项目事实源 |
| [packages/core/skills/focus-thinking/SKILL.md](../packages/core/skills/focus-thinking/SKILL.md) | 旧技能入口，技能目录已迁到 `.agents/skills-core/` |

## 维护

- 新增权威文档必须进本页；过期文档先改状态、再移归档。
- `docs/INDEX.md` 自身由 `npm run docs:lint` 检查链接；版本面由 `check` 兜底。
