# 画像参数调优台账（PROFILE-TUNING）

> **状态**：权威 · 适用版本 3.3.0 · 最后核对 2026-10-29

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

## 二、本轮数据快照（2026-10-29 实测，全部可复算）

| 指标 | 2026-10-29 | 10-19 旧值 | 来源命令 / 口径 |
|---|---|---|---|
| 判定准确率 / 误伤率 | 100.00% / 0.00% | 100.00% / 0.00% | `npm run bench:decision`（15 用例 × 10 轮 = 150 次） |
| 判定延迟 | p50 0.42 / p95 3.18 / max 4.11 ms | p50 0.41 / p95 2.79 / max 3.82 ms | 同上。**本值已含 T6 的缓存修复**；修复前是 p95 18.35ms |
| 任务基准 A 组（FG 关） | 可完成 57/57 | 57/57 | `npm run bench:tasks -- --ab` |
| 任务基准 B 组（FG 开） | 合规 **57/57**，介入 15（应拦 15 / **误伤 0**） | 57/57，介入 15（应拦 15 / 误伤 0） | 同上。**本值已含 T7 的判据收窄**；修复前是 55/57、误伤 2 |
| 任务基准热路径开销 | p50 +5.29ms / p95 +162.10ms | p50 +2.09ms / p95 +68.37ms | 同上（p95 含 python 哨兵冷启动；修复前 p50 是 +21.59ms） |
| 审计规模 | 7,875 行 / 129 会话；快照 `2026-10-29T04:09+08:00` | 3,575 行 / 53 会话 | `wc -l .focus-guard/AUDIT.log`；会话数 `grep -o '"session":"[^"]*"' \| sort -u \| wc -l` |
| deny 行数 / 会话数 | 360 行 / 49 会话（334 带 `trigger`，26 无——`pwsh` 路径的 deny 直写不带 trigger） | 182 行 / —（128 带 trigger） | `grep -c '"action":"deny"'` + 同正则取 `"session"` 去重 |
| deny 原因分布 | 见下表 | 见下表 | `grep '"action":"deny"' \| grep -o '"trigger":"[^"]*"' \| sort \| uniq -c` |
| 熔断 `stall-fuse` | 92 行 / 7 会话 | 57 行 / 4 会话 | 同上，动作名换 `stall-fuse` |
| 预算延期 `budget-extend` | 65 行 / 9 会话 → **9/129 ≈ 7.0%** | 19 行 / 3 会话 → 3/53 ≈ 5.7% | 同上，动作名换 `budget-extend` |
| 侦查池超限 `inv-pool-exceeded` | 12 行 / 10 会话 | 4 行 / 4 会话 | 同上 |
| 随机审计 `random-audit` | 172 行 / 5 会话 | 61 行 / 2 会话 | 同上（反规避抽查在跑，供 P3 参照） |
| 熔断浪费 `fuse-waste` | 11 行 / 4 会话；浪费 38 / 17 / 3 / 1 步 | 0 行（历史熔断无 `turn`/`step`，无法回溯） | `node tools/bench-cost.mjs --json` → `report.fuseWaste` |
| 人工闸门 | `approval-requested` 0 / `ptc-irreversible-blocked` 0 | 0 / 0 | `grep -c '"action":"approval-requested"'` |
| 误伤比（全期） | 0（`appealsGranted` 0 / `denies` 360） | 0（0 / 182） | `npm run bench:cost -- --json` |
| 成本台账 | `cost.rows = 0`（**仍无 token 数据**） | 0 | 同上 |
| **面板 token 基线** | **缺失**（ARCH-MAP 缺口 #5） | 缺失 | 无面板数据 → 本轮仍不出任何成本类建议 |

**deny 原因分布对照**（2026-10-29 / 10-19）：

