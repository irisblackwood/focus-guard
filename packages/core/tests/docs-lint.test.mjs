import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// 3.3 D5/D2：docs:lint 的四类判据必须**真的能红**。活仓库零问题不等于检查有效。
const {
  listMarkdownFiles,
  checkRelativeLinks,
  checkVersionFace,
  checkStatusHeaders,
  checkIndexCoverage,
} = await import("../tools/lib/docs-core.mjs");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fg-docs-"));
  const put = (rel, text) => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
  };
  return { root, put };
}

test("相对链接：存在则通过，缺失则报 dead-link（带行号）", () => {
  const { root, put } = fixture();
  put("docs/a.md", "# A\n\n[ok](./b.md)\n[bad](./missing.md)\n[http](https://example.com)\n[anchor](#x)\n");
  put("docs/b.md", "# B\n");
  const findings = checkRelativeLinks(root);
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].rule, "dead-link");
  assert.match(findings[0].file, /docs\/a\.md$/);
  assert.equal(findings[0].line, 4);
  rmSync(root, { recursive: true, force: true });
});

test("相对链接：跨目录 ../ 与带锚点的链接都按目标文件判", () => {
  const { root, put } = fixture();
  put("docs/sub/a.md", "[up](../b.md#sec)\n[gone](../nope.md)\n");
  put("docs/b.md", "# B\n");
  const findings = checkRelativeLinks(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /nope\.md/);
  rmSync(root, { recursive: true, force: true });
});

test("版本面：七处清单 + ENGINE_VERSION + CHANGELOG 最新段必须一致", () => {
  const { root, put } = fixture();
  const one = JSON.stringify({ version: "1.2.3" });
  for (const rel of [
    "package.json",
    ".zcode-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    "packages/core/package.json",
    "packages/extended/package.json",
  ])
    put(rel, one);
  // 两个 marketplace 是 plugins[0].version 形状，必须也被认到（否则静默 undefined）
  put("marketplace.json", JSON.stringify({ plugins: [{ version: "1.2.3" }] }));
  put(".claude-plugin/marketplace.json", JSON.stringify({ plugins: [{ version: "1.2.3" }] }));
  put("packages/core/src/core/constants.mjs", 'export const ENGINE_VERSION = "1.2.3";\n');
  put("CHANGELOG.md", "# 变更记录\n\n## 1.2.3 · 2026-01-01\n\n- 条目\n");
  assert.deepEqual(checkVersionFace(root), []);

  put("packages/core/package.json", JSON.stringify({ version: "1.2.2" }));
  const bad = checkVersionFace(root);
  assert.equal(bad.length, 1, JSON.stringify(bad));
  assert.equal(bad[0].rule, "version-mismatch");
  assert.match(bad[0].detail, /1\.2\.2/);
  rmSync(root, { recursive: true, force: true });
});

test("扫描范围：运行产物与归档目录不进清单", () => {
  const { root, put } = fixture();
  put("README.md", "# R\n");
  put(".ai/CASE_FILE.md", "# 卷宗\n");
  put("node_modules/x/README.md", "# X\n");
  put("self-improvement/memory/facts.md", "# F\n");
  const files = listMarkdownFiles(root).map((f) => f.replace(/\\/g, "/"));
  assert.equal(files.length, 1, files.join(","));
  assert.match(files[0], /README\.md$/);
  rmSync(root, { recursive: true, force: true });
});

test("状态头：权威文档缺 `> **状态**：权威 …` 必须报", () => {
  const { root, put } = fixture();
  put("a.md", "# A\n\n正文\n");
  put("b.md", "# B\n\n> **状态**：权威 · 适用版本 3.2.1 · 最后核对 2026-10-28\n");
  const bad = checkStatusHeaders(root, ["a.md", "b.md"]);
  assert.equal(bad.length, 1, JSON.stringify(bad));
  assert.equal(bad[0].rule, "missing-status-header");
  assert.match(bad[0].file, /a\.md$/);
  rmSync(root, { recursive: true, force: true });
});

test("INDEX 覆盖：权威文档没被 docs/INDEX.md 链接到必须报", () => {
  const { root, put } = fixture();
  put("docs/INDEX.md", "# 索引\n\n[覆盖的](../a.md)\n");
  put("a.md", "# A\n");
  put("b.md", "# B\n");
  const bad = checkIndexCoverage(root, ["a.md", "b.md"]);
  assert.equal(bad.length, 1, JSON.stringify(bad));
  assert.equal(bad[0].rule, "index-missing");
  assert.match(bad[0].file, /b\.md$/);
  // 索引文件本身缺失时也要报，不能静默通过
  const { root: r2 } = fixture();
  assert.equal(checkIndexCoverage(r2, []).length, 1);
  rmSync(root, { recursive: true, force: true });
  rmSync(r2, { recursive: true, force: true });
});
