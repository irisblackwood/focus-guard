/**
 * CHANGELOG 排版口径的机械校验。
 *
 * 起因：人类两次批示「讲一点格式啊，排版一点没有」「你这乱的，都要丢给模型才能读明白」。
 * 定义与判据见 `docs/WRITING-STYLE.md`。这里只做一件事：**让不合规的红**。
 *
 * 两个设计取舍：
 *
 * 1. **只对最新版本段严格**。历史段（3.1.0 及更早）已有 100+ 条超长条目，
 *    重排历史段的收益是零（读者很少回看），风险是改错信息。存量用棘轮兜住，
 *    只许降不许升——一次性清到零不现实，而永远红的闸门等于没有闸门。
 *
 * 2. **有标签的子项放宽到 150 字**。第一版按「子项 ≤ 80」写，实测 117 条子项里
 *    60 条超限，而它们大多带 `**原因**：` 这类标签，读者靠标签跳读，不需要短。
 *    真正难读的是**没有结构标记的一坨**——所以判据改成看形式，不看条数。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CHANGELOG = fileURLToPath(new URL("../../../CHANGELOG.md", import.meta.url));

/** 排版阈值（`docs/WRITING-STYLE.md` 第四节） */
const LIMITS = {
  item: 120, // 条目正文
  subTagged: 150, // 有 `**标签**` 或 ①-⑨ 编号的子项
  subBare: 80, // 裸写子项
  depth: 2, // 列表嵌套层数
};

/**
 * 全文件存量棘轮：当前最长条目 753 字（3.0.6 段）。
 * **只许降不许升**——降下来就改这个数字，别让它涨回去。
 */
const RATCHET = { longestItem: 753 };

/** 结构标记：粗体标签或圈号 */
const MARK = /^(\*\*[^*]+\*\*|[①②③④⑤⑥⑦⑧⑨])/;

/**
 * 按 `## x.y.z` 切段。返回顺序与文件一致（最新在前）。
 * @returns {{version: string, date: string, lines: string[]}[]}
 */
export function splitVersions(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^## (\d+\.\d+\.\d+) · (\d{4}-\d{2}-\d{2})/);
    if (m) {
      cur = { version: m[1], date: m[2], lines: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^## /.test(line)) {
      cur = null; // 撞到别的二级标题（如「未发布」区），当前段结束
      continue;
    }
    cur.lines.push(line);
  }
  return out;
}

/**
 * 审一段。只审列表项，不审引用块与表格——那是说明区，不是条目区。
 * @returns {{kind: string, detail: string}[]}
 */
export function auditSection(lines, version, date) {
  const findings = [];
  for (const line of lines) {
    const indent = line.match(/^( *)- /);
    if (!indent) continue;
    const level = indent[1].length / 2 + 1; // `- ` = 1 层，`  - ` = 2 层
    const body = line.slice(indent[0].length);

    if (level > LIMITS.depth) {
      findings.push({
        kind: "too-deep",
        detail: `${version}：嵌套 ${level} 层（上限 ${LIMITS.depth}）→ ${body.slice(0, 40)}`,
      });
      continue;
    }
    if (level === 1) {
      if (line.length > LIMITS.item)
        findings.push({
          kind: "item-too-long",
          detail: `${version}：条目 ${line.length} 字（上限 ${LIMITS.item}）→ ${body.slice(0, 40)}`,
        });
      // 段标题已含日期，条目内再写一遍是纯噪音。
      // 判据只认「（日期」这种标注形态——文件名 `HANDOFF-2026-10-27.md` 里的日期是路径，不是标注。
      if (date && line.includes(`（${date}`))
        findings.push({
          kind: "date-repeat",
          detail: `${version}：条目重复了段标题里的日期 ${date} → ${body.slice(0, 40)}`,
        });
      continue;
    }
    const cap = MARK.test(body) ? LIMITS.subTagged : LIMITS.subBare;
    if (line.length > cap)
      findings.push({
        kind: MARK.test(body) ? "sub-tagged-too-long" : "sub-bare-too-long",
        detail: `${version}：子项 ${line.length} 字（上限 ${cap}）→ ${body.slice(0, 40)}`,
      });
  }
  return findings;
}