| trigger | 10-29 | 10-19 | 说明 |
|---|---|---|---|
| `risk:destructive_api` | 102 | 50 | 第 2 层语义 |
| `high-risk-rm` | 88 | 47 | 高危删除 |
| `evidence-gate` | 71 | 21 | **设计内提醒**，算误伤时须扣除 |
| `gate:fg_apply` | 16 | 4 | 申请通道 |
| `volume:grep` | 12 | 1 | 体积刺客 |
| `random-fuse` | 9 | — | 10-19 后新增（反规避抽查） |
| `whole-file:lines` | 8 | 1 | 整读闸 |
| `redline:drop-database` | 8 | 2 | 绝对红线 |
| `env-substitute` | 8 | 2 | 环境替代 |
| `mutation:unmapped` | 5 | — | 10-22 后新增（改动类无路径） |
| `value-gate` | 4 | — | 10-25 后新增（改动面闸），见 T7 |
| `superpowers:writing-gate` | 2 | — | 10-27 后新增（动笔闸） |
| `volume:kb` | 1 | — | — |

> 口径提醒 1：`evidence-gate` 的 deny 是**设计内**的「首次改动提醒」（拒一次、同一条重试即放行）。
> 统计误伤率时**必须扣除**这一类，否则会高估误伤。
>
> 口径提醒 2：`AUDIT.log` 是**活文件**——本机存活的 FG 会话会持续追加行，所以复算时数字会比上表多几行（本节快照见「审计规模」行）。
> 不要用两个不同时刻的数做差，也不要拿本表去对一次新采集的结果要求逐行相等。
>
> 口径提醒 3：`AUDIT.log` 是**工作区级共享文件**，跨会话累积；会话只是每行的 `session` 字段。**换新会话不会重置本表任何数字**。
>
> 口径提醒 4（2026-10-29 新增）：`bench:decision` 的延迟基线是 10-18 的旧标尺（`BENCH-BASELINE.json` 的 `_latencyNote` 写明"刻意不放宽"）。
> 本轮曾实测到 p95 18.35ms（越报警阈值），定位为 `detectSearchBackends` 无缓存（T6），修后回到 3.18ms。
> **延迟劣化与判定质量是两件事**——准确率 100%、误伤 0 的时候，延迟仍可能翻倍；别混着报，也别用一个盖住另一个。

---

## 三、建议条目（本轮 7 条）

| # | 参数（文件） | 当前值 | 证据 | 建议 | 状态 |
|---|---|---|---|---|---|
| T1 | `evasionRisk`（五画像，`src/profiles/*.mjs`） | `high` ×5（`gpt-astra` 另带显式 `scope:'irreversible'`） | 任务基准应拦 15/15 ✓、误伤 2（T40/T41，**与 `evasionRisk` 无关**，是 `value-gate` 触发）；`appealsGranted` 0/360；无面板基线 | **保持 `high`**。调低属**放松**，在没有"放松后仍 0 误伤"的会话证据前不批 | 不改（无收益证据） |
| T2 | `budgetGate.ceiling`（flash/glm/default 200，pro 300） | 200 / 300 | `budget-extend` 65 行 / 9 会话，分母 129 → **7.0%**（10-19 为 3/53 ≈ 5.7%）；`inv-pool-exceeded` 12 行 / 10 会话 | **不改数值**。两轮比率都在 5–7%，没有恶化趋势；仍缺"续杯率到多少算偏紧"的经验阈值 | 数据已更新（判据仍缺） |
| T3 | `stalledFuse.threshold`（flash/glm/default 3，pro 4） | 3 / 4 | **样本已到**：`fuseWaste.bySession` 4 会话 / 11 行，浪费 38 / 17 / 3 / 1 步；38 仍集中在 10-18 的旧长会话 `7bd3f3fb…`（4 回合、单回合最多 18） | **保持 3/4**。判读：熔断后每回合仍浪费 1–9.5 步（38÷4、17÷5、3÷1、1÷1），指向"模型不知道已熔断"而非"阈值过紧"；10-27 已加 `focus-guard-fuse` 系统提示段，等新会话验证该段是否压低浪费 | 已有判读（待新样本验证） |
| T4 | `approvalGate.scope`（派生链） | 显式 scope 优先，否则 `evasionRisk` 派生 | `gate:fg_apply` 16 行（10-19 为 4）；人工闸门动作 `approval-requested` / `ptc-irreversible-blocked` 仍 **0 行** = 真实会话尚未走到该通道（rm-rf 多被红线先拦） | **保持派生逻辑**；`gpt-astra` 的显式 `irreversible` 只服务验收差异化，不迁移到生产画像 | 不改 |
| T5 | 误伤统计口径（`bench:cost` 读法） | `falsePositiveRatio = appealsGranted / denies` | `evidence-gate` 71 行为设计内提醒，会污染该比值 | **口径修正，不改参数**：报误伤时扣除 `trigger = evidence-gate` 与 `gate:fg_apply` 两类 | 已修正（文档） |
| T6 | 判定延迟基线（`docs/BENCH-BASELINE.json`） | p95 2.37ms（10-18 标尺，报警阈值 12.11ms） | **已修**：根因是 `detectSearchBackends()` 每步扫 PATH（73 目录 × 3 后端 × 4 扩展名 = 876 次 `accessSync`，单次 13.72ms），模块头注释写"每会话探测一次并缓存"但实现没缓存。加 TTL 缓存（键含 `PATH`/`FG_SEARCH_TOOL`/`FG_SEARCH_BIN_DIR`）后 p95 **18.35 → 3.18ms** | 基线**不动**（现在 p95 3.18 已在阈值内，无需放宽）；`ee580e0` 对照同为 14.5ms，确认非 PRE_STAGES 改造引入 | **已修（缓存 + 4 条测试）** |
| T7 | `value-gate.shouldGate` 的 `npm install` 触发条件 | 任何 `npm/pnpm/yarn/bun/pip/uv install\|add` 都返回 true（2026-10-25 有意放宽） | **已修**：按本闸立意（"新增依赖 = 长期维护负担"）收窄为 `isNewDependency`——裸 `install`/`ci`/`--production` 放行（装已声明的），`-D`/`--save-dev` 放行（不进产物），只有**带包名的生产依赖**才拦；`pip install -r` 的文件参数靠 `FLAG_WITH_ARG_RE` 跳过。任务基准 **55/57 → 57/57，误伤 2 → 0** | 设计意图保留，验收标准不作废——两边都没让步 | **已修（+3 条测试）** |

