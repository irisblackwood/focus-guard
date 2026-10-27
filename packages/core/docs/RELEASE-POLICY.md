# 版本策略（RELEASE-POLICY）

> 人类批示 2026-10-22：**每 10 次修复合为一次变更（x.x.0）；其余按补丁号递增**。

## 一、什么时候升什么号

| 触发 | 升法 | 例 |
|---|---|---|
| 累积 **10 次修复**（按 CHANGELOG 条目计） | **次版本 +1，补丁归零**：`x.x.0` | `3.0.9` → `3.1.0` |
| 单次修复 / 小改动（未满 10 次） | **补丁 +1** | `3.0.8` → `3.0.9` |
| 破坏性行为变更（红线增减、默认档位翻转、许可变更） | 也走 **x.x.0**，并在 CHANGELOG 标「行为变更」 | `3.1.0` |
| 仅文档/注释/测试，无行为变化 | **不升版本**，只记 CHANGELOG | — |
| 发布到 npm | 由人类批示；发布即不可回退（版本号不可复用） | — |

**计数口径**：以 CHANGELOG 中该版本下的 `- fix(...)` / `- feat(...)` 条目数为准（`docs` / `chore` 不计入 10 次）。
一条提交含多个条目时按**条目数**计；`feat` 与 `fix` 同权计入。

**计数基线（2026-10-22 人类批示后确定）**：**3.0.9 为基线**，不追溯更早的历史条目。
理由：3.0.8 从未发布 npm，3.0.9 段里混入了 3.0.8 时代的内容（51 条），追溯会把版本号跳到 3.5.0 而对外无意义。

实际执行：

- `3.0.9` 之后累积 **7 条**（fix 3 / feat 4）→ 未满 10，故发 **3.0.10**（补丁号）。
- `3.0.10` 之后累积 **17 条**（fix 12 / feat 5，其中 10 条来自 10-27 质量门自证、7 条来自同轮工具链内置化）→ 满 10，故发 **3.2.0**。
- 下次基线从 3.2.0 起算，满 10 条时升 **3.3.0**。

## 二、必须同步的版本面（7 处清单 + 2 个常量 + CHANGELOG）

```
package.json
marketplace.json
.zcode-plugin/plugin.json
.claude-plugin/plugin.json
.claude-plugin/marketplace.json
packages/core/package.json
packages/extended/package.json
packages/core/src/core/constants.mjs        ENGINE_VERSION
packages/core/src/dsh/pipeline.mjs           PIPELINE_VERSION（格式 x.y.z-mN）
CHANGELOG.md                                 最新条目（须等于上述版本）
```

验收用例（`tests/acceptance.test.mjs`）已锁：七处清单 + `ENGINE_VERSION` 相同、且等于 CHANGELOG 最新条目（防「一致地落后」）。
`packages/core/hooks/guard.mjs` 是**封存**文件，版本独立，**不参与**升版。

## 三、升版动作清单

1. 改上述 7+2 处版本（`PIPELINE_VERSION` 例外：它记的是 `pipeline.mjs` 最后一次改动，本文件没动就不动）
2. `CHANGELOG.md` 把累积区改为 `## x.y.z · 日期`，条目按 `fix/feat/perf/docs/chore` 前缀
3. 面向使用者的改法同步 `README.md` / `README.zh-CN.md` / `INSTALL.md`
4. `npm run check`（含 schema 指纹、真实夹具回归、等变矩阵）；全绿才允许提交
5. 本地提交；**推送只在每天 20:00 批次**（人类批示）
