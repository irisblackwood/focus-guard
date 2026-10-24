import { test } from "node:test";
import assert from "node:assert/strict";

// 策略可达性自检（2026-10-24）
// 把 2026-10-22 的人工排查固化成自检：判定里引用的参数键，若真实 schema 里不存在，
// 该规则永不触发（grep 的 output_mode、read 的 pages 就是实例）。
// 本组锁：① 抽键正确 ② 差集正确 ③ 忽略项生效 ④ 只报不改。

const pa = await import("../src/dsh/policy-audit.mjs");

test("从源码抽参数键：只认代码行，注释不算", () => {
  const src = [
    "const a = args.command",        // 1
    "// args.ignoredInComment",      // 2 注释
    "if (args.output_mode === 'x') {}",
    "const p = ti.file_path",
    "arguments.pattern",
  ].join("\n");
  const keys = pa.referencedKeysOf(src, "x.mjs");
  assert.deepEqual([...keys.keys()].sort(), ["command", "file_path", "output_mode", "pattern"]);
});

test("schema 键并集：取全部工具的 parameters.properties", () => {
  const keys = pa.schemaKeysOf([
    { name: "read", parameters: { properties: { file_path: {}, offset: {} } } },
    { name: "grep", parameters: { properties: { pattern: {}, path: {}, include: {} } } },
  ]);
  assert.deepEqual([...keys].sort(), ["file_path", "include", "offset", "path", "pattern"]);
});

test("差集：引用了但 schema 没有 → ghost（不可达）", () => {
  const r = pa.auditReachability({
    files: [{ label: "a.mjs", text: "args.file_path; args.output_mode; args.head_limit" }],
    schemaKeys: new Set(["file_path", "offset"]),
  });
  assert.deepEqual(r.ghost.map((g) => g.key), ["head_limit", "output_mode"]);
  assert.deepEqual(r.reachable, ["file_path"]);
});

test("ignore 生效（已知无害回退键不算不可达）", () => {
  const r = pa.auditReachability({
    files: [{ label: "a.mjs", text: "args.cmd; args.file_path" }],
    schemaKeys: new Set(["file_path"]),
    ignore: ["cmd"],
  });
  assert.equal(r.ghost.length, 0);
});

test("真实源码自检：当前代码里不应有新的不可达键（历史迁移项已忽略）", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const files = ["pipeline.mjs", "preGuard.mjs"].map((f) => ({
    label: f,
    text: readFileSync(join(here, "..", "src", "dsh", f), "utf8"),
  }));
  // 用真实 DSH 工具 schema 的键并集（覆盖 pipeline/preGuard 会碰到的参数）
  const schemaKeys = new Set([
    "command", "file_path", "path", "pattern", "include", "offset", "limit", "content",
    "old_string", "new_string", "target", "targetPath", "dest", "args", "description",
    "purpose", "scope", "ttl", "tool", "reason", "counterExample", "prompt", "network",
  ]);
  const r = pa.auditReachability({ files, schemaKeys, ignore: ["cmd", "script", "pages", "head_limit", "output_mode"] });
  assert.deepEqual(r.ghost, [], `发现不可达参数键：${r.ghost.map((g) => g.key).join(",")}`);
});
