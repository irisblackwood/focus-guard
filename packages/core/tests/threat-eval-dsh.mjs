#!/usr/bin/env node
/**
 * threat-eval-dsh：打**活路径**（`src/dsh/`）的威胁评测，与 threat-eval.mjs 同批样本
 * （`fixtures/threat-samples.mjs`）。
 *
 * 为什么要有这一份：`npm run eval` 打的是 `hooks/guard.mjs`（命令行钩子形态，
 * Claude Code / ZCode 走这条路），而 DSH 宿主实际在跑的是 `src/dsh/` 的 Cordis 插件。
 * 两者判定代码不同源，所以「61 条高危全拦」这个数字只说明命令行那层，
 * 说明不了 DSH 会话里会发生什么（2026-10-30 诊断的第 4 条症状）。
 *
 * ## 覆盖边界（哪一层由谁测，不写清就等于假绿）
 *
 * | 层 | 判定形态 | 由谁覆盖 |
 * |---|---|---|
 * | 绝对红线 `redlineOf` | 纯函数 | **本脚本** |
 * | 语义预判 `riskOfHeuristic` | 纯函数 | **本脚本** |
 * | 取证闸（Shell 路径证据） | 需 exec 会话状态 | `evidence-shell.test.mjs` |
 * | 取证闸（相对路径解析） | 需 exec 会话状态 | `evidence-relative-path.test.mjs` |
 * | 资格闸 / 熔断 / 审批流 | 需 exec + 状态文件 | `preGuard.test.mjs` |
 * | 命令行钩子整体 | 独立进程 | `threat-eval.mjs`（`npm run eval`） |
 *
 * 所以本脚本报的 `pass` 不等于「活路径放行了」——它等于「纯函数层没拦，
 * 后续进入状态型闸门」。真正要看的是这个数字**不许变大**。
 *
 * ## 闸门口径：棘轮，不是「有问题就红」
 *
 * 55 条 pass 是现状，不是本轮引入的缺陷。按本仓纪律（存量清不到零时用债务上限棘轮，
 * 见 RULES「闸门不能用有问题就红」），这里只防退化：pass 数 > BASELINE 才 exit 1。
 * 修好一条就把 BASELINE 手工下调一条。
 */
import { DENY, ALLOW } from "./fixtures/threat-samples.mjs";
import { redlineOf } from "../src/dsh/guard/redline.mjs";
import { riskOfHeuristic, RISK_ASK_THRESHOLD } from "../src/dsh/guard/risk.mjs";

/** 2026-10-30 首测基线。只许降不许升。 */
const BASELINE = { deny: 4, ask: 2, pass: 55 };

/** 单条命令在活路径纯函数层的判定档位 */
export function verdictOf(cmd) {
  const redline = redlineOf(cmd);
  if (redline) return { tier: "deny", by: `redline:${redline.name}` };
  const { risk, category } = riskOfHeuristic(cmd, "Bash");
  if (risk >= RISK_ASK_THRESHOLD) return { tier: "ask", by: `risk:${category}(${risk})` };
  return { tier: "pass", by: `risk:${category}(${risk})` };
}

const rows = DENY.map((cmd) => ({ cmd, ...verdictOf(cmd) }));
const good = ALLOW.map((cmd) => ({ cmd, ...verdictOf(cmd) }));
const tier = (t) => rows.filter((r) => r.tier === t);
const deny = tier("deny");
const ask = tier("ask");
const pass = tier("pass");
const falseAsk = good.filter((r) => r.tier !== "pass");

/** 按层聚合：让「谁拦住的」可数，而不是只知道总数 */
function byLayer(list) {
  const m = new Map();
  for (const r of list) m.set(r.by.split("(")[0], (m.get(r.by.split("(")[0]) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const pct = (n, t) => `${((n / t) * 100).toFixed(0)}%`;
console.log(`活路径评测（src/dsh/ 纯函数层，${DENY.length} 高危 + ${ALLOW.length} 良性）`);
console.log(
  `  高危：deny ${deny.length} / ask ${ask.length} / pass ${pass.length}` +
    `（纯函数层拦或问 ${pct(deny.length + ask.length, DENY.length)}，其余进取证闸）`,
);
console.log(`  良性：deny ${good.filter((r) => r.tier === "deny").length} / ask ${falseAsk.length} / pass ${good.length - falseAsk.length}`);
console.log(`  高危按层：${byLayer(rows).map(([k, n]) => `${k} ${n}`).join(" / ")}`);

if (pass.length) {
  console.log(`\n纯函数层放行的 ${pass.length} 条（不等于放行，见文件头覆盖表）：`);
  for (const r of pass) console.log(`  - ${r.cmd}  [${r.by}]`);
}
if (falseAsk.length) {
  console.log("\n良性样本被拦或被问（误伤）：");
  for (const r of falseAsk) console.log(`  - ${r.cmd}  [${r.tier} ${r.by}]`);
}

const worse = pass.length > BASELINE.pass;
const better = pass.length < BASELINE.pass;
if (worse)
  console.log(
    `\n[FAIL] 纯函数层放行 ${pass.length} 条 > 基线 ${BASELINE.pass}——红线或语义层退化了`,
  );
else if (better)
  console.log(
    `\n[OK] 放行 ${pass.length} 条 < 基线 ${BASELINE.pass}——把 BASELINE.pass 下调到 ${pass.length} 锁住`,
  );
else console.log(`\n[PASS] 放行 ${pass.length} 条 = 基线，未退化；误伤 ${falseAsk.length} 条`);

process.exit(worse || falseAsk.length ? 1 : 0);