/** 全文件只查棘轮（历史段不重排，但不能变差） */
export function auditRatchet(text) {
  const findings = [];
  for (const sec of splitVersions(text)) {
    for (const line of sec.lines) {
      if (!/^- /.test(line)) continue;
      if (line.length > RATCHET.longestItem)
        findings.push({
          kind: "ratchet-exceeded",
          detail: `${sec.version}：条目 ${line.length} 字，超过存量上限 ${RATCHET.longestItem} → ${line.slice(0, 40)}`,
        });
    }
  }
  return findings;
}

const SRC = readFileSync(CHANGELOG, "utf8");
const SECTIONS = splitVersions(SRC);
const LATEST = SECTIONS[0];

describe("CHANGELOG 排版", () => {
  // 没有这条，下面的「零违规」可以靠解析失败通过——本仓栽过「锚点缺失静默返回空」
  test("结构锚点：解析必须真看见版本段与条目", () => {
    assert.ok(SECTIONS.length >= 5, `只解析到 ${SECTIONS.length} 个版本段，解析规则可能失配`);
    assert.equal(LATEST.version, "3.2.0", `最新段应为 3.2.0，实际 ${LATEST.version}`);
    const items = LATEST.lines.filter((l) => /^- /.test(l));
    assert.ok(items.length >= 15, `最新段只解析到 ${items.length} 个条目，解析规则可能失配`);
    const subs = LATEST.lines.filter((l) => /^ {2}- /.test(l));
    assert.ok(subs.length >= 40, `最新段只解析到 ${subs.length} 个子项——重排后本该有上百条`);
  });

  test("最新版本段：条目、子项、嵌套全部合规", () => {
    const findings = auditSection(LATEST.lines, LATEST.version, LATEST.date);
    assert.deepEqual(
      findings,
      [],
      `排版违规 ${findings.length} 处：\n${findings.map((f) => "  - " + f.detail).join("\n")}`,
    );
  });

  test("全文件棘轮：条目长度不得超过存量上限（只许降不许升）", () => {
    const findings = auditRatchet(SRC);
    assert.deepEqual(findings, [], findings.map((f) => f.detail).join("\n"));
  });

  test("夹具：超长条目必须报", () => {
    const f = auditSection([`- ${"x".repeat(200)}`], "9.9.9", "2026-01-01");
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, "item-too-long");
  });

  test("夹具：裸写子项超 80 报，带标签的到 150 才报", () => {
    const bare = auditSection(["- 条目", `  - ${"x".repeat(100)}`], "9.9.9", "");
    assert.equal(bare.length, 1, "裸写子项 100 字该报");
    assert.equal(bare[0].kind, "sub-bare-too-long");

    const tagged = auditSection(["- 条目", `  - **原因**：${"x".repeat(100)}`], "9.9.9", "");
    assert.equal(tagged.length, 0, "带标签子项 110 字不该报");

    const tooLong = auditSection(["- 条目", `  - **原因**：${"x".repeat(200)}`], "9.9.9", "");
    assert.equal(tooLong[0].kind, "sub-tagged-too-long");
  });

  test("夹具：三层嵌套必须报", () => {
    const f = auditSection(["- 条目", "  - 子项", "    - 孙项"], "9.9.9", "");
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, "too-deep");
  });

  test("夹具：条目重复段标题日期必须报（段标题已含，逐条再写是噪音）", () => {
    const f = auditSection(["- fix(x): 某改动（2026-10-27）"], "9.9.9", "2026-10-27");
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, "date-repeat");
  });

  test("夹具：引用块与表格不算条目（说明区不受条目长度约束）", () => {
    const f = auditSection([`> ${"x".repeat(300)}`, "| 项 | 结果 |", "|---|---|"], "9.9.9", "");
    assert.deepEqual(f, [], "引用块与表格不是列表项，不该被条目阈值判红");
  });
});
