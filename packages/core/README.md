# FocusGuard 聚焦护栏

给 AI 编码智能体装上履职纪律：**未取证就改、结论无锚点、整读大文件烧上下文、查无实据硬凑**这四类失控，被变成可机械拦截的行为事件——命中即按 L1 打回 → L2 强制取证 → L3 熔断 → L4 记档 → L5 降权 → L6 上报逐级处置。

- **零依赖**：核心包不依赖任何运行时库（`dependencies` 为空）
- **双端硬拦截**：DSH 原生插件（宿主缝）与 ZCode 钩子两套执行面
- **全程留痕**：拦截写入 `.focus-guard/AUDIT.log`（JSONL，带体积轮转与归档）
- **法条可审计**：条文正本 `docs/RULES.md` 明确标注哪些条款已机械化、哪些尚未落地

## 安装

### DSH（原生插件，推荐）

```bash
dsh plugin --profile <你的 profile> add focus-guard
```

装完 **重启会话** 生效。bundle 补丁由本包的 `package.json` 的 `dsh.bundle.patch` 指向 `src/dsh/cordis.patch.yml`。

⚠ 与官方桥 `@deepseek-ai/dsh-hooks-claude-code` **互斥**：两条路同时挂载会双跑（同一条缝双监听），**二选一**。

### 从 Git 直接安装

```bash
dsh plugin --profile <你的 profile> add github:irisblackwood/focus-guard
```

### ZCode

`.zcode-plugin/plugin.json` 已就绪，按 ZCode 的插件安装流程导入本仓库即可。

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
src/dsh/pipeline.mjs  宿主缝：pre-execute / system-prompt / post-execute
hooks/guard.mjs   ZCode 执行壳（已封存：版本号独立，不随主版本更新）
```

**分层铁律**：母版层**不得**反向依赖适配层（有验收用例锁定）。

## 版本

当前 `3.0.6`。版本面共 8 处由验收断言锁定"彼此相等且等于 CHANGELOG 最新条目"。

## 文档

- 能力与排错：仓库 `README.md`、`INSTALL.md`
- 条文正本：`docs/RULES.md`
- 变更记录：仓库 `CHANGELOG.md`

## License

MIT © 2026 irisblackwood
