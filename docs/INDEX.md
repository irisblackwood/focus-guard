# 文档索引（docs/INDEX.md）

> **状态**：权威 · 适用版本 3.2.1 · 最后核对 2026-10-28

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

## 二、权威文档

| 文档 | 角色 | 状态 | 适用版本 | 最后核对 |
|---|---|---|---|---|
| [README.md](../README.md) | 入口页：30 秒速览 / 快速开始 / 文档地图 | 权威 | 3.2.1 | 2026-10-28 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 机制正文（触发/处罚/预算/卷宗/审批/资格/委派/配置） | 权威 | 3.2.1 | 2026-10-28 |
| [INSTALL.md](../INSTALL.md) | 唯一安装源 | 权威 | 3.2.1 | 2026-10-24 |
| [CHANGELOG.md](../CHANGELOG.md) | 发布记录（变了什么） | 权威 | 3.2.1 | 2026-10-28 |
| [RULES.md](../packages/core/docs/RULES.md) | 法条与未机械化清单 | 权威 | 3.2.1 | 2026-10-27 |
| [ARCH-MAP.md](../packages/core/docs/ARCH-MAP.md) | 能力状态 + 代码锚点 + 缺口 | 权威 | 3.2.1 | 2026-10-27 |
| [VERSION-PLAN.md](../packages/core/docs/VERSION-PLAN.md) | 3.3→4.0 排期与完成态语义 | 权威 | 3.2.1 | 2026-10-28 |
| [RELEASE-POLICY.md](../packages/core/docs/RELEASE-POLICY.md) | 计数 / 受众口径 / 版本面 | 权威 | 3.2.1 | 2026-10-28 |
| [WRITING-STYLE.md](../packages/core/docs/WRITING-STYLE.md) | 文档排版判据 | 权威 | 3.2.1 | 2026-10-27 |
| [BENCH.md](../packages/core/docs/BENCH.md) | 基准跑法与数字快照 | 权威 | 3.2.1 | 2026-10-22 |
| [PROFILE-TUNING.md](../packages/core/docs/PROFILE-TUNING.md) | 画像回流台账（人工批准制） | 权威 | 3.2.1 | 2026-10-19 |
| [MCP-4.0-PLAN.md](../packages/core/docs/MCP-4.0-PLAN.md) | 4.0 Hook 完全态调研 | 参考 | 4.0 前置 | 2026-10-19 |
| [LEGISLATION-LAW.md](../packages/core/docs/LEGISLATION-LAW.md) | 立法程序 | 参考 | 3.2.1 | 2026-10-27 |
| [packages/core/README.md](../packages/core/README.md) | 核心包英文说明 | 参考 | 3.2.1 | 2026-10-27 |
| [packages/core/README.zh-CN.md](../packages/core/README.zh-CN.md) | 核心包中文说明 | 参考 | 3.2.1 | 2026-10-27 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 提交与 CLA | 参考 | 3.2.1 | 2026-10-19 |
| [packages/extended/bridges/README.md](../packages/extended/bridges/README.md) | 外接桥契约 | 参考 | 3.2.1 | 2026-10-08 |

## 三、过程台账（读前看日期，不作裁决依据）

| 文档 | 内容 | 状态 |
|---|---|---|
| [HANDOFF-2026-10-27.md](../packages/core/docs/HANDOFF-2026-10-27.md) | 审计工具三连跑 → 分层拆分 → 健康分 | 台账（最新） |
| [HANDOFF-2026-10-26.md](../packages/core/docs/HANDOFF-2026-10-26.md) | 3.1.0 新功能与分层前夜 | 台账 |
| [HANDOFF-2026-10-22.md](../packages/core/docs/HANDOFF-2026-10-22.md) | L1 画像与审批缝 | 台账 |
| [HANDOFF-2026-10-19.md](../packages/core/docs/HANDOFF-2026-10-19.md) | 审计元数据 / 画像回流 | 台账 |
| [HANDOFF-2026-10-19-evening.md](../packages/core/docs/HANDOFF-2026-10-19-evening.md) | 抽查B / 口径对账 | 台账 |
| [HANDOFF-2026-10-18.md](../packages/core/docs/HANDOFF-2026-10-18.md) | 孤儿机制移植批 | 台账 |
| [AB-PROMPTS.md](../packages/core/docs/AB-PROMPTS.md) | A/B 采集协议 | 台账 |
| [AB-SESSION.md](../packages/core/docs/AB-SESSION.md) | 一次 A/B 会话记录 | 台账 |
| [deepseek-pricing-audit.md](../packages/core/docs/deepseek-pricing-audit.md) | 价目核对 | 台账 |
| [MASTER-PLAN-2.0.0.md](../packages/core/docs/MASTER-PLAN-2.0.0.md) | 2.0 重构骨架 | 台账 |
| [MASTER-PLAN-3.0.0.md](../packages/core/docs/MASTER-PLAN-3.0.0.md) | 3.0 迁移计划 | 台账 |

## 四、归档（勿引用）

| 文档 | 原因 |
|---|---|
| [docs/HANDOFF-TO-EXTERNAL.md](HANDOFF-TO-EXTERNAL.md) | 2026-10-09 对外说明，已过期 |
| [docs/vault-notes/README.md](vault-notes/README.md) | 外部资料摘录，非项目事实源 |
| [packages/core/skills/focus-thinking/SKILL.md](../packages/core/skills/focus-thinking/SKILL.md) | 旧技能入口，技能目录已迁到 `.agents/skills-core/` |

## 维护

- 新增权威文档必须进本页；过期文档先改状态、再移归档。
- `docs/INDEX.md` 自身由 `npm run docs:lint` 检查链接；版本面由 `check` 兜底。
