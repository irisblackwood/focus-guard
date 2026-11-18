# 司会 Keepward

> **状态**：参考 · 适用版本 3.5.2 · 最后核对 2026-11-17

> 旧名 **FocusGuard 聚焦护栏**（3.5.0 起更名）。包名 `focus-guard`、插件 id、
> 状态目录 `.focus-guard/`、环境变量 `FG_*` 一律不变——更名只动展示层，不动技术契约。

中文 · [English](README.md)

给 AI 编码智能体装上履职纪律。三类失控不再是提示词里的劝告，而是被机械拦截的行为事件：

- **思考失控**——结论没有 `[文件:行号]` 锚点，在交付前被打回
- **资源失控**——整读大文件、反复读同一个没变的文件，两道闸都拦
- **权限失控**——`rm -rf` / `git push -f` / `npm publish` 要在**执行前**拿到授权，而不是事后道歉

每次拦截都写进 `.focus-guard/AUDIT.log`（JSONL），并带上**真实生效的规则名**。这里不做"劝模型自觉"的事，改的是模型**被允许做什么**。

## 安装

### DSH（原生插件，推荐）

```bash
dsh plugin --profile <你的 profile> add focus-guard
```

`dsh plugin` 是 pnpm 的包装，`add` 后面就是 pnpm spec。三种写法装的是同一个包，差别只在版本来源：

| 写法 | 拿到什么 |
|---|---|
| `add focus-guard` | 最近一次 npm 发版（当前 `3.5.2`），带 provenance 签名 |
| `add github:irisblackwood/focus-guard#path:/packages/core` | `main` 上此刻的代码，可能领先已发布版本 |
| `add <路径>/packages/core` | 你本地这份（开发态） |

GitHub 那条必须带 `#path:/packages/core`：本仓是 monorepo，根 `package.json` 不是插件包。

装完 **重启会话** 生效。bundle 补丁由本包 `package.json` 的 `dsh.bundle.patch` 指向 `src/dsh/cordis.patch.yml`，安装时自动生效，无需手工编辑。

单独用（只装命令行工具，不挂宿主）：`npm install focus-guard`，带 `focus-guard-brain` 可执行入口。

> 与官方桥 `@deepseek-ai/dsh-hooks-claude-code` **互斥**：两条路挂的是同一批缝，同时挂载会双跑（同一条缝双监听），**二选一**。

### ZCode（并存，非首选）

`.zcode-plugin/plugin.json` 已就绪，按 ZCode 的插件安装流程导入本仓库即可。执行壳已封存——版本号独立，不随主版本演进。

## 它拦什么

| 场景 | 机制 |
|---|---|
| 未调查取证就改文件 / 执行变更命令 | L4 前置条件：目标须本会话已读，否则拒一次（新建文件除外） |
| 高危命令（递归强删 / 格式化 / 强推 / 发布 / 全局安装 / 系统路径写入） | L3 资格审核：**先申请后执行**，无授权即拒；`fg_apply` 是申请通道 |
| 绝对红线（`rm -rf /`、`DROP DATABASE`、`git push -f`） | L2 零延迟短路拒绝，**不弹审批** |
| 被**引用的**危险命令字符串（测试数据、文档引用、评测集） | 上下文豁免三判据（引号内 / 数据标记 / 只读命令）→ 降级到语义预判，绝不直接放行 |
| 拦错了没有程序可走 | `fg_appeal` 误伤申辩：附反例锚点提交，人类一次性裁决，全程留痕 |
| 整读大文件 | 超 `FG_WHOLE_FILE_MAX_LINES`（默认 300 行）且未带 `offset`/`limit` 即拒，指向 XERJ |
| 模糊需求上来就改代码 | 首次动笔前拒一次，要求先加载 `brainstorming` 或 `writing-plans` |
| 大小模型一刀切 | 模型画像（`src/profiles/`）：按模型调整审核强度 |
| 本机该用 `rg`/`fd` 却写了 `grep`/`find` | 环境指纹 + 命令硬校验，给一行替代提示 |

## 它怎么判

六层，按序。画像可以跳层，**永不能关掉 L2 与 L3**。

| 层 | 判什么 |
|---|---|
| L0 | 申请完整性——`purpose` / `scope` 空白即拒 |
| L1 | 状态——熔断 / 降权 / 预算耗尽 |
| L2 | 绝对红线（命中即拒，不进 L3） |
| L3 | 高危资格——命中高危特征且本会话无授权 → 转人工审批 |
| L4 | 前置条件——改动类目标须已取证；系统路径与 `.git`/`node_modules` 加严 |
| L5 | 语义信号——模型探针的 `mismatch` / 高风险分 |
| L6 | 授权并留痕 |

