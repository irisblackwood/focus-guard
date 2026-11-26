# 司会 Keepward

> **状态**：权威 · 适用版本 3.5.3 · 最后核对 2026-11-19

[English](packages/core/README.md) · 中文

> **旧名**：FocusGuard / 聚焦护栏（3.5.0 起更名）。**包名 `focus-guard`、插件 id `focus-guard`、
> 状态目录 `.focus-guard/`、环境变量 `FG_*` 一律不变**——更名只动展示层，不动技术契约。
> 新名取《周礼·天官》「司会」，掌邦国财政考核，读 **sī kuài**（会计之会，非 huì）。

[![CI](https://github.com/irisblackwood/focus-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/irisblackwood/focus-guard/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-3.5.3-369eff)](CHANGELOG.md)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518.17-339933)

> **版本口径**：对外展示一律以 **GitHub `main`** 为准（`PUBLISHED_MAX` = `3.5.2`）；npm registry 已发 `3.5.2`（2026-11-18，OIDC 受信发布 + provenance）；本树 `3.5.3` 未推。
> 本地开发版本可以领先已发布版本，**领先不等于已发布**。此页显示的版本号由 `docs:lint` 对着 `PUBLISHED_MAX` 校验。

**AGPL-3.0-only + 商业双授权**：按 AGPLv3 使用，商业使用同样允许；不愿承担 AGPL 义务（尤其第 13 条网络开源）的，可另购商业许可——那是**替代**路径，不是对商用的限制。商标 `司会` / `Keepward` 保留，衍生版本不得沿用；旧名 `FocusGuard` / `聚焦护栏` 作为历史别名同样保留。细节见 [LICENSE](LICENSE) / [NOTICE](NOTICE)。

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

> **记忆尚未竣工，且有一部分已下架**（2026-11-26 声明）：跨会话卷宗原先会把
> 「人类指令原文」当决策存下来，实测存进去的多是问句与训话（10 条里 0 条是决策）——
> 该功能**已下架**，现在既不写入也不注入。卷宗当前只剩被否决的命令与计数快照，
> 且没有冲突检测与证据校验，**只作线索**；据此行动前请对关键事实重新取证。
> 机制（哈希路由 / 回合落账 / 按需拉取）是通的，不成器的是沉淀内容——下架登记、恢复条件与排期见
> [MEMORY-4.5-PLAN.md](packages/core/docs/MEMORY-4.5-PLAN.md) §〇。

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
| 原生插件（推荐） | `dsh plugin --profile <name> add focus-guard` | 8 个宿主事件 / 十余条监听：拦截判定、规则与成本注入、turn/step 留痕、熔断结算、压缩监察 |
| 官方桥 | `@deepseek-ai/dsh-hooks-claude-code` 挂 `packages/core/hooks/hooks.json` | 与 ZCode 同级六事件硬拦截，不含资格审核与申辩 |

装插件三种写法，差别只在版本来源：`add focus-guard`（npm 最近发版）／`add github:irisblackwood/focus-guard#path:/packages/core`（`main` 未发布改动，monorepo 必须指到子目录）／`add <路径>/packages/core`（本地开发）。详见 [INSTALL.md](INSTALL.md) §2A。

**官方桥边界与兼容矩阵**：桥 `@deepseek-ai/dsh-hooks-claude-code` **由官方仓库维护**，本仓库只提供适配层（`hooks.json` + `src/dsh/` 事件映射）。走桥时**先装/确认桥，再装本包**。

| 适配层 | 官方桥已验证区间 |
|---|---|
| 3.5.x | `>=0.2.1-rc.1 <0.3.0`（实测 `0.2.1-rc.1` / `0.2.2-rc.5`） |

桥升级后适配层可能必须跟着更新；不匹配会在会话启动时告警 `bridge-incompatible`，并打印升级/回退命令。**桥层面的 issue（功能缺失、崩溃、事件不触发）请上报官方仓库**；本 README 只描述适配层行为与兼容矩阵，本仓库只处理适配层自身缺陷与兼容问题。

**装到 ZCode**：仓库根目录 → 插件市场 → 添加市场 → 安装 → 新开会话（并存，非首选）。

验证生效：新会话出现执法模型注入，且工作区生成 `.ai/CASE_FILE.md` 与 `.focus-guard/AUDIT.log`。逐行步骤、卸载、FAQ 见 [INSTALL.md](INSTALL.md)。

**首次会话会自清洁**：发布物里不该有审计日志、脑索引、私有面目录。万一哪天打包配置被改错带了出去，
首次会话启动时会把误打包的运行期产物清掉，脑从 0 开始长（法条随文档重新读入）。
判据是 `.git`——开发副本里的私有产物是**数据**，一律不动；只有安装副本才清。手动跑：`npm run privacy:sweep`。

> 为什么不在 `postinstall` 里做（2026-11-18）：带 lifecycle 脚本的包会让 pnpm 报
> `ERR_PNPM_IGNORED_BUILDS` 并非零退出，而 `dsh plugin` 是 pnpm 的转发器——它一失败，
> 「把包对账进 `dsh.profile.bundles`」那步就被跳过。结果是**装上了、清单里没有**。
> 现在包里没有任何 lifecycle 脚本。

## 看一眼你的脑（3D，可选）

把审计事件摊成一个体积：**实体是位置，共现是连线，强度是大小**。时间轴告诉你「发生了什么」，
它告诉你「什么东西在长、什么东西正在被忘掉」。

```bash
npm run brain                # 仓库里：增量重算 → 渲染 → 打开
npm run brain:build          # 仓库里：同上，不打开（脚本 / 无桌面环境用）
npm run brain -- --rebuild   # 仓库里：丢掉索引，从头重算
npx focus-guard-brain        # 装了包：读**当前目录**的 .focus-guard/AUDIT.log，生成后打开
```

数据根跟着**工作区**走：cwd 下有 `.focus-guard/` 或 `.ai/` 就用它，否则退回包的安装位置。
所以插件用户在自己项目里跑，看的是自己的足迹，不是包目录里那份空的。

产物固定在 `.focus-guard/brain.html`（引擎的隐藏状态目录里）。跑完终端会打出 `file://` 的**绝对地址**，
点一下就能开；不想记路径就用 `npm run brain` / `npx focus-guard-brain`，它们会自己打开。产出是**单个 HTML 文件**，双击即开。它只读审计：不写
`AUDIT.log`、不碰状态、不在任何工具调用路径上——**跑不跑都不影响拦截**。

> **渲染分三档，入口只有一个。** 包里带一份皮层资产（`packages/core/assets/cortex.bin`，
> pial 表面降采样点云，约 2.8 万点），**clone 和 `npm i` 都能拿到**，脑壳就是真皮层；
> 把 `assets/` 删掉才退回程序化沟回。跑完看终端那行「脑壳：…」就知道自己用的是哪一档，不猜。
> 真 PLY 全网格只在本地：`npm run brain:cosmic`（强制皮层版，没资产会明说并退出）。
>
> 皮层资产是 CC BY-SA 3.0、代码是 AGPL-3.0-only，两者按**并列分发**处理，
> 条款各自约束各自部分——署名与条款全文见 `assets/NOTICE.md`，再分发请保留该文件。

**第一次跑是空的，这是对的**：新装没有足迹，脑的形状由沟回 + 法线光照撑住，不靠记忆点亮。
跑几次让 guard 记下动作，足迹与连线才长出来。头部如实报「实读几份文档、缺几份」——
`self-improvement/` 与 `.ai/` 是私有面，别人 clone 下来本来就没有，缺是正常的。

背景是程序化生成的星空（恒星 / 银河带 / 星云 / 两台黑洞），零外部资源、纯着色器。
怎么画的、为什么这么画、`?stars=0` 是干什么用的，见 [BRAIN-VIZ.md](packages/core/docs/BRAIN-VIZ.md)。

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

当前已发布 **v3.5.2**（本树 3.5.3 未推），完整历史见 [CHANGELOG.md](CHANGELOG.md)。下一版规划见 [VERSION-PLAN.md](packages/core/docs/VERSION-PLAN.md)。

## License

AGPL-3.0-only + 商业双授权（详见 [LICENSE](LICENSE) / [NOTICE](NOTICE)）。贡献条款见 [CONTRIBUTING.md](CONTRIBUTING.md)。
