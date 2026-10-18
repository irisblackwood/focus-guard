# 基准测试（Bench）

五类基准，各回答一个问题。全部零外部依赖，命令直接跑。

| 命令 | 回答什么 | 实现 |
|---|---|---|
| `npm run bench:decision` | 判定准不准、误不误伤、热路径多快 | `packages/core/tests/decision-bench.mjs` |
| `npm run bench:tasks` | 一整件任务在 FG 下能不能走通（50 组真实调用串） | `packages/core/tests/task-bench.mjs` + `task-suite.json` |
| `npm run bench:cost` | 花了多少 token/USD、拦了什么、误伤多少 | `packages/core/tools/bench-cost.mjs` |
| `npm run bench` | 常驻注入占多少字符/token | `packages/core/tests/token-bench.mjs` |
| `npm run eval` | 对攻击样本的拦截率（`guard.mjs` 路径） | `packages/core/tests/threat-eval.mjs` |

---

## 〇、任务测试（task bench，50 组）

判定基准测"单条判定"，任务测试测"**一整件任务**能不能走通"：一组 = 一串真实调用
（读 → 改 → 跑测试 → 查日志），任何一环被错拦整组即失败。数据在 `tests/task-suite.json`。

覆盖 6 类：只读探查（T01-T10）、代码修改（T11-T18）、命令执行（T19-T30）、
高危操作（T31-T36）、资格闸（T37-T41）、边界与误伤敏感（T42-T50）。

```
50 组 / 57 次调用     组通过率 100%     调用准确率 100%
误伤 0     漏拦 0     延迟 p50 2.04ms / p95 67.24ms
```

`--group T31` 单跑一组，`--json` 机器读。首轮（修复前）与修复后的对照见 CHANGELOG「未发版」节：
`psql -c 'DROP DATABASE'` 曾被引号豁免漏拦、`rm -rf ./dist` 与 `/tmp/...` 被资格闸误伤、
`Write` 到 `C:\Windows\...` 未被系统路径闸拦——四处都由这套测试发现并修掉。

### A/B 对照（FG 关 vs FG 开）

`npm run bench:tasks -- --ab` 跑两遍同一套任务：A 组直通（等价于插件禁用），B 组走真实判定。

```
A 组（FG 关）  可完成 57/57   延迟 p50 0ms / p95 0ms
B 组（FG 开）  合规   57/57   延迟 p50 2.09ms / p95 68.09ms
FG 介入        15 次拦截（应当拦 15 / 误伤 0）
热路径开销     p50 +2.09ms / p95 +68.09ms
```

- 「应当拦 15 / 误伤 0」是目前的口径：15 条拦截全部落在任务集标注为「应拦」的调用上
- p95 的 +68ms 是**新命令首次**付哨兵冷启动；重复命令走缓存（见第一节）
- `--control` 只跑 A 组

### 纯净 A 组（零 FG 导入，`npm run bench:control`）

上面 `--ab` 的 A 组只是"把闸跳过"，**FG 模块仍被 import**。要真正纯净用独立进程跑：

```
A 组（纯净）：50 组 / 57 次操作
  实际执行    27（真实 fs 操作）
  仅记录      30（Bash 命令，控制组不实跑）
  失败        0
  延迟        p50 0.323ms / p95 0.842ms（无任何闸）
  FG 模块加载  0
```

纯净性由三条硬约束保证，脚本自校验：

1. **不 import 任何 `packages/core/src/` 模块**——文件里出现 `from '…src/…'` 即 exit 2
2. 不读 FG 状态、不写审计、不注入系统提示
3. **Bash 一律不实跑**，只记录（夹具目录不是仓库、Windows 无 `ls`/`pwd` 语义，实跑只会制造无关噪音）

对照结论：无闸时 57 次操作全部可完成、延迟 p50 0.32ms；有 FG 时同样 57 次全部合规，介入 15 次，p50 +2.09ms。

若要**会话级**纯净（真 agent 会话、真 token 统计），本安装没有 `dsh headless`（已实测回落到 web 的帮助），
只能手动开一个未安装 FG 的 profile 跑同批任务——那属于人工 A/B，不在脚本范围内。

