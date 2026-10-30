import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 卷宗人工维护（2026-10-30）
//
// 背景：真实卷宗 10 条里 4 条是口语碎片（「哦！遵循它」「我是说新功能」），
// 而淘汰是 slice(-10)——说十句闲话就能把「本科→普通级→高级」这种长期目标挤掉。
// 本文件锁三件事：
//   ① 标签语义：done/note 不注入、goal 剥前缀注入
//   ② 淘汰保护：上限淘汰时 goal 不被挤掉
//   ③ 超预算：丢整条，绝不切半句

const ws = await import("../src/dsh/workspace.mjs");
const { parseTag, stripTag, isHiddenTag, CASE_TAGS } = ws;
const { scoreEntry, withTag, entriesOf, resolveEntry, dropEntry, tagEntry, loadCase } = await import(
  "../tools/lib/case-tool.mjs"
);

const rec = (patch = {}) => ({
  schema: 1,
  workspace_hash: "h".repeat(16),
  workspace_path: "E:/x",
  updated_at: "2026-10-30T00:00:00.000Z",
  decisions: [],
  constraints: [],
  next_action: [],
  snapshot: null,
  ...patch,
});

test("标签解析：大小写不敏感，无标签返回 null", () => {
  assert.equal(parseTag("[goal] 甲"), "goal");
  assert.equal(parseTag("[GOAL] 甲"), "goal");
  assert.equal(parseTag("[done]甲"), "done");
  assert.equal(parseTag("甲"), null);
  assert.equal(parseTag("[unknown] 甲"), null, "未知标签不算标签，整条原样保留");
});

test("标签剥离：只去掉前缀，正文一字不动", () => {
  assert.equal(stripTag("[goal] 甲 乙"), "甲 乙");
  assert.equal(stripTag("甲 [goal] 乙"), "甲 [goal] 乙", "不在开头的不剥");
  assert.equal(stripTag("甲"), "甲");
});

test("隐藏语义：只有 done / note 不注入，goal 照常注入", () => {
  assert.equal(isHiddenTag("[done] x"), true);
  assert.equal(isHiddenTag("[note] x"), true);
  assert.equal(isHiddenTag("[goal] x"), false);
  assert.equal(isHiddenTag("x"), false);
});

test("注入：done 与 note 不出现，goal 剥掉标记后出现", () => {
  const text = ws.renderWorkspaceSection(
    rec({
      decisions: ["[goal] 本科→普通级→高级", "[done] 哦！遵循它", "[note] 临时记一笔", "普通决策"],
    }),
  );
  assert.match(text, /本科→普通级→高级/, "goal 必须注入");
  assert.doesNotMatch(text, /\[goal\]/, "标记不该进系统提示");
  assert.doesNotMatch(text, /哦！遵循它/, "done 不注入");
  assert.doesNotMatch(text, /临时记一笔/, "note 不注入");
  assert.match(text, /普通决策/);
});

test("上限淘汰：11 条时先丢最老的非 goal，goal 不被挤掉", () => {
  // 第 1 条是 goal，后面 10 条普通 —— 若按 slice(-10)，goal 会被挤掉
  const decisions = ["[goal] 长期目标", ...Array.from({ length: 10 }, (_, i) => `第 ${i} 条`)];
  // 走真实写入路径：mergeWorkspace 会校验 hash，所以 hash 必须与 cwd 一致，否则它当新文件重建。
  const TMP = mkdtempSync(join(tmpdir(), "fg-case-clean-"));
  const file = join(TMP, "ws.json");
  const cwd = "E:/x";
  const hash = ws.workspaceHash(cwd);
  const saved = process.env.FG_WORKSPACE_FILE;
  process.env.FG_WORKSPACE_FILE = file;
  try {
    writeFileSync(file, JSON.stringify(rec({ workspace_hash: hash, decisions }), null, 2));
    const next = ws.mergeWorkspace(cwd, { decisions: ["新来的一条"] });
    assert.ok(next.decisions.includes("[goal] 长期目标"), "长期目标不该被闲话挤掉");
    assert.equal(next.decisions.length, 10, "上限仍是 10 条");
    assert.ok(!next.decisions.includes("第 0 条"), "最老的非 goal 先出局");
  } finally {
    if (saved === undefined) delete process.env.FG_WORKSPACE_FILE;
    else process.env.FG_WORKSPACE_FILE = saved;
  }
});

