/**
 * 变异引擎的测试（2026-10-27）。
 *
 * 与 `toolchain-tools.test.mjs` 同一个理由：这是我用来**量闸门强度**的尺子，
 * 尺子自己必须先被量。这里重点测三件容易错的事：
 *   ① 变异位置映射：`stripLiterals` 抹掉字面量后下标必须还能对回原文件
 *   ② 字面量里的运算符不许被变异（否则"存活"全是假的）
 *   ③ 算子边界：`!==` 不许被 `negation` 吃掉，`>=` 不许被 `comparison` 拆坏
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { generateMutants, applyMutant } from "../tools/mutate.mjs";
import { buildImportGraph, resolveSpec } from "../tools/lib/import-graph.mjs";

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), "../tools");

const opsOf = (src) => generateMutants(src).map((m) => `${m.op}:${m.token}->${m.replacement}@${m.line}`);

test("generateMutants：字符串与注释里的运算符不许变异", () => {
  // 这条是变异测试最容易假绿的地方：`'== 分布 =='` 被当成代码变异，
  // 跑出来"存活"其实是字符串根本没执行到。
  const src = [
    `const a = 'a == b && c'`, // 字符串：不许变异
    `// if (x > 0 && y < 1)`, // 注释：不许变异
    `const b = x && y`, // ← 只有这条该变异
    ``,
  ].join("\n");
  const ops = opsOf(src);
  assert.equal(ops.length, 1, `只应有 1 个变异体，实际 ${JSON.stringify(ops)}`);
  assert.match(ops[0], /^boolean:&&->\|\|@3$/);
});

test("generateMutants：=== / !== / >= / <= 不许被拆坏", () => {
  const src = `if (a === b) {}\nif (a !== b) {}\nif (a >= b) {}\nif (a <= b) {}\n`;
  const ops = opsOf(src);
  assert.deepEqual(ops, [
    "equality:===->!==@1",
    "equality:!==->===@2",
    "comparison:>=->>@3",
    "comparison:<=-><@4",
  ]);
});

test("generateMutants：negation 不许吃掉 !== 里的 !", () => {
  const src = `if (!a) {}\nif (a !== b) {}\nif (a != b) {}\n`;
  const ops = opsOf(src);
  assert.deepEqual(ops, ["negation:!->@1", "equality:!==->===@2"], `实际 ${JSON.stringify(ops)}`);
  // `!=` 不在 equality 算子范围内（宽松相等属于房规问题，不在这里变异）
});

test("generateMutants：行号与下标都能对回原文", () => {
  const src = `const a = 1\nconst b = x && y\nconst c = 2\n`;
  const [m] = generateMutants(src);
  assert.equal(m.line, 2);
  assert.equal(src.slice(m.index, m.index + m.token.length), "&&", "下标必须指向原文件里的真实 token");
});

test("applyMutant：只替换目标 token，其余字节不变", () => {
  const src = `const b = x && y\n`;
  const [m] = generateMutants(src);
  const mutated = applyMutant(src, m);
  assert.equal(mutated, `const b = x || y\n`);
  assert.equal(mutated.length, src.length, "同长度替换，行号不会漂");
});

test("applyMutant：删掉 `!` 时长度减一，且只影响那一处", () => {
  const src = `if (!ready) return\nif (other) return\n`;
  const [m] = generateMutants(src);
  assert.equal(applyMutant(src, m), `if (ready) return\nif (other) return\n`);
});

test("generateMutants：模板字符串里的运算符不许变异", () => {
  const src = "const s = `x ${a && b} y`\nconst t = a && b\n";
  const ops = opsOf(src);
  assert.equal(ops.length, 1, `模板字符串内的 && 不许变异，实际 ${JSON.stringify(ops)}`);
  assert.match(ops[0], /@2$/);
});

test("mutate CLI：--list 不复制不跑测试，只报计划", () => {
  const r = spawnSync("node", [join(TOOLS, "mutate.mjs"), "dsh/toolName.mjs", "--list"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /个变异体/);
  assert.match(r.stdout, /触达测试 \d+ 个/);
});

test("mutate CLI：无参数时给出用法并 exit 2（不是静默成功）", () => {
  const r = spawnSync("node", [join(TOOLS, "mutate.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /用法/);
});

test("mutate CLI 端到端：有断言则杀死，无断言则存活（受控夹具）", () => {
  // 这是整个工具的核心承诺，必须被锁住。**用夹具而不是真实仓库**：
  // 真实测试有偶发失败（`preGuard.test.mjs` 已知），跑在上面得分时高时低，
  // 断言就变成在测上游的稳定性，不是在测这个工具。
  const dir = mkdtempSync(join(tmpdir(), "fg-mutate-e2e-"));
  const w = (rel, content) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  // `both` 被断言 → 两个 && 变异体都该被杀；`unused` 没人调 → 变异体存活。
  w(
    "packages/core/src/core/guard.mjs",
    `export const both = (a, b) => a && b\nexport const unused = (a, b) => a && b\n`,
  );
  w(
    "packages/core/tests/guard.test.mjs",
    `import { test } from "node:test"\nimport assert from "node:assert/strict"\nimport { both } from "../src/core/guard.mjs"\ntest("both", () => { assert.equal(both(1, 2), 2); assert.equal(both(0, 2), 0) })\n`,
  );
  try {
    const r = spawnSync("node", [join(TOOLS, "mutate.mjs"), "core/guard.mjs", "--json"], {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, FG_REPO_ROOT: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    const m = j.results[0];
    assert.equal(m.generated, 2, "两个 && 应各生成一个变异体");
    assert.equal(m.tests, 1, "应选中夹具里那一个测试文件");
    assert.equal(m.survivors.length, 1, `只该有 unused 那一个存活，实际 ${JSON.stringify(m.survivors)}`);
    assert.equal(m.survivors[0].line, 2, "存活的是第 2 行的 unused");
    assert.equal(m.score, 50, "1 杀 1 活 = 50%");
    assert.equal(m.unreliable, undefined, "夹具测试是确定的，不该报不可信");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildImportGraph：三种引用形态都要认（含 new URL 拼路径）", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-graph-"));
  const w = (rel, content) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  w("packages/core/src/core/a.mjs", `export const a = 1\n`);
  w("packages/core/src/core/b.mjs", `export const b = 1\n`);
  w("packages/core/src/core/c.mjs", `export const c = 1\n`);
  w(
    "packages/core/tests/x.test.mjs",
    [
      `import { a } from "../src/core/a.mjs"`,
      `const b = await import("../src/core/b.mjs")`,
      `const C = fileURLToPath(new URL("../src/core/c.mjs", import.meta.url))`,
      ``,
    ].join("\n"),
  );
  try {
    const g = buildImportGraph(dir);
    const reached = g.reachFrom(g.testFiles);
    const names = [...reached].map((f) => f.split(/[\\/]/).pop()).sort();
    assert.deepEqual(names, ["a.mjs", "b.mjs", "c.mjs"], "三种形态都必须进图");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSpec：非相对说明符返回 null（包名不许当文件路径）", () => {
  assert.equal(resolveSpec("/x/y.mjs", "node:fs"), null);
  assert.equal(resolveSpec("/x/y.mjs", "lodash"), null);
});

test("mutate CLI 冒烟：真实仓库上跑 toolName，两种结果都必须如实报", () => {
  // 选 toolName 是因为它只有 2 个变异体，跑完约 1 秒，适合放进常规测试。
  //
  // **这里刻意不断言具体得分，也不断言 ⚠ 不出现。** 两个理由：
  //   ① 第一版断言 `变异得分 100%`，抓到的其实是假象——首跑 2/2 全杀、复跑 0/2 全存活，
  //      前一次的"杀死"来自某次测试的残留状态偶发失败。**断言数字前先确认它可复现。**
  //   ② 上游 `preGuard.test.mjs` 有未修的偶发失败，会让基线时红时绿。
  //      断言"永远干净"等于把上游缺陷变成这里的抖动。
  // 正确行为是**两种结果都如实报**：给分数，或跳过并写明原因。所以只断言结构。
  const r = spawnSync("node", [join(TOOLS, "mutate.mjs"), "dsh/toolName.mjs"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /触达测试 [1-9]\d* 个/, "必须真的选到了测试文件，不能是 0 个");
  assert.match(r.stdout, /变异得分 \d+(\.\d+)?%|跳过：/, "要么给分数，要么写明为什么跳过");
});