---

## 一、判定基准（decision bench）

固定 14 条用例 × 10 轮 = 140 次真实 `preExecuteListener` 调用，覆盖：

- **红线层**：`rm -rf /`、`git push --force`
- **第 1.5 层**：环境替代（`cat` → `bat`）
- **第 1.4 层**：整文件读取闸（>300 行无 offset）
- **体积闸**：`Grep content` 无 `head_limit`
- **资格闸**：`npm publish` 无授权
- **取证闸**：有会话状态、未读即改；另有"无状态文件 fail-open"对照用例
- **不得误伤**：`ls -la`、`git status`、写新文件、分段读

输出三个指标：

```
准确率   100.00%
误伤率   0.00%（期望放行却被拦）
延迟     p50 0.36ms / p95 2.37ms / max 4.43ms
```

**基线**：`packages/core/docs/BENCH-BASELINE.json`。`--update` 覆盖。
不达基线（准确率掉 2 个点以上、p95 劣化 3 倍以上、或 p95 超阈值）即 exit 1。

### 已知热路径成本（实测，不是估算）

```
### 热路径成本：修复前后（实测）

加缓存前：

```
plain-ls-allow           p50 60.04ms   p95 70.55ms   ← Bash 类
plain-git-status-allow   p50 60.41ms   p95 62.71ms   ← Bash 类
其余 12 条用例            p95 ≤ 2.8ms
```

差异来自第 2 层语义判定：每条 **Bash 命令**会调一次 `sentinel.py`（python 子进程 ≈60ms）。

加缓存后（2026-10-18，`riskOfSentinel` 按命令内容缓存成功结论）：

```
判定基准              准确率 100%  误伤率 0%
延迟                  p50 0.36ms / p95 2.37ms / max 4.43ms
```

语义说明：
- **只缓存成功结论**。超时、缺 python、解析失败一律不缓存——下次仍重试，不把错误固化成判定。
- 缓存键 = 命令原文（`Map` + LRU，默认容量 500）。`FG_SENTINEL_CACHE=0` 关闭，`FG_SENTINEL_CACHE_SIZE` 调容量。
- **每条新命令的首次判定仍要付约 60ms**（python 冷启动）；缓存收益在重复命令（重试、复测、同一脚本多轮）。
  想连首次也压掉，只能把哨兵改成常驻进程——未实施。

`FG_BENCH_ITER` 调节轮数、`FG_BENCH_P95_MS` 调节延迟阈值。

---

## 二、成本/效果基准（cost bench）

不跑模型，只汇总已落盘的数据：

| 来源 | 指标 |
|---|---|
| `.ai/CASE_FILE.md` 【五】成本台账 | token、USD、按模型分布 |
| `.focus-guard/AUDIT.log` | `deny` 次数、理由分布（`trigger`） |
| 同上 `appeal-granted` | 误伤后获准条数 → 误伤比 = 获准 / 拦截 |

```powershell
node packages/core/tools/bench-cost.mjs
node packages/core/tools/bench-cost.mjs --since 2026-10-18 --json
```

### A/B 对照协议（回答"FG 值不值"）

1. 准备一组固定任务（同一 prompt、同一模型）
2. FG 开：跑 5 次；FG 关：跑 5 次
3. 每次结束后跑 `bench:cost`，取中位数对比

注意两点：
- 关 FG 的轮次**不会写** `AUDIT.log`，所以只能比 token/轮次，这是设计使然
- 单次差异会被 prompt 缓存命中率掩盖，样本少于 5 次没有意义

---

## 三、Token 基准

`npm run bench` = 常驻开销（技能目录 + 工具 schema + 系统提示注入）。
FG 当前注入 440 字符（`focus-guard-rules` 425 + `focus-guard-cost` 15），
宿主按 4 字符/token 折算 ≈ 110 tokens。改动注入正文后应重跑。

## 四、威胁评测

`npm run eval` 跑的是 **ZCode 路径**（`hooks/guard.mjs`）的攻击样本集。
DSH 原生插件的判定基准看第一节，两者互补：一个测规则覆盖面，一个测链路准确率与延迟。