**本轮可批的数值改动：0 条。** 四条的原因分开看：

- **T2**：比率 7.0%，比上轮的 5.7% 略高但仍在噪声内；缺的是判据不是数据。
- **T3**：样本到了、判读也有了，但判读结论是"保持"——它现在等的是 `focus-guard-fuse` 段上线后的新样本，不是等一次调参。
- **T6**：不是参数问题，是**代码 bug**（注释说有缓存、实现没有）。修完 p95 回到 3.18ms，基线一个数都没动。
- **T7**：不是数值问题，是**判据范围**问题。收窄判据后设计意图与验收标准同时成立，没有牺牲任何一边。

**这两条的共同点：测量报出来的"参数该调了"，查下去都不是参数问题。** T6 是缓存缺失，T7 是判据过宽。这正是闭环第 ② 步的价值——它逼人去看证据，而不是看阈值。

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

```bash
# 判定 / 任务 / 成本三类基准
cd packages/core
npm run bench:decision
npm run bench:tasks -- --ab
npm run bench:cost -- --json

# 审计（bash）。全期统计，**不绑日期**——旧版本把 2026-10-1[89] 写死在正则里，
# 复算新快照时会静默漏掉全部新行，这是口径 bug 不是用法问题。
F=../../.focus-guard/AUDIT.log
wc -l < $F                                                # 总行数
grep -oE '"session":"[^"]+"' $F | sort -u | wc -l         # 会话总数（budget-extend 的分母）
grep -c '"action":"deny"' $F                              # deny 行数
grep '"action":"deny"' $F | grep -oE '"session":"[^"]+"' | sort -u | wc -l
grep '"action":"deny"' $F | grep -oE '"trigger":"[^"]+"' | sort | uniq -c | sort -rn
for a in stall-fuse budget-extend random-audit fuse-waste inv-pool-exceeded approval-requested; do
  echo "$a: $(grep -c "\"action\":\"$a\"" $F) 行 / $(grep "\"action\":\"$a\"" $F | grep -oE '"session":"[^"]+"' | sort -u | wc -l) 会话"
done
```

> PowerShell 等价：`Get-Content $F | Select-String '"action":"deny"'` 配合 `Group-Object`；
> 关键是**别在正则里写死日期**，否则复算必然漏行。
>
> 台账的一行数字 = 一条命令的输出。改口径先改命令，别在表里手改数字。
