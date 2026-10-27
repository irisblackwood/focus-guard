/**
 * 内置工具链的测试（2026-10-27）。
 *
 * 为什么必须有这个文件：`tools/lint.mjs` / `smells.mjs` / `health.mjs` 是我用来**量别人**的尺子。
 * 本仓已经因为"尺子自己没被量"翻过三次车：
 *   ① 合成参数 → 假绿（夹具参数与真实调用不符，测试全绿、线上全漏）
 *   ② 比率指标被分母操纵（步数伪影当成缓存改善）
 *   ③ 关键词匹配测不出"改写采入"（判"零落地"，实际 14/19 已落地）
 * 所以这里测的不是"工具能跑"，而是**每条规则的边界**：该报的必须报，不该报的必须不报。
 *
 * 全部用夹具目录（`FG_REPO_ROOT` 指到 tmpdir），不碰真实仓库：
 * 否则用例会从"验证工具能检出"退化成"验证仓库当前还没修完"——`quality-audit` 上踩过。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  splitLintByLayer,
  classifyReach,
  weightedScore,
  dimensionScore,
  cappedScore,
} from "../tools/lib/health-core.mjs";

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), "../tools");

/**
 * 造一个假仓库：`files` 是 `{ 相对路径: 内容 }`，相对 `packages/core/`。
 * 返回 { dir, run, cleanup }——`run` 在假仓库上跑指定工具。
 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "fg-tool-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, "packages/core", rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return {
    dir,
    run(tool, args = []) {
      const r = spawnSync("node", [join(TOOLS, tool), ...args], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, FG_REPO_ROOT: dir },
      });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ───────────────────────── lint：五条规则的边界 ─────────────────────────

test("lint：死 import 必须报，用到的 import 不许报", () => {
  const f = fixture({
    "src/core/a.mjs": `import { used } from './b.mjs'\nimport { dead } from './c.mjs'\nexport const x = used()\n`,
    "src/core/b.mjs": `export const used = () => 1\n`,
    "src/core/c.mjs": `export const dead = 1\n`,
  });
  try {
    const r = f.run("lint.mjs", ["--json"]);
    const j = JSON.parse(r.out);
    const dead = j.findings.filter((x) => x.rule === "unused-import");
    assert.equal(dead.length, 1, "只应报 dead 那一条");
    assert.match(dead[0].detail, /dead/);
  } finally {
    f.cleanup();
  }
});

test("lint：宽松相等只报真 ==，不报 === / !==，也不报字符串里的 ==", () => {
  // 这条踩过两次：首版 `[^=!<>]!?==[^=]` 把 `!==` 吃进去；二版 `[!=]==` 把 `===` 吃进去。
  const f = fixture({
    "src/core/a.mjs": [
      `export function f(a, b) {`,
      `  const s = 'a == b'`,
      `  const t = "x != y"`,
      `  if (a === b) return 1`,
      `  if (a !== b) return 2`,
      `  if (a == b) return 3`, // ← 只有这条该报
      `  return s.length + t.length`,
      `}`,
      ``,
    ].join("\n"),
  });
  try {
    const j = JSON.parse(f.run("lint.mjs", ["--json"]).out);
    const loose = j.findings.filter((x) => x.rule === "loose-equal");
    assert.equal(loose.length, 1, `应只报 1 条，实际 ${loose.length}：${JSON.stringify(loose)}`);
    assert.equal(loose[0].line, 6);
  } finally {
    f.cleanup();
  }
});

test("lint：`== null` 是惯用法，不报", () => {
  const f = fixture({
    "src/core/a.mjs": `export const f = (v) => (v == null ? 1 : 2)\n`,
  });
  try {
    const j = JSON.parse(f.run("lint.mjs", ["--json"]).out);
    assert.equal(j.findings.filter((x) => x.rule === "loose-equal").length, 0);
  } finally {
    f.cleanup();
  }
});

test("lint：console 在母版层要报，在宿主缝（CLI）不报", () => {
  const f = fixture({
    "src/core/pure.mjs": `export function f() {\n  console.log('debug')\n}\n`,
    "src/dsh/cli.mjs": `export function g() {\n  console.log('这是 CLI 输出，合法')\n}\n`,
  });
  try {
    const j = JSON.parse(f.run("lint.mjs", ["--json"]).out);
    const hits = j.findings.filter((x) => x.rule === "console-in-src");
    assert.equal(hits.length, 1, "只有母版层那条该报");
    assert.match(hits[0].file, /src\/core\/pure\.mjs$/);
  } finally {
    f.cleanup();
  }
});

test("lint 闸门：封存层不计入，活跃层超上限才 exit 1", () => {
  // 关键用例：这条闸门如果永远绿，等于没有闸门；永远红，则训练人忽略告警。
  const frozen = fixture({
    "hooks/guard.mjs": `import { dead } from './nowhere.mjs'\nexport const x = 1\n`,
  });
  const active = fixture({
    "src/core/a.mjs": `import { dead } from './nowhere.mjs'\nexport const x = 1\n`,
  });
  try {
    // 封存层：报出来，但闸门放行
    const r1 = frozen.run("lint.mjs", ["--strict", "--brief"]);
    assert.equal(r1.code, 0, `封存层不该阻断：${r1.out}`);
    assert.match(r1.out, /封存层 1 条/);

    // 活跃层：必须阻断
    const r2 = active.run("lint.mjs", ["--strict", "--brief"]);
    assert.equal(r2.code, 1, `活跃层 1 条必须阻断：${r2.out}`);
    assert.match(r2.out, /活跃层 1 条 > 上限 0/);

    // 不带 --strict：恒 0（只报不改）
    assert.equal(active.run("lint.mjs", ["--brief"]).code, 0);
  } finally {
    frozen.cleanup();
    active.cleanup();
  }
});

// ───────────────────────── smells：三条指标 ─────────────────────────

test("smells：超长文件与超长函数都要报，短的不许报", () => {
  const longFile = Array.from({ length: 401 }, (_, i) => `export const v${i} = ${i}`).join("\n");
  const f = fixture({
    "src/core/long.mjs": longFile + "\n",
    "src/core/short.mjs": `export const a = 1\n`,
  });
  try {
    const j = JSON.parse(f.run("smells.mjs", ["--json"]).out);
    const kinds = j.srcFindings.map((x) => `${x.kind}:${x.file}`);
    assert.ok(kinds.some((k) => k.startsWith("file-length") && k.includes("long.mjs")), "401 行必须报 file-length");
    assert.ok(!kinds.some((k) => k.includes("short.mjs")), "2 行的文件不许报");
  } finally {
    f.cleanup();
  }
});

test("smells：函数参数表里的花括号不算函数体（量长度必须跳过参数表）", () => {
  // 这条踩过：`function f({ warn } = {}) {` 参数里的花括号让深度同一行归零，
  // 398 行的 preExecuteListener 被量成 1 行。
  const body = Array.from({ length: 90 }, (_, i) => `  const v${i} = ${i}`).join("\n");
  const f = fixture({
    "src/core/params.mjs": `export function f({ warn, observe } = {}) {\n${body}\n}\n`,
  });
  try {
    const j = JSON.parse(f.run("smells.mjs", ["--json"]).out);
    const hit = j.srcFindings.find((x) => x.kind === "long-function");
    assert.ok(hit, "92 行函数必须报 long-function（参数表里的花括号不能让它归零）");
    assert.ok(hit.value >= 90, `量出的行数应 ≥90，实际 ${hit.value}`);
  } finally {
    f.cleanup();
  }
});

test("smells：正则字面量里的引号不许吃掉后面的代码", () => {
  // 这条踩过：`/['"]/` 里的引号被当成字符串开头，一路吞到下一个引号，
  // 把中间的 export function 抹平——398 行的函数量成"不存在"。
  const body = Array.from({ length: 90 }, (_, i) => `  const v${i} = ${i}`).join("\n");
  const f = fixture({
    "src/core/regex.mjs": [
      `const QUOTE = /['"]/`,
      `export function afterRegex() {`,
      body,
      `}`,
      ``,
    ].join("\n"),
  });
  try {
    const j = JSON.parse(f.run("smells.mjs", ["--json"]).out);
    const hit = j.srcFindings.find((x) => x.kind === "long-function" && /afterRegex/.test(x.detail));
    assert.ok(hit, `正则字面量之后的函数必须仍被量到：${JSON.stringify(j.srcFindings)}`);
    assert.ok(hit.value >= 90);
  } finally {
    f.cleanup();
  }
});

test("smells：测试文件的长函数单独归类，不进源文件口径", () => {
  const body = Array.from({ length: 90 }, (_, i) => `  const v${i} = ${i}`).join("\n");
  const f = fixture({
    "tests/x.test.mjs": `function longHelper() {\n${body}\n}\ntest('t', () => longHelper())\n`,
  });
  try {
    const j = JSON.parse(f.run("smells.mjs", ["--json"]).out);
    assert.equal(j.srcFindings.length, 0, "测试文件不该进 srcFindings");
    assert.ok(j.testFindings.length > 0, "但必须被单独报出来");
  } finally {
    f.cleanup();
  }
});

test("smells 已知局限：匿名回调不计函数长度（如实锁住，别以为它覆盖了）", () => {
  // 工具只认具名函数声明与具名箭头赋值（`FUNC_START` 三条正则都要求行首具名）。
  // `test('t', () => { ...200 行... })` 这种匿名回调**量不到**。
  // 这条用例不是为了通过而写——它把局限固定下来：将来谁想扩展，先看这里。
  // 代价说明：src 里 `setInterval(() => {...})` 这类长回调也会漏；漏报比误报隐蔽，故明示。
  const body = Array.from({ length: 90 }, (_, i) => `  const v${i} = ${i}`).join("\n");
  const f = fixture({
    "src/core/anon.mjs": `register('x', () => {\n${body}\n})\n`,
  });
  try {
    const j = JSON.parse(f.run("smells.mjs", ["--json"]).out);
    const hit = j.srcFindings.find((x) => x.kind === "long-function");
    assert.equal(hit, undefined, "匿名回调当前不被计入——若这里失败，说明工具已扩展，请同步改注释与本用例");
  } finally {
    f.cleanup();
  }
});

// ───────────────────────── health-core：纯逻辑 ─────────────────────────

test("splitLintByLayer：四层分流，未知路径归 tools（不丢）", () => {
  const r = splitLintByLayer([
    { file: "packages/core/src/core/a.mjs" },
    { file: "packages/core/src/dsh/b.mjs" },
    { file: "packages/core/tools/c.mjs" },
    { file: "packages/core/tests/d.mjs" },
    { file: "packages/core/hooks/e.mjs" },
    { file: "packages/extended/src/f.mjs" },
  ]);
  assert.equal(r.src.length, 2, "src/ 下所有子层都算活跃层");
  assert.equal(r.tools.length, 2, "未知路径必须归到 tools，不许静默丢弃");
  assert.equal(r.tests.length, 1);
  assert.equal(r.hooks.length, 1);
});

test("classifyReach：传递闭包——间接引用的模块算可达", () => {
  // 这条是本工具的第一次翻车：只扫直接 import，`core/audit.mjs` 被判"零测试引用"，
  // 而它明明被 postProgress.mjs 与 seams.mjs import，那两者测得很厚。
  const graph = {
    "t/a.test.mjs": ["src/core/entry.mjs"],
    "src/core/entry.mjs": ["src/core/mid.mjs"],
    "src/core/mid.mjs": ["src/core/deep.mjs"],
    "src/core/deep.mjs": [],
  };
  const r = classifyReach({
    srcFiles: ["src/core/entry.mjs", "src/core/mid.mjs", "src/core/deep.mjs"],
    testSeeds: ["t/a.test.mjs"],
    frozenSeeds: [],
    depsOf: (f) => graph[f] || [],
  });
  assert.equal(r.active, 3, "三层链路必须全部可达");
  assert.deepEqual(r.orphan, []);
});

test("classifyReach：只从封存层可达的算 frozenOnly，不算 orphan", () => {
  // 依据：core/approval.mjs 只被已封存的 hooks/guard.mjs 引用，原生侧已由
  // adapters/dsh/eligibility-gate.mjs 替代。它不是"缺测试"，是"只服务封存路径"。
  const graph = {
    "hooks/guard.mjs": ["src/core/only-frozen.mjs"],
    "src/core/only-frozen.mjs": [],
  };
  const r = classifyReach({
    srcFiles: ["src/core/only-frozen.mjs"],
    testSeeds: ["tests/a.test.mjs"], // 测试文件到不了它
    frozenSeeds: ["hooks/guard.mjs"],
    depsOf: (f) => graph[f] || [],
  });
  assert.deepEqual(r.frozenOnly, ["src/core/only-frozen.mjs"]);
  assert.deepEqual(r.orphan, [], "只从封存层可达不许算 orphan（否则给不维护的代码补测试）");
  assert.equal(r.active, 0);
});

test("classifyReach：两边都到不了的才是 orphan", () => {
  const r = classifyReach({
    srcFiles: ["src/core/nobody.mjs"],
    testSeeds: ["t/a.test.mjs"],
    frozenSeeds: ["hooks/guard.mjs"],
    depsOf: () => [],
  });
  assert.deepEqual(r.orphan, ["src/core/nobody.mjs"]);
});

test("weightedScore：权重之和必须为 1，否则报错而不是静默算错", () => {
  assert.equal(weightedScore([{ score: 100, weight: 0.5 }, { score: 0, weight: 0.5 }]), 50);
  assert.throws(() => weightedScore([{ score: 100, weight: 0.5 }]), /权重之和/);
});

test("dimensionScore：扣到 70 为止（保底 30，不归零）", () => {
  // 归零会抹掉"这一维烂到什么程度"的信息——dsh-code-check 打 0/100 之后就没人看它了。
  assert.equal(dimensionScore(0, 3), 100);
  assert.equal(dimensionScore(10, 3), 70);
  assert.equal(dimensionScore(28, 3), 30, "28 条 × 3 = 84，应封顶扣 70 剩 30");
  assert.equal(dimensionScore(1000, 3), 30, "再多也不许低于 30");
  assert.equal(cappedScore(10 + 5), 85, "混合罚分（未交代 ×10 + 重复 ×5）走 cappedScore");
});

// ───────────────────────── health CLI：冒烟 ─────────────────────────

test("health：JSON 输出结构稳定，四个维度齐全且可复算", () => {
  const r = spawnSync("node", [join(TOOLS, "health.mjs"), "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(
    j.dimensions.map((d) => d.key),
    ["房规", "结构", "测试", "口径"],
  );
  assert.ok(j.composite >= 30 && j.composite <= 100, `总分应在 30–100 之间，实际 ${j.composite}`);
  // 总分必须能由各维复算出来，否则分数是编的
  assert.equal(j.composite, weightedScore(j.dimensions));
  assert.equal(typeof j.lintByLayer.hooks, "number");
  assert.ok(Array.isArray(j.untested.orphan));
});
