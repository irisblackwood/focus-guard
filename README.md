# FocusGuard 聚焦护栏

> **状态**：权威 · 适用版本 3.2.1 · 最后核对 2026-10-28

[English](packages/core/README.md) · 中文

[![CI](https://github.com/irisblackwood/focus-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/irisblackwood/focus-guard/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-3.2.1-369eff)](CHANGELOG.md)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518.17-339933)

**AGPL-3.0-only + 商业双授权**：个人 / 学习 / 研究 / 非营利社区免费；商业使用（SaaS、闭源内部部署、收费产品）需单独授权。商标 `FocusGuard` / `聚焦护栏` 保留，衍生版本不得沿用。细节见 [LICENSE](LICENSE) / [NOTICE](NOTICE)。

## 30 秒速览

| 失控现象 | 机械拦截 | 人类看到 |
|---|---|---|
| 没调查就改文件 / 跑变更命令 | 触发① → L1 打回 | 一条拒绝原因 |
| 结论没有 `[文件:行号]` 证据 | 触发② → 收尾打回 | 一条打回理由 |
| 整读大文件、裸 cat 刷屏 | 体积三闸 + 检索提示 | 一行"分段读或交子代理" |
| 反复无效调用、无限空转 | 预算 + 停滞 → 熔断 | 熔断出口 + 三行降级方案 |
| 顺手 `rm -rf` / `git push` / `npm publish` | 高危命令闸 + 资格审核 | 审批卡片：批准本次 / 阻断 |
| 上下文被巨量输出撑爆 | 污染检测 + 卷宗免重读 | 记档 + 复用已有取证 |
| 反复读同一个没变的文件 | 卷宗指纹 + TTL | 拦本次 Read（`offset` 增量读永远放行） |
| 模糊需求上来就改代码 | 第 1.3 层动笔闸 | 先加载方法论，再动笔 |

## 为什么需要它

AI 智能体的三类失控：**思考失控**（没证据就猜）、**资源失控**（整读与刷屏烧上下文）、**权限失控**（先斩后奏、无法追溯）。

"立法 → 执法 → 监察"把三类失控变成可拦截的行为事件：**法条**（[RULES.md](packages/core/docs/RULES.md)）定标准，**引擎**机械执行，**留痕**（`.focus-guard/AUDIT.log`）接受人类复核。

引擎按四层组织，依赖方向由验收用例锁定（`core → adapter → seam` 单向）：

| 层 | 位置 | 职责 |
|---|---|---|
| 母版层 | `packages/core/src/core/` | 零依赖判定逻辑：资格审核 / 画像 / 红线与豁免 / 申辩 / 状态 / 审计写入器。不得反向依赖适配层 |
| 适配层 | `packages/core/src/adapters/dsh/` | 把母版接进 DSH：`fg_apply` / `fg_appeal` 注册 + 资格闸 |
| 宿主缝 | `packages/core/src/dsh/` | 三条缝的注册与编排（`pipeline.mjs`）；各层判定在 `guard/` |
| ZCode 执行壳 | `packages/core/hooks/guard.mjs` | 已封存：版本独立、只做兼容，不随主版本演进 |

机制细节（触发/处罚/预算/卷宗/监察/审批/资格/委派/配置/工作原理）：[ARCHITECTURE.md](docs/ARCHITECTURE.md)。能力状态与缺口：[ARCH-MAP.md](packages/core/docs/ARCH-MAP.md)。

## 快速开始

```bash
# 核心版：零依赖。npm 已发布（版本以 npm view focus-guard version 为准）
npm install focus-guard
```

**装到 DSH（首选）**：原生插件与官方桥**二选一、互斥**（同缝双挂 = 双跑）：

| 路径 | 命令 / 挂载 | 拿到什么 |
|---|---|---|
| 原生插件（推荐） | `dsh plugin --profile <name> add github:irisblackwood/focus-guard#path:/packages/core` | 8 事件 / 12 监听：拦截判定、规则与成本注入、turn/step 留痕、熔断结算、压缩监察 |
| 官方桥 | `@deepseek-ai/dsh-hooks-claude-code` 挂 `packages/core/hooks/hooks.json` | 与 ZCode 同级六事件硬拦截，不含资格审核与申辩 |

**装到 ZCode**：仓库根目录 → 插件市场 → 添加市场 → 安装 → 新开会话（并存，非首选）。

验证生效：新会话出现执法模型注入，且工作区生成 `.ai/CASE_FILE.md` 与 `.focus-guard/AUDIT.log`。逐行步骤、卸载、FAQ 见 [INSTALL.md](INSTALL.md)。

## 文档地图

| 想知道 | 读 |
|---|---|
| 全部文档入口（权威/参考/台账/归档） | [docs/INDEX.md](docs/INDEX.md) |
| 法条原文 + 未机械化条款清单 | [RULES.md](packages/core/docs/RULES.md) |
| 机制怎么运作（触发/处罚/预算/卷宗/审批/资格/委派） | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 能力状态、代码锚点、缺口 | [ARCH-MAP.md](packages/core/docs/ARCH-MAP.md) |
| 3.3 → 4.0 排期（3.5=文档完成态，4.0=Hook 完全态） | [VERSION-PLAN.md](packages/core/docs/VERSION-PLAN.md) |
| 发版计数与受众口径 | [RELEASE-POLICY.md](packages/core/docs/RELEASE-POLICY.md) |
| 基准跑法与数字快照 | [BENCH.md](packages/core/docs/BENCH.md) |
| 变了什么 | [CHANGELOG.md](CHANGELOG.md) |

## 版本

当前 **v3.2.1**，完整历史见 [CHANGELOG.md](CHANGELOG.md)。下一版规划见 [VERSION-PLAN.md](packages/core/docs/VERSION-PLAN.md)。

## License

AGPL-3.0-only + 商业双授权（详见 [LICENSE](LICENSE) / [NOTICE](NOTICE)）。贡献条款见 [CONTRIBUTING.md](CONTRIBUTING.md)。
