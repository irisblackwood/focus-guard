// 积木索引（2026-10-31）
// 两条被测物：解析认不认得出分级/来源，--check 能不能报漂移。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlock, diffIndex } from "../tools/library-index.mjs";

test("解析：分级结论与「主题-来源」两种写法都要认出来", () => {
  assert.deepEqual(parseBlock("B001-s-级-改改措辞就能进-rules-注入前缀.md", 900), {
    id: "B001",
    file: "B001-s-级-改改措辞就能进-rules-注入前缀.md",
    grade: "s",
    topic: "改改措辞就能进-rules-注入前缀",
    source: null,
    chars: 900,
  });
  const themed = parseBlock("B006-核心机制-anthropic.md", 1200);
  assert.equal(themed.topic, "核心机制");
  assert.equal(themed.source, "anthropic");
  assert.equal(themed.grade, null);
});

test("零漂移判据：少一块、改一个字都必须报", () => {
  const before = { blocks: [{ id: "B001", file: "B001-a.md", chars: 10 }] };
  assert.deepEqual(diffIndex(before, before), { missing: [], extra: [] });
  const edited = { blocks: [{ id: "B001", file: "B001-a.md", chars: 11 }] };
  assert.equal(diffIndex(before, edited).missing.length, 1);
  assert.equal(diffIndex(before, { blocks: [] }).missing.length, 1);
});
