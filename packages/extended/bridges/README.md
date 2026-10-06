# bridges/ — 子分支衍生区（外接适配层）

> 主分支是**范本**：本目录的一切都依赖主分支定义的**契约**（文件格式与环境变量接口），主分支**零依赖**本目录——删除整个 bridges/ 目录，主分支功能一分不减（验收用例锁定该性质）。

## 范本 → 子分支的衍生规则

1. **一个桥 = 一个自包含文件**：只依赖 Node.js 内置模块与主分支的**契约**（下表），禁止 import 主分支源码（hooks/tools 内的函数），禁止被主分支源码 import。
2. **契约优先**：桥对接的是契约（数据格式/环境变量/退出码协议），不是主分支的内部实现——主分支重构内部实现时桥不受影响。
3. **失败降级**：桥的任何故障（服务端不可达、模型离线、输出损坏）必须静默回退主分支默认行为，永不阻塞、永不放大风险。
4. **命名**：`<外部系统名>-<职责>.mjs`；配套测试进 `tests/bridges.test.mjs`（主分支 `npm test` 不执行桥测试，桥测试跑 `npm run test:bridges`）。
5. **衍生新桥**：复制任一现有桥为起点 → 替换外部系统 API 调用 → 在本表登记 → 补桥测试。理论上可衍生无数子分支桥，互不依赖。

## 现有桥

| 桥 | 外部系统 | 依赖的契约 | 用法 |
|---|---|---|---|
| `viking-bridge.mjs` | OpenViking（火山引擎 Agent 上下文数据库） | 积木图书馆 INDEX.md 格式 + `.ai/library/` 目录 | 导出 batch-write 载荷 / `--push` 直推（`OPENVIKING_URL`、`OPENVIKING_API_KEY`，默认端口 1933） |
| `needle2-sentinel.mjs` | Needle 2 本地模型（Cactus Compute 45M） | 哨兵外判契约：stdin `{"command"}` → stdout `{"verdict","reasons"}`，失败退出码≠0 | `FG_SENTINEL_CMD="node bridges/needle2-sentinel.mjs"` + `NEEDLE2_BIN`/`NEEDLE2_MODEL` |
| `audit-chain-semantica.mjs` | Semantica（图原生记忆层） | 执法档案 AUDIT.log JSONL 格式（seq/chain/ref） | `node bridges/audit-chain-semantica.mjs <AUDIT.log>` → LPG 图谱 JSON（`caused`/`spawned` 边） |

## 主分支公开契约速查（桥的对接面）

| 契约 | 格式 | 定义处 |
|---|---|---|
| 执法档案 | JSONL：`ts/session/seq/chain/ref/action/trigger/level/evidence/pardon` | `hooks/guard.mjs` audit()；docs/RULES.md 表6 |
| 哨兵外判 | stdin `{"command"}` → stdout `{"verdict":"allow\|flag\|block","reasons":[]}`，失败回退启发式 | `tools/sentinel.mjs` judgeByModel；环境变量 `FG_SENTINEL_CMD` |
| 积木图书馆 | `.ai/library/<id>-<slug>.md`（frontmatter：id/title/source/sha256）+ `INDEX.md` 指针表 | `tools/library-build.mjs`；docs/RULES.md 第八十二条 |
| 降级哲学 | 桥失败 → 回退主分支默认行为，stderr 一行说明 | docs/RULES.md 第八十三条(二) |
