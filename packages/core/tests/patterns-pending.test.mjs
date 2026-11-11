import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendPatternStub, pendingPatternStubs } from "../src/core/patterns.mjs";
import { systemPromptRulesListener } from "../src/dsh/seams/prompt-rules.mjs";

// 经验库「教训」待补（2026-11-08）。
//
// 病根：`appendPatternStub` 在熔断时写下骨架，`- 教训：<待补…>` 那一行**没有任何机制促使回填**。
// 建库 27 天零条是第一层（写不进去）；补上写入之后还有第二层——写进去了也永远空着，
// 因为模型看不见"还欠几笔"。本文件锁两件事：数得出来、数出来就注入。

test("骨架写了就要数得出来；回填后归零", () => {
  const proj = mkdtempSync(join(tmpdir(), "fg-patterns-"));
  appendPatternStub(proj, { sid: "sess_p1", reason: "明示熔断" });
  assert.equal(pendingPatternStubs(proj), 1, "写了骨架就该记 1 笔欠账");

  const pat = join(proj, ".ai", "PATTERNS.md");
  writeFileSync(
    pat,
    readFileSync(pat, "utf8").replace(/- 教训：<待补[^\n]*/, "- 教训：以后遇到 X 必须先做 Y"),
  );
  assert.equal(pendingPatternStubs(proj), 0, "回填后不该再计数");
});

test("有待补才注入提醒；干净时一段都不多", async () => {
  const proj = mkdtempSync(join(tmpdir(), "fg-patterns-inject-"));
  const agent = { session: { header: { id: "sess_p2", cwd: proj } } };
  const run = () =>
    systemPromptRulesListener({})({}, { agent }, async () => ({ sections: [] }));

  let out = await run();
  assert.equal(
    out.sections.some((s) => s.name === "focus-guard-patterns"),
    false,
    "干净时不该多注入一段——这是每回合都付的成本",
  );

  appendPatternStub(proj, { sid: "sess_p2", reason: "明示熔断" });
  out = await run();
  const sec = out.sections.find((s) => s.name === "focus-guard-patterns");
  assert.ok(sec, "有待补时必须提醒，否则模型永远不知道欠着");
  assert.match(sec.text, /1 条「教训」未回填/);
});
