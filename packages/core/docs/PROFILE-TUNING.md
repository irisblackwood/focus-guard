# 画像参数调优台账（PROFILE-TUNING）

> 用途：P2「伪 RLHF 最小闭环」的**人工批准制**台账。主图 L6 的缺口不是"没有 A/B"，是"测量结论不回写参数"。
> 纪律（三条，别绕）：
> 1. 本文件只放**建议**。参数改动必须**人类批准**后手动改 `src/profiles/*.mjs`，并在 §四 追加留痕。
> 2. **禁止**无人批准的自动调参（测量自动回写 = 自证自批，与 L3 人工闸门精神冲突）。
> 3. 数字必须可复算：每条结论给「命令 + 输出 + 口径」；token 只认宿主面板，`字符/4` 一律标 `est4`，不当账单。

---

## 一、闭环四步

```
① 采数据（§二 的命令）→ ② 出建议（§三，标待批/不改）→ ③ 人类批准（§四 留痕）→ ④ 改画像 + 再跑 bench:decision / bench:tasks --ab 对比
```

- 第 ④ 步之前**不改任何参数**；第 ④ 步之后必须把「改动前 / 改动后」两组 bench 数字回填 §四，否则该条视为未闭环。
- 参数一律只改 `src/profiles/*.mjs`（纯参数文件，禁函数/分支/import）；解析逻辑在 `src/core/profileLoader.mjs`（`approvalScopeOf` / `evasionRiskOf`）。

---

## 二、本轮数据快照（2026-10-19 实测，全部可复算）

| 指标 | 数值 | 来源命令 / 口径 |
|---|---|---|
| 判定准确率 / 误伤率 | 100.00% / 0.00% | `npm run bench:decision`（14 用例 × 10 轮 = 140 次） |
| 判定延迟 | p50 0.41ms / p95 2.79ms / max 3.82ms | 同上（基线 p95 2.37ms，容差内 PASS） |
| 任务基准 A 组（FG 关） | 可完成 57/57 | `npm run bench:tasks -- --ab` |
| 任务基准 B 组（FG 开） | 合规 57/57，介入 15 次（应拦 15 / 误伤 0） | 同上 |
| 任务基准热路径开销 | p50 +2.09ms / p95 +68.37ms | 同上（p95 是新命令首次付 python 哨兵冷启动） |
| 审计规模（10-18~19） | 3,132 行（10-18 2,572 + 10-19 561）；全期 3,575 行；快照 `2026-10-19T20:17:18+08:00` | `rg -c '2026-10-1[89].*' .focus-guard/AUDIT.log` |
| deny 行数 / 会话数（近期） | 139 行 / 13 会话（其中 128 行带 `trigger`，11 行无该字段——`pwsh` 路径的 deny 直写不带 trigger） | `rg -c '2026-10-1[89].*"action":"deny"'` + 同正则取 `"session"` 去重 |
| deny 原因分布（近期，128 行带 trigger） | `risk:destructive_api` 50 / `high-risk-rm` 47 / `evidence-gate` 21 / `gate:fg_apply` 4 / `env-substitute` 2 / `redline:drop-database` 2 / `volume:grep` 1 / `whole-file:lines` 1 | 同上，取 `"trigger"` |
| 熔断 `stall-fuse` | 57 行 / 4 会话（`session-7bd3f3fb…` 37、`dsh-native` 18、另两会话各 1） | `rg -o -r '$1' '2026-10-1[89].*"session":"([^"]+)".*"action":"stall-fuse"'` |
| 预算延期 `budget-extend` | 19 行 / 3 会话（evidence 形如「自动续杯 budget=60 eff=50」） | 同上口径，动作名换成 `budget-extend` |
| 随机审计 `random-audit` | 61 行 / 2 会话（抽查参数在跑，供 P3 参照） | 同上口径，动作名换成 `random-audit` |
| 误伤比（全期） | 0（`appealsGranted` 0 / `denies` 182） | `npm run bench:cost -- --json` |
| 成本台账 | `cost.rows = 0`（退化值守卫已停写，**无 token 数据**） | 同上 |
| **面板 token 基线** | **缺失**（ARCH-MAP 缺口 #5） | 无面板数据 → 本轮不出任何成本类建议 |

> 口径提醒 1：`evidence-gate` 的 deny 是**设计内**的「首次改动提醒」（拒一次、同一条重试即放行）。
> 统计误伤率时**必须扣除**这一类，否则会高估误伤。本会话（`session-feda270d…`）实测 11 行全是这一类。
>
> 口径提醒 2：`AUDIT.log` 是**活文件**——本机存活的 FG 会话会持续追加行，所以复算时数字会比上表多几行（本节快照见「审计规模」行）。
> 不要用两个不同时刻的数做差，也不要拿本表去对一次新采集的结果要求逐行相等。
>
> 口径提醒 3：`AUDIT.log` 是**工作区级共享文件**，跨会话累积；会话只是每行的 `session` 字段。**换新会话不会重置本表任何数字**，
> 引用"某会话的 37 次熔断"时务必写清是哪个会话（`session-7bd3f3fb…` 是 10-18~19 的旧长会话，不是当前会话）。