test("超预算：不裁剪，全部保留（半句比不写危害大）", () => {
  // 8 条 × 190 字 ≈ 1520 字，超过旧阈值 1200
  const long = (i) => `第${i}条${"补".repeat(185)}`;
  const items = Array.from({ length: 8 }, (_, i) => long(i));
  const text = ws.renderWorkspaceSection(rec({ decisions: items }));
  // 2026-10-30 人类批示：超预算允许留着——不切半句，也不丢整条。
  assert.ok(text.length > 1200, `应允许超过旧阈值 1200，实际 ${text.length}`);
  for (const t of items) assert.ok(text.includes(t), "每条都必须完整出现，不许丢整条");
  const open = (text.match(/「/g) || []).length;
  const close = (text.match(/」/g) || []).length;
  assert.equal(open, close, "引号必须成对——出现未闭合说明切了半句");
});

test("打分：碎片低分、有内容的条目高分，且不误杀长句开头的语气词", () => {
  const frag = scoreEntry("哦！遵循它");
  const solid = scoreEntry("该给 fg 加一条规则，优先按性价比环比，不高则反驳");
  assert.ok(frag.score < 0, `碎片应负分，实际 ${frag.score}`);
  assert.ok(solid.score >= 5, `有内容的应高分，实际 ${solid.score}`);
  // 2026-10-30 修正：初版把「其实我不想只止于本科论文级…」扣成 0 分（以"其实"开头）。
  const goalish = scoreEntry("其实我不想只止于本科论文级我想去够到普通级甚至高级");
  assert.ok(goalish.score >= 0, `长句以语气词开头不该被扣成负分，实际 ${goalish.score}`);
});

test("定位：纯数字走全局序号，field:index 走指定字段", () => {
  const r = rec({ decisions: ["甲", "乙"], constraints: ["丙"] });
  const all = entriesOf(r);
  assert.deepEqual(
    all.map((e) => `${e.field}:${e.index}`),
    ["decisions:0", "decisions:1", "constraints:0"],
  );
  assert.equal(resolveEntry(r, "2").text, "乙", "全局第 2 条");
  assert.equal(resolveEntry(r, "3").text, "丙", "全局第 3 条跨到 constraints");
  assert.equal(resolveEntry(r, "constraints:1").text, "丙");
  assert.equal(resolveEntry(r, "9"), null, "越界返回 null");
  assert.equal(resolveEntry(r, "abc"), null);
});

test("drop：真删、整份备份、序号不复用", () => {
  const TMP = mkdtempSync(join(tmpdir(), "fg-case-drop-"));
  const file = join(TMP, "ws.json");
  const r = rec({ decisions: ["甲", "乙", "丙"] });
  writeFileSync(file, JSON.stringify(r, null, 2));
  const out = dropEntry(r, "2", file);
  assert.equal(out.ok, true);
  assert.equal(out.removed, "乙");
  assert.ok(existsSync(out.backup), "必须先备份再删");
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(after.decisions, ["甲", "丙"]);
  const backup = JSON.parse(readFileSync(out.backup, "utf8"));
  assert.deepEqual(backup.decisions, ["甲", "乙", "丙"], "备份是删除前的原文");
});

test("tag：加标签、换标签、清除；未知标签拒绝", () => {
  const TMP = mkdtempSync(join(tmpdir(), "fg-case-tag-"));
  const file = join(TMP, "ws.json");
  const r = rec({ decisions: ["甲"] });
  writeFileSync(file, JSON.stringify(r, null, 2));

  assert.equal(tagEntry(r, "1", "goal", file).after, "[goal] 甲");
  assert.equal(tagEntry(r, "1", "done", file).after, "[done] 甲", "换标签不叠加");
  assert.equal(tagEntry(r, "1", null, file).after, "甲", "传 null 清除");
  const bad = tagEntry(r, "1", "important", file);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /未知标签/);
});

test("withTag：重复加同一标签不会套娃", () => {
  assert.equal(withTag(withTag("甲", "goal"), "goal"), "[goal] 甲");
  assert.deepEqual([...CASE_TAGS], ["goal", "done", "note"]);
});

test("loadCase：文件不存在返回 record=null，损坏返回 error", () => {
  const TMP = mkdtempSync(join(tmpdir(), "fg-case-load-"));
  assert.equal(loadCase(join(TMP, "nope.json")).record, null);
  const bad = join(TMP, "bad.json");
  writeFileSync(bad, "{ 不是 json");
  assert.ok(loadCase(bad).error, "损坏要报 error，不能静默当空");
});
