# FocusGuard 聚焦护栏

给 AI 编码智能体装上履职纪律：**未取证就改、结论无锚点、整读大文件烧上下文、查无实据硬凑**这四类失控，被变成可机械拦截的行为事件——命中即按 L1 打回 → L2 强制取证 → L3 熔断 → L4 记档 → L5 降权 → L6 上报逐级处置。

- **零依赖**：核心包不依赖任何运行时库（`dependencies` 为空）
- **DSH 优先执行面**：原生插件（宿主缝）为首选；ZCode 钩子并存，执行壳已封存
- **全程留痕**：拦截写入 `.focus-guard/AUDIT.log`（JSONL，带体积轮转与归档）
- **法条可审计**：条文正本 `docs/RULES.md` 明确标注哪些条款已机械化、哪些尚未落地

## 安装

### DSH（原生插件，推荐）

```bash
dsh plugin --profile <你的 profile> add github:irisblackwood/focus-guard#path:/packages/core
```

装完 **重启会话** 生效。bundle 补丁由本包的 `package.json` 的 `dsh.bundle.patch` 指向 `src/dsh/cordis.patch.yml`。

> **npm 上已发布**：`npm install focus-guard` 可直接安装——registry 当前为 **3.0.7**，本仓为 **3.0.8**（尚未发版）。上面那条 GitHub 路径仍可用，跟的是仓库最新代码。

⚠ 与官方桥 `@deepseek-ai/dsh-hooks-claude-code` **互斥**：两条路同时挂载会双跑（同一条缝双监听），**二选一**。

### ZCode（并存，非首选）

`.zcode-plugin/plugin.json` 已就绪，按 ZCode 的插件安装流程导入本仓库即可。执行壳已封存，版本号独立。

## 它拦什么

| 场景 | 机制 |
|---|---|
| 未调查取证就改文件 / 执行变更命令 | 第 4 层前置条件：目标须本会话已读，否则拒一次（新建文件除外） |
| 高危命令（递归强删 / 格式化 / 强推 / 发布 / 全局安装 / 系统路径写入） | 第 3 层资格审核：**先申请后执行**，无授权即拒；`fg_apply` 是申请通道 |
| 绝对红线（`rm -rf /`、`DROP DATABASE`、`git push -f`） | 第 1 层零延迟短路拒绝，**不弹审批** |
| 被**引用的**危险命令字符串（测试数据、文档引用、评测集） | 上下文豁免三判据（引号内 / 数据标记 / 只读命令）→ 降级到语义预判，不再直接拒 |
| 拦错了没有程序可走 | `fg_appeal` 误伤申辩：附反例锚点提交，人类一次性裁决，全程留痕 |
| 大小模型一刀切 | 模型画像（`src/profiles/`）：按模型调整审核强度 |
| 本机该用 `rg`/`fd` 却写了 `grep`/`find` | 环境指纹 + 命令硬校验，给一行替代提示 |

## 运行面增量（in-tree，2026-10-18）

已在代码里跑、但版本号仍记 `3.0.6` 的部分：

- **心跳与存活确认** — `src/dsh/heartbeat.mjs:85`、`src/dsh/status.mjs:73`：每 10s 原子覆写 `.focus-guard/status.json`；`node src/dsh/status.mjs` 判活并退出 `0` 全绿 / `2` 缺模块 / `3` STALE / `4` 文件缺失。
- **模块启动自检** — `heartbeat.mjs:45`：10 条执法缝 + 心跳各自报到；缺谁写 `degraded`、告警宿主日志、并以 `focus-guard-degraded` 段注入模型。
- **L4 跨会话卷宗** — `src/dsh/workspace.mjs:38`（哈希）/ `:125`（回合落账）/ `src/dsh/index.js:71`（注入）：状态按 `sha256(realpath(cwd))` 绑定；hash 不符零注入，改文件夹名无法继承旧状态。
- **整文件读取闸** — `src/dsh/guard/wholeFile.mjs:26` / `:70`：目标 > 300 行且未带 `offset`/`limit` 即拒，指向 XERJ（`xerj search` / `xerj def`）；阈值 `FG_WHOLE_FILE_MAX_LINES` 可调。
- **Superpowers 动笔闸** — `src/dsh/guard/superpowers.mjs:34`：模糊开发任务（开发动词 + 模糊标记 + 无验收词）首次动笔拒一次，要求先加载 `brainstorming` 或 `writing-plans`；同条重试或已加载即放行。
- **破坏性 API 分级** — `src/dsh/guard/risk.mjs:37`：`Remove-Item` / `fs.rmSync` 按目标给权——系统路径或递归 `0.9`（拦截）、TEMP `0.2`、其他 `0.4`；重定向 `0.15`。
- **压缩监察** — `src/dsh/compactionWatch.mjs:239` / `:364`：观察 `compaction/start|end|prune` 与请求错误撞窗并留痕，不写 surface、不 cancel 回合。
- **审计记录拦截理由** — `src/dsh/audit.mjs:120`：`auditDeny(exec, cmd, {trigger, level})` 记录真实规则名，不再是常量 `high-risk-rm`。
- **执行体判定** — `src/core/env.mjs:18` + `src/dsh/index.js:31`：母版认显式 `FG_SHELL`；DSH 适配层声明 `powershell`，消除"卷宗【一】/指纹/实际执行"三方矛盾。
- **审计隔离守卫** — `tests/audit-isolation.mjs:1`：跑测前后比对真实 `AUDIT.log`，有增长即 fail（双向验证过）。

## 六层资格审核

| 层 | 判什么 |
|---|---|
| L0 | 申请完整性——`purpose` / `scope` 空白即拒 |
| L1 | 状态——熔断 / 降权 / 预算耗尽 |
| L2 | 绝对红线（命中即拒，不进 L3） |
| L3 | 高危资格——命中高危特征且本会话无授权 → 转人工审批 |
| L4 | 前置条件——改动类目标须已取证；系统路径与 `.git`/`node_modules` 加严 |
| L5 | 语义信号——模型探针的 `mismatch` / 高风险分 |
| L6 | 授权并留痕 |

## 三条命令

```bash
npm test              # 验收（含版本一致性、文档-实现对齐）
npm run test:eligibility   # 资格审核 + 红线豁免 + 申辩
npm run eval          # 威胁评测（高危检出率 + 良性误报率）
```

## 架构

```
src/core/        母版层：零依赖、宿主无关的判定逻辑（六层审核 / 画像 / 红线与豁免 / 申辩）
src/adapters/dsh/  适配层：把母版接进 DSH（fg_apply / fg_appeal 工具注册 + 资格闸）
src/dsh/pipeline.mjs  宿主缝：pre-execute / system-prompt / post-execute（编排）
src/dsh/guard/     各层判定实现（10 个模块，2026-10-27 拆）
hooks/guard.mjs   ZCode 执行壳（已封存：版本号独立，不随主版本更新）
```

**分层铁律**：母版层**不得**反向依赖适配层（有验收用例锁定）。

## 版本

当前 `3.0.8`。版本面共 8 处由验收断言锁定"彼此相等且等于 CHANGELOG 最新条目"。

## 文档

- 能力与排错：仓库 `README.md`、`INSTALL.md`
- 条文正本：`docs/RULES.md`
- 变更记录：仓库 `CHANGELOG.md`

## License

AGPL-3.0-only © 2026 irisblackwood（商业使用需单独授权）
