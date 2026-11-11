# FocusGuard 聚焦护栏

> **状态**：权威 · 适用版本 3.3.3 · 最后核对 2026-11-07

[English](packages/core/README.md) · 中文

[![CI](https://github.com/irisblackwood/focus-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/irisblackwood/focus-guard/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-3.3.3-369eff)](CHANGELOG.md)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518.17-339933)

> **版本口径**：对外展示一律以 **GitHub `main`** 为准（`PUBLISHED_MAX`）；npm registry 已发 `3.3.3`（2026-11-07，OIDC 受信发布 + provenance）。
> 本地开发版本可以领先已发布版本，**领先不等于已发布**。此页显示的版本号由 `docs:lint` 对着 `PUBLISHED_MAX` 校验。

**AGPL-3.0-only + 商业双授权**：按 AGPLv3 使用，商业使用同样允许；不愿承担 AGPL 义务（尤其第 13 条网络开源）的，可另购商业许可——那是**替代**路径，不是对商用的限制。商标 `FocusGuard` / `聚焦护栏` 保留，衍生版本不得沿用。细节见 [LICENSE](LICENSE) / [NOTICE](NOTICE)。

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

**首次安装会自清洁**：发布物里不该有审计日志、脑索引、私有面目录。万一哪天打包配置被改错带了出去，
`postinstall` 会把这些误打包的运行期产物清掉，脑从 0 开始长（法条随文档重新读入）。
判据是 `.git`——开发副本里的私有产物是**数据**，一律不动；只有安装副本才清。手动跑：`npm run privacy:sweep`。

## 看一眼你的脑（3D，可选）

把审计事件摊成一个体积：**实体是位置，共现是连线，强度是大小**。时间轴告诉你「发生了什么」，
它告诉你「什么东西在长、什么东西正在被忘掉」。

```bash
npm run brain                # 增量重算 → 生成完直接用默认程序打开
npm run brain:build          # 只生成不打开（脚本 / 无桌面环境用）
npm run brain -- --rebuild   # 丢掉索引，从头重算
```

产物固定在 `.focus-guard/brain.html`（引擎的隐藏状态目录里）。跑完终端会打出 `file://` 的**绝对地址**，
点一下就能开；不想记路径就用 `npm run brain`，它自己会打开。零依赖（不引 three.js、不连 CDN），产出是**单个 HTML 文件**，双击即开。它只读审计：不写
`AUDIT.log`、不碰状态、不在任何工具调用路径上——**跑不跑都不影响拦截**。

> **`npm run brain:cosmic`** 是**本地实验版**入口：用真 PLY 皮层网格渲染，产物约 6 MB。
> 它的生成器与皮层数据都**不在版本库里**（数据来自 `memory-brain`，CC BY-SA 3.0，不随仓库分发），
> 所以 clone 下来跑会直接提示「找不到生成器」并退出——这是预期行为，不是坏掉。

**第一次跑是空的，这是对的**：新装没有足迹，脑的形状由沟回 + 法线光照撑住，不靠记忆点亮。
跑几次让 guard 记下动作，足迹与连线才长出来。头部如实报「实读几份文档、缺几份」——
`self-improvement/` 与 `.ai/` 是私有面，别人 clone 下来本来就没有，缺是正常的。

背景是会闪的恒星 + 银河带 + 三团彩色星云 + 两台黑洞。黑洞按真东西画：
盘**侧对**（离侧对 11°）、薄盘温度走 Shakura–Sunyaev 剖面、颜色走**黑体**、
亮度 ∝ g⁴（多普勒 × 引力红移，两侧差约 80 倍）；中间那块黑是"这个方向不撒星"撒出来的
真遮挡，顶上那道弧是被引力弯过来的**次级像**。几何取自 `sundyme/event-horizon`，
积分器没抄——它每像素几百步，我们是 30 ms 里的背景。

星空拆**两个 draw call**：锐点（恒星）走假 bloom，雾点（银河/星云/盘面/外晕）只走一遍——
对本来就软的大点再做 bloom 只是白烧填充率。`?stars=0` 可关掉它，那是
**性能 A/B 用的对照臂**（实测 31.2 ms vs 20.1 ms，软件渲染口径），不是给用户的功能开关。

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

当前 **v3.3.3**，完整历史见 [CHANGELOG.md](CHANGELOG.md)。下一版规划见 [VERSION-PLAN.md](packages/core/docs/VERSION-PLAN.md)。

## License

AGPL-3.0-only + 商业双授权（详见 [LICENSE](LICENSE) / [NOTICE](NOTICE)）。贡献条款见 [CONTRIBUTING.md](CONTRIBUTING.md)。
