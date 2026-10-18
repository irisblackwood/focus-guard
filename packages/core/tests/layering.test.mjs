import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// 分层断言（2026-10-18 架构审查后固化）
//
// 允许方向（由内向外单向）：
//   core（母版，零宿主知识） ← adapter（把母版接进 DSH） ← seam（宿主缝/组装根）
//   zcode hooks 是独立执行壳，只允许依赖 core。
//
// 禁止：
//   core   → adapter | seam     母版反向依赖
//   adapter→ seam               适配层依赖外层
//   zcode  → adapter | seam     独立壳依赖 DSH 集成层
//
// seam → adapter 是**允许**的：pipeline 是组装根，需要调用资格闸/申辩通道。
// 这条曾经被误判成越界（2026-10-18），所以在此写成断言并注明理由。

const here = dirname(fileURLToPath(import.meta.url));
const CORE = join(here, "..");
const ROOT = join(CORE, "..", "..");

function layerOf(rel) {
  if (rel.startsWith("src/core/")) return "core";
  if (rel.startsWith("src/adapters/")) return "adapter";
  if (rel.startsWith("src/dsh/")) return "seam";
  if (rel.startsWith("src/profiles/")) return "profile";
  if (rel.startsWith("hooks/")) return "zcode";
  if (rel.startsWith("tools/")) return "tool";
  return "other";
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry !== "node_modules") walk(abs, out);
    } else if (/\.(mjs|js)$/.test(entry)) {
      out.push(abs);
    }
  }
  return out;
}

/** 收集静态 import/export from 与动态 import('…') 的相对目标（含 ESM 后缀补全）。 */
function edges() {
  const result = [];
  for (const abs of walk(CORE)) {
    const rel = relative(CORE, abs).replace(/\\/g, "/");
    const src = readFileSync(abs, "utf8");
    const specs = [];
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) specs.push(m[1]);
    for (const m of src.matchAll(/import\(\s*(?:pathToFileURL\()?['"`]?(\.[^'"`)\s]+)/g)) specs.push(m[1]);
    for (const spec of specs) {
      let target = spec;
      if (!/\.(mjs|js|json)$/.test(target)) target += ".mjs";
      const to = relative(CORE, join(dirname(abs), target)).replace(/\\/g, "/");
      result.push({ from: rel, to, fromL: layerOf(rel), toL: layerOf(to) });
    }
  }
  return result;
}

const all = edges();

test("分层：母版层不得依赖 adapter/seam", () => {
  const bad = all.filter((e) => e.fromL === "core" && (e.toL === "adapter" || e.toL === "seam"));
  assert.deepEqual(bad, [], `母版反向依赖：${bad.map((e) => `${e.from} -> ${e.to}`).join("; ")}`);
});

test("分层：适配层不得依赖宿主缝", () => {
  const bad = all.filter((e) => e.fromL === "adapter" && e.toL === "seam");
  assert.deepEqual(bad, [], `适配层依赖外层：${bad.map((e) => `${e.from} -> ${e.to}`).join("; ")}`);
});

test("分层：ZCode 钩子壳不得依赖 DSH 集成层", () => {
  const bad = all.filter((e) => e.fromL === "zcode" && (e.toL === "adapter" || e.toL === "seam"));
  assert.deepEqual(bad, [], `钩子壳越层：${bad.map((e) => `${e.from} -> ${e.to}`).join("; ")}`);
});

test("分层：组装根允许依赖适配层（seam → adapter 合法）", () => {
  // 这条不是"必须存在"，而是防止有人把合法方向也当越界去"修"坏。
  const allowed = all.filter((e) => e.fromL === "seam" && e.toL === "adapter");
  assert.ok(allowed.length >= 1, "pipeline 应仍通过适配层调用资格闸（若已重构，请同步更新本断言）");
});

test("分层：分层断言自身覆盖到核心文件（防空目录误判）", () => {
  assert.ok(all.length > 30, `只采集到 ${all.length} 条依赖边，扫描路径可能不对`);
  assert.ok(all.some((e) => e.fromL === "core" && e.toL === "core"), "母版内部边应存在");
  assert.ok(all.some((e) => e.fromL === "seam" && e.toL === "core"), "宿主缝应依赖母版");
});
