# 交接 · 2026-10-19 晚（P1/P2 + 审计元数据 + 抽查B + 取证键修复）

> 用途：20 分钟收尾交接。承接 `HANDOFF-2026-10-19.md`（3.0.8 主交接），只记本会话增量。
> 版本仍 **3.0.8 未发 npm**（npm 最新 3.0.7 / MIT / 不可撤销）；本会话改动全部进「未发版」节，未 bump。

## 一、本会话已提交（本地，未推送）

| commit | 内容 |
|---|---|
| `ca6b335` | L1 画像包 `evasionRisk` 接线（`profileLoader.approvalScopeOf` 唯一真源，闸同源） |
| `3381815` | P2 回流台账 `docs/PROFILE-TUNING.md`（人工批准制，5 条建议，0 条可批） |
| `22c32b3` | 台账口径更正（AUDIT.log 跨会话累积 / T2 有数缺判据 / T3 缺指标） |
| `753c1a1` | 审计行补 `turn`/`step` + `fuse-waste` 按会话结算 + `bench:cost` 的 `fuseWaste` |
| `39592d1` | 反规避抽查B 参数化（`FG_RANDOM_FUSE` / `FG_RANDOM_FUSE_EVERY`，默认关） |
| `f553301` | 取证键归一化（修「读过仍被拒一次」：相对/绝对、正/反斜杠统一为绝对+正斜杠） |

推送纪律：20:00 窗口已过 → 本批留到下一个 20:00（`git status -sb` 会显示 ahead）。

## 二、本会话实测（可复算）

```
npm run check        → tests 346 / pass 346 / fail 0；audit-isolation Δ 行 0 / Δ 字节 0 PASS
npm run bench:decision → 准确率 100.00% / 误伤 0.00% / p50 0.41ms / p95 2.79ms PASS
npm run bench:tasks -- --ab → A 57/57、B 57/57、介入 15（应拦 15 / 误伤 0）、p50 +2.09ms / p95 +68.37ms
本会话取证闸拒拦 22 次（全部“相对路径读后改”同一个 bug，已修）
```

## 三、本会话新增/更新的文档

- `packages/core/docs/PROFILE-TUNING.md`（P2 台账：T1-T5，含 `fuse-waste` 快照行）
- `packages/core/docs/BENCH.md`（新增「熔断浪费（fuse-waste）」小节）
- `packages/core/docs/ARCH-MAP.md`（L1 ✅、L5 抽查B ✅默认关、缺口 #3/#4/#5 改写）
- 图表（`.gitignore` 忽略，不入库，可重生）：
  - `.archify/architecture-fg-overview-20261019-2100/fg-architecture.html`
  - `.archify/workflow-fg-turn-20261019-2100/fg-turn-flow.html`
  - 用 archify `finalize` 生成；本机无 Chrome，用 `ARCHIFY_CHROME=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`

## 四、当前缺口（下会话按此推进）

1. **3.0.8 面板基线**（缺口 #5）：需人类跑 ≥5 轮同任务会话；没有它，任何成本类结论都只能写条件性。
2. **契约探针**（我提议但未做）：把“15/15 注册成功”升级为“载荷契约可用”（pre-step 的 turn/step、turn-stopping 的 agent）；要新能力授权。
3. **抽查B 默认开 + RULES 条款**：代码已参数化但默认关；正式启用需在 `RULES.md:90` 第三十五条旁补条款（修法要批示）。
4. **缺口 #1 隐藏高危工具**：等宿主“按任务暴露工具”接口，FG 侧只能默认拒绝+按需解锁。
5. **缺口 #2 相位对抗 / Nudge**：无 KV 盲区测量手段，不做。
6. **T2/T3 判据**：T2 已有数（`budget-extend` 19 行 / 3 会话，分母 53 会话 ≈ 5.7%）缺阈值；T3 指标已通（`fuse-waste`）但历史 57 次熔断无元数据，只能等新样本。

## 五、口径提醒（别再踩）

- `AUDIT.log` 是**工作区级共享文件**，跨会话累积；引用某会话数字必须写全会话 id。
- 审计 `turn`/`step` 来源只有 `agent/pre-step`；`tools/pre-execute` 的 `exec` 没有这两个字段。
- 取证键必须归一化：**绝对路径 + 正斜杠**；`rememberReads` 与 `layer3Check` 两侧同形态，否则“读过仍被拒一次”。
- `evidence-gate` 的 deny 是设计内「拒一次」，统计误伤时必须扣除。
- 图表 `.archify/` 不入库；重生要带 `--repo-root` 与 `ARCHIFY_CHROME`。
