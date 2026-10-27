import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// 质量门审计工具自身的验收（2026-10-27）
//
// 这个工具审计的是「质量门本身」，所以它自己必须先被审计——否则就是
// 「测量工具没被测量」的又一次重犯（本仓已犯过三次）。
//
// 分工（2026-10-27 定）：本工具只管**条款口径**；**测试强度**交给 Stryker
// （`npm run quality:mutate`，npx 按需，不进依赖）。故此处只测口径侧。
//
// ── 2026-10-27 二次改：检出用例改用夹具 ──
// 原先的检出用例断言的是**活文档当前状态**（"第八十七~九十一条必须被报为未交代"）。
// 那 14 条一旦真的被处置掉，用例就从"验证工具能检出"变成"验证文档还没修完"——
// 两件事混在一起，改文档就会误伤测试，而测试是绿是红都不再说明工具是否好用。
// 现改为：检出能力用夹具验证（稳定），活文档只留一条结论断言（"全部已交代"）。

const here = dirname(fileURLToPath(import.meta.url));
const CORE = join(here, "..");
const ROOT = join(CORE, "..", "..");
const TOOL = join(CORE, "tools/quality-audit.mjs");
const STRIKER_CONFIG = join(ROOT, "stryker.config.json");

const run = (args) => {
  const r = spawnSync("node", [TOOL, ...args], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
};

/**
 * 夹具：三条条款，覆盖三种状态各一条。
 *   第七十四条 → 进映射表（不该被报）
 *   第七十五条 → 两处都没有（**必须**被报）
 *   第七十六条 → 只在未机械化清单（不该被报）
 * 结构锚点与真文档一致，否则工具会抛"结构锚点缺失"。
 */
const FIXTURE = `# 夹具（不参与运行，仅喂给 quality-audit --rules）

## 第一部分：法条正文

### 第十五章之一 测试章

- **第七十四条** 已映射条款。正文。
- **第七十五条** 未交代条款甲。正文。
- **第七十六条** 已申报未机械化条款乙。正文。

## 第三部分：技术映射明细（条款 → 钩子实现）

| 条款 | 检查逻辑 |
|------|----------|
| 第七十四条 | 某检查 |

## 第四部分：常驻提示词

文本。

**未机械化条款清单**（诚实申报：法条存在、引擎无对应实现）：

| 条款 | 内容 | 状态 |
|------|------|------|
| 第七十六条 | 乙 | 未机械化 |
`;

const dir = mkdtempSync(join(tmpdir(), "fg-qa-"));
const FIXTURE_PATH = join(dir, "RULES.md");
writeFileSync(FIXTURE_PATH, FIXTURE);
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const runFixture = (args) => run(["--rules", FIXTURE_PATH, ...args]);

test("检出能力：夹具里两处都无的条款必须被报为未交代", () => {
  const ledger = JSON.parse(runFixture(["--json"]).out);
  const holes = ledger.holes.map((h) => h.no);
  assert.deepEqual(holes, ["第七十五条"], `应只报第七十五条，实际：${holes.join("、") || "(空)"}`);
  assert.equal(ledger.total, 3, "夹具应识别出 3 条增补章条款");
});

test("检出能力：进映射表或进清单的条款都不得误报", () => {
  // 反向断言。没有这条，工具可以靠「全部报未交代」通过上一个用例。
  const ledger = JSON.parse(runFixture(["--json"]).out);
  const holes = ledger.holes.map((h) => h.no);
  assert.ok(!holes.includes("第七十四条"), "第七十四条已进映射表，不应被报");
  assert.ok(!holes.includes("第七十六条"), "第七十六条已在未机械化清单，不应被报");
  const byNo = Object.fromEntries(ledger.rows.map((r) => [r.no, r]));
  assert.equal(byNo["第七十四条"].mapped, true);
  assert.equal(byNo["第七十六条"].listed, true);
});

test("退出码：默认只报不改（exit 0）；--strict 才阻断", () => {
  // 与 gate-audit 同纪律。若默认就 exit 1，`npm run check` 会永久红。
  assert.equal(runFixture([]).code, 0, "默认模式不得阻断");
  assert.equal(runFixture(["--strict"]).code, 1, "夹具存在未交代条款时 --strict 应 exit 1");
});

test("--brief 只输出一行（不抢占上下文）", () => {
  // 人类判据「做个比较薄的不抢占主内容就行」。brief 会进 `npm run check`，
  // 若它输出明细，每次 check 都把这些搬进模型上下文。
  const r = runFixture(["--brief"]);
  const lines = r.out.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `brief 应只有 1 行，实际 ${lines.length} 行：\n${r.out}`);
  assert.match(lines[0], /未交代 \d+/, "brief 必须报出未交代条数");
  assert.doesNotMatch(lines[0], /第七十五条/, "brief 不得列条款号（列了就等于把明细搬回上下文）");
  assert.equal(r.code, 0, "brief 也不得阻断");
});

test("结构锚点缺失时明确报错，而不是静默算成 0 条未交代", () => {
  // 最危险的失败模式：锚点找不到却返回空结果，看起来"全部已交代"。
  const bad = join(dir, "bad.md");
  writeFileSync(bad, "# 没有第三部分也没有清单\n");
  const r = run(["--rules", bad, "--json"]);
  assert.notEqual(r.code, 0, "锚点缺失应 exit 非 0");
  assert.match(r.out, /结构锚点缺失/, "应明确说明缺哪个锚点");
});