---

## 三、建议条目（本轮 5 条，状态 = 待批 / 不改 / 待测量）

| # | 参数（文件） | 当前值 | 证据 | 建议 | 状态 |
|---|---|---|---|---|---|
| T1 | `evasionRisk`（五画像，`src/profiles/*.mjs`） | `high` ×5（`gpt-astra` 另带显式 `scope:'irreversible'`） | 任务基准应拦 15/15、误伤 0；`appealsGranted` 0/182；无面板基线 | **保持 `high`**。调低（`low`）只会把审批范围收窄到不可逆类别，属**放松**，在没有"放松后仍 0 误伤"的会话证据前不批 | 不改（无收益证据） |
| T2 | `budgetGate.ceiling`（flash/glm/default 200，pro 300） | 200 / 300 | `budget-extend` 19 行 / 3 会话，分母 53 个会话（10-18~19）→ 触发续杯的会话占 **3/53 ≈ 5.7%**；`inv-pool-exceeded` 4 行 / 4 会话；续杯是**自动机制**在跑，不是耗尽卡死 | **不改数值**。数值已有、判据没有：缺"续杯率到多少才算 ceiling 偏紧"的经验阈值，先攒样本 | 已有初步数值（不足以判） |
| T3 | `stalledFuse.threshold`（flash/glm/default 3，pro 4） | 3 / 4 | `stall-fuse` 57 行但集中在 1 个会话（37）——更像该会话本身停滞，而非阈值过紧 | **保持 3/4**。校准需要「熔断后浪费了多少步」这一指标，当前没有工具 | 待测量 |
| T4 | `approvalGate.scope`（派生链） | 显式 scope 优先，否则 `evasionRisk` 派生 | `gate:fg_apply` 4 行；人工闸门动作（`approval-requested` / `ptc-irreversible-blocked`）近期 **0 行** = 真实会话尚未走到该通道（rm-rf 多被红线先拦） | **保持派生逻辑**；`gpt-astra` 的显式 `irreversible` 只服务验收差异化，不迁移到生产画像 | 不改 |
| T5 | 误伤统计口径（`bench:cost` 读法） | `falsePositiveRatio = appealsGranted / denies` | `evidence-gate` 21 行为设计内提醒，会污染该比值 | **口径修正，不改参数**：报误伤时扣除 `trigger = evidence-gate` 与 `gate:fg_apply`（申请通道）两类 | 已修正（文档） |

**本轮可批的数值改动：0 条。** 两级原因分开看：
- **T2**：数字有了（3/53 会话触发续杯），缺的是**判据**（多高算偏紧），所以只能写"不改"；
- **T3**：连指标都没有——「熔断后浪费了几步」需要 step 边界，`AUDIT.log` 只记 `seq`，采不到；编一个数就是造假。

---

## 四、批准留痕（人工填写，改动前/后必须各有一组 bench）

| 日期 | 条目 | 批准人 | 旧值 → 新值 | 改动前 bench | 改动后 bench | 结论 |
|---|---|---|---|---|---|---|
| （空） | | | | | | |

留痕格式要求：
- 批准人写**人类**（谁批的），不接受"模型确认"。
- bench 必须贴命令与关键数字（`bench:decision` 的准确率/p95；`bench:tasks --ab` 的应拦/误伤）。
- 若改动未使任何指标变化，也要写"无变化"，**不得**改写成"提升"。

---

## 五、与自动化的边界

- **不做**自动调参、不做无人批准的回写、不做"bench 跑完自动改画像"。
- 允许自动化的只有**只读汇总**：读 `AUDIT.log` / `bench:cost --json` 生成 §二 的数字（当前用手册里的 5 条命令）。
- 反规避参数（`FG_RANDOM_FUSE_EVERY` 等）属 P3，与本台账无关；别在这里混着批。

---

## 六、复算命令（一条条跑，口径即结论）

```powershell
# 判定 / 任务 / 成本三类基准
cd packages/core
npm run bench:decision
npm run bench:tasks -- --ab
npm run bench:cost -- --json

# 审计：按日期、按动作、按会话
rg -o --no-filename '"ts":"[0-9-]{10}' ../../.focus-guard/AUDIT.log | Group-Object
rg -o --no-filename '"action":"[^"]+"' ../../.focus-guard/AUDIT.log | Group-Object
rg -o -r '$1' '2026-10-1[89].*"session":"([^"]+)".*"action":"stall-fuse"' ../../.focus-guard/AUDIT.log | Group-Object
rg -o -r '$1' '2026-10-1[89].*"action":"deny".*"trigger":"([^"]+)"' ../../.focus-guard/AUDIT.log | Group-Object
```

> 台账的一行数字 = 一条命令的输出。改口径先改命令，别在表里手改数字。
