// 知识库统一索引（2026-10-31，M2）
// 核心判据只有一条：源文件与积木的编号撞车时，ns:id 必须仍是唯一的。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { entryOf, diffKnowledge } from "../tools/knowledge.mjs";

function withDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "fg-knowledge-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

test("同一个 B001 在 src 与 block 两个命名空间下互不覆盖", () => {
  const dir = withDir({
    "B001-主题-1-防幻觉-详见前一轮分析.md": "x".repeat(100),
    "B001-s-级-改改措辞就能进-rules.md": "y".repeat(200),
  });
  try {
    const src = entryOf("src", dir, "B001-主题-1-防幻觉-详见前一轮分析.md");
    const block = entryOf("block", dir, "B001-s-级-改改措辞就能进-rules.md");
    assert.equal(`${src.ns}:${src.id}`, "src:B001");
    assert.equal(`${block.ns}:${block.id}`, "block:B001");
    assert.equal(src.topic, "主题-1-防幻觉-详见前一轮分析");
    assert.equal(block.grade, "s");
    assert.notEqual(`${src.ns}:${src.id}`, `${block.ns}:${block.id}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notes 的子目录文件用相对路径当 id，不跟顶层同名文件撞", () => {
  const dir = withDir({ "prompts-mining/r1-mining.md": "z".repeat(10) });
  try {
    const e = entryOf("note", dir, "prompts-mining/r1-mining.md");
    assert.equal(e.id, "prompts-mining/r1-mining");
    assert.equal(e.ns, "note");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("零漂移判据：改一个字、少一条都必须报", () => {
  const before = { entries: [{ ns: "src", id: "B001", path: "/a.md", chars: 10 }] };
  assert.deepEqual(diffKnowledge(before, before), { missing: [], extra: [] });
  const edited = { entries: [{ ns: "src", id: "B001", path: "/a.md", chars: 11 }] };
  assert.equal(diffKnowledge(before, edited).missing.length, 1);
  assert.equal(diffKnowledge(before, { entries: [] }).missing.length, 1);
});