test("未机械化清单的重复行必须被报出（Set 去重会掩盖它）", () => {
  // 2026-10-27 实况：清单里 `第四十八条` 曾整行重复两遍，而对账用 `new Set` 去重，
  // 所以永远看不见——清单看起来收全了，实际有一行是复制粘贴的垃圾。
  const dup = join(dir, "dup.md");
  writeFileSync(
    dup,
    FIXTURE.replace(
      "| 第七十六条 | 乙 | 未机械化 |",
      "| 第七十六条 | 乙 | 未机械化 |\n| 第七十六条 | 乙 | 未机械化 |",
    ),
  );
  const ledger = JSON.parse(run(["--rules", dup, "--json"]).out);
  assert.deepEqual(ledger.dupInList, ["第七十六条×2"], `应报出重复行，实际 ${JSON.stringify(ledger.dupInList)}`);
  assert.equal(run(["--rules", dup, "--strict"]).code, 1, "有重复行时 --strict 也应阻断");
  // 反向：干净夹具不得误报
  assert.deepEqual(JSON.parse(runFixture(["--json"]).out).dupInList, [], "干净夹具不应报重复");
});

test("活文档：增补章 18 条全部已交代（0 未交代）", () => {
  // 结论断言。检出能力由上面用夹具验证；这里只锁「真文档当前没有空头条款」。
  // 2026-10-27：此前 14 条未交代，当日逐条核实后 5 条补映射、9 条进未机械化清单。
  const ledger = JSON.parse(run(["--json"]).out);
  assert.equal(ledger.total, 18, "增补章立条应为 18 条");
  assert.deepEqual(
    ledger.holes.map((h) => h.no),
    [],
    `真文档仍有未交代条款：${ledger.holes.map((h) => `${h.no}(${h.title})`).join("、")}`,
  );
});

test("JSON 输出结构完整（total/rows/holes 齐备）", () => {
  const ledger = JSON.parse(run(["--json"]).out);
  assert.equal(typeof ledger.total, "number");
  assert.ok(Array.isArray(ledger.rows) && ledger.rows.length > 0, "rows 应非空");
  assert.ok(Array.isArray(ledger.holes), "holes 应为数组");
  assert.ok(ledger.total >= ledger.holes.length, "未交代数不应超过总条数");
  // 每行三态齐全，缺字段会让下游脚本静默算出错误统计
  for (const row of ledger.rows) {
    assert.ok(row.no && typeof row.title === "string", `行结构不完整：${JSON.stringify(row)}`);
    assert.equal(typeof row.mapped, "boolean");
    assert.equal(typeof row.listed, "boolean");
  }
});

test("Stryker 配置存在且不破坏零依赖（变异测试走 npx 按需）", () => {
  // 2026-10-27 实测：Stryker 单文件 6 秒生成 51 个变异体，比手写 9 个强得多。
  // 但它有 27 个直接依赖，会打破本仓零依赖 —— 所以只能 npx 按需跑，绝不进 package.json。
  assert.ok(existsSync(STRIKER_CONFIG), "stryker.config.json 缺失");
  const cfg = JSON.parse(readFileSync(STRIKER_CONFIG, "utf8"));
  assert.equal(cfg.testRunner, "tap", "必须用 tap runner（本仓测试是 node:test）");
  assert.ok(Array.isArray(cfg.mutate) && cfg.mutate.length > 0, "mutate 范围不得为空");
  assert.ok(
    cfg.mutate.every((g) => g.replace(/^!/, "").startsWith("packages/core/src/")),
    "变异范围应限于源码层（允许 ! 前缀的排除项）",
  );
  // 2026-10-27 改：原先断言 `break === null`（不因分数低而阻断）。当天判定这个理由站不住——
  // **一个永不阻断的闸门等于没有闸门**，正是「质量门没用」的同一个病。现改为必须设真实阈值，
  // 且落在 [low, high] 区间内（低于 low 才 break，等于把 low 当门槛）。
  const th = cfg.thresholds || {};
  assert.equal(typeof th.break, "number", `thresholds.break 必须是数字（当前 ${JSON.stringify(th.break)}）——永不阻断的闸门等于没有闸门`);
  assert.ok(th.break >= 0 && th.break <= 100, "break 应为百分制分数");
  assert.ok(th.break >= th.low, `break(${th.break}) 不应低于 low(${th.low})，否则闸门永远不响`);

  // constants.mjs 进变异范围是 2026-10-27 解耦的结果：acceptance 的 3 处文本断言已改成
  // import 运行时值。这条断言防它被悄悄挪回去（挪回去会静默降低判定模块的覆盖）。
  assert.ok(
    cfg.mutate.some((g) => /core\/constants\.mjs$/.test(g)),
    "constants.mjs 应进默认变异范围（文本断言已解耦，不得再排除）",
  );

  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  assert.deepEqual(Object.keys(deps), [], `零依赖被打破：${Object.keys(deps).join(", ")}`);
  assert.match(pkg.scripts["quality:mutate"], /npx/, "quality:mutate 应经 npx 拉取，而非本地安装");
});