## 还在跑什么

全部已随版本发布。下列模块路径**故意不带行号**——行号会静默腐烂。

- **心跳与存活确认** — `src/dsh/heartbeat.mjs`、`src/dsh/status.mjs`：每 10s 原子覆写 `.focus-guard/status.json`；`node src/dsh/status.mjs` 判活并退出 `0` 全绿 / `2` 缺模块 / `3` STALE / `4` 文件缺失。
- **模块启动自检** — `src/dsh/heartbeat.mjs`：10 条执法缝 + 心跳各自报到；缺谁写 `degraded`、告警宿主日志、并以 `focus-guard-degraded` 段注入模型。
- **跨会话卷宗** — `src/memory/workspace.mjs`：状态按 `sha256(realpath(cwd))` 绑定；hash 不符零注入，改文件夹名无法继承旧状态。
- **压缩监察** — `src/dsh/compactionWatch.mjs`：观察 `compaction/start|end|prune` 与请求错误撞窗，并度量摘要相对原文保住了多少锚点（路径 / 行号引用 / 错误码 / 常量）。只读：不写 surface、不 cancel 回合。
- **前缀稳定** — `src/core/prefixStability.mjs`：每回合给装配后的提示前缀取指纹并记录位移，让"破缓存"的改动变成一条审计事件，而不是一张账单。
- **破坏性 API 分级** — `src/dsh/guard/risk.mjs`：`Remove-Item` / `fs.rmSync` 按目标给权——系统路径或递归 `0.9`（拦截）、TEMP `0.2`、其他 `0.4`；重定向 `0.15`。
- **审计记录拦截理由** — `src/dsh/audit.mjs`：`auditDeny(exec, cmd, {trigger, level})` 记录真实规则名（`redline:<name>` / `env-substitute` / `gate:fg_apply` / `evidence-gate` / `whole-file:lines` / `risk:<category>`），不再是常量 `high-risk-rm`。
- **执行体判定** — `src/core/env.mjs`、`src/dsh/index.js`：母版认显式 `FG_SHELL`；DSH 适配层声明 `powershell`，消除"卷宗 / 指纹 / 实际执行"三方矛盾。
- **审计隔离守卫** — `tests/audit-isolation.mjs`：跑测前后比对真实 `AUDIT.log`，有增长即 fail。

## 架构

```
src/core/           母版层：零依赖、宿主无关的判定逻辑（26 个模块）
src/adapters/dsh/   适配层：把母版接进 DSH（fg_apply / fg_appeal 注册 + 资格闸）
src/dsh/            宿主缝：pipeline.mjs 编排 8 个事件；各层判定在 guard/
src/memory/         跨会话卷宗、标签、工作区哈希
src/profiles/       五份纯参数模型画像
hooks/guard.mjs     ZCode 执行壳（已封存：版本号独立）
```

**分层铁律**：母版层**不得**反向依赖适配层（有验收用例锁定）。依赖方向只有一条：`core → adapters → seams`。

## 命令

```bash
npm test                    # 全量测试，跑在审计沙箱里
npm run test:eligibility    # 资格审核 + 红线豁免 + 申辩
npm run eval                # 威胁评测（高危检出率 + 良性误报率）
npm run check               # 发版闸门跑的全部
```

## 版本

三个号，三个含义，别混：

| 面 | 值 | 含义 |
|---|---|---|
| npm registry | `3.5.2` | 最后一次 `npm publish`（2026-11-17，OIDC 受信发布 + provenance） |
| GitHub `main` | `3.5.2` | `PUBLISHED_MAX`——本项目说"已发布"时的那个号 |
| 本树 | `3.5.2` | 与已发布齐平；未推的改动会领先，而领先不等于已发布 |

## 文档

- 能力状态、代码锚点、缺口：`docs/ARCH-MAP.md`
- 条文正本，以及哪些条款已机械化：`docs/RULES.md`
- 机制怎么运作：仓库 `docs/ARCHITECTURE.md`
- 变更记录：仓库 `CHANGELOG.md`

## License

AGPL-3.0-only © 2026 irisblackwood（商业许可为 AGPL 之外的可选路径，例如用于免除第 13 条的开源义务；合规使用无需购买）
