/**
 * CHANGELOG 受众口径校验（2026-10-27 人类批示；定义见 `docs/RELEASE-POLICY.md` 第一节）
 *
 * 规则：对外文档的「修复」默认指「修复用户可能已经遇到的问题」。
 * 所以「影响面：开发期」的版本段（整段未对外分发）正文不得出现「修复」二字——
 * 否则等于向读者宣称一个不存在的影响面：读者会去核对一个自己不可能踩到的坑。
 *
 * 机械判据只有一个常量 `PUBLISHED_MAX`：
 *   `npm view focus-guard versions` → 3.0.6 / 3.0.7
 *   **发布新版本时改这一行**，各段的声明与措辞约束自动跟着换。
 *
 * 引号约定：写 `「修复」`（加引号）= 在**谈论这个词**，不算违规；
 * 不加引号的「修复」= 在**宣称修了东西**，开发期段里出现即违规。
 *
 * 为什么做成测试而不是只写在文档里：文档里的约定不会报错。
 * 为什么带夹具：活文档零违规不等于检查有效——夹具证明它真的能红。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 对外已发布的最高版本（npm 上的最后一个版本号） */
const PUBLISHED_MAX = "3.0.7";

const CHANGELOG = fileURLToPath(new URL("../../../CHANGELOG.md", import.meta.url));

function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** 按 `## x.y.z` 切段；首个版本标题之前的内容（顶部口径声明）不属任何段 */
function splitSections(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^## (\d+\.\d+\.\d+)/);
    if (m) {
      cur = { version: m[1], body: [] };
      out.push(cur);
      continue;
    }
    if (cur) cur.body.push(line);
  }
  return out;
}

const DEV_MARK = /^>\s*\*\*影响面：开发期/;

/** 剥掉「…」引号内的内容：加引号 = 在谈论这个词，不加 = 在宣称修了东西 */
const stripQuoted = (line) => line.replace(/「[^」]*」/g, "");

/**
 * 返回违规清单（空数组 = 合规）。
 * 只查 `- ` 条目行：引用块里的口径说明本身就含「修复」二字，查进去会自伤。
 */
function auditChangelog(text, publishedMax = PUBLISHED_MAX) {
  const findings = [];
  for (const s of splitSections(text)) {
    const declaredDev = s.body.some((l) => DEV_MARK.test(l));
    const released = cmpVersion(s.version, publishedMax) <= 0;
    if (!released && !declaredDev)
      findings.push({
        version: s.version,
        kind: "missing-dev-mark",
        detail: "未对外分发的版本段必须声明「影响面：开发期」",
      });
    if (released && declaredDev)
      findings.push({
        version: s.version,
        kind: "false-dev-mark",
        detail: "该版本已对外分发，不得声明「影响面：开发期」",
      });
    if (!declaredDev) continue;
    const bad = s.body.filter((l) => /^- /.test(l) && stripQuoted(l).includes("修复"));
    if (bad.length)
      findings.push({
        version: s.version,
        kind: "fix-word-in-dev",
        detail: `开发期段出现「修复」${bad.length} 处（未加引号 = 在宣称修了东西），改写为「某某改为…／收敛为…／加固…」`,
        samples: bad.map((l) => l.slice(0, 60)),
      });
  }
  return findings;
}

describe("CHANGELOG 受众口径（开发期缺陷不称「修复」）", () => {
  test("活文档零违规", () => {
    const findings = auditChangelog(readFileSync(CHANGELOG, "utf8"));
    assert.deepEqual(
      findings,
      [],
      `CHANGELOG 违反受众口径：\n${JSON.stringify(findings, null, 2)}`,
    );
  });

  test("顶部口径声明不得被删（读者靠它理解 fix 前缀不代表已受影响）", () => {
    const text = readFileSync(CHANGELOG, "utf8");
    assert.match(text, /受众口径/, "CHANGELOG 顶部须保留「受众口径」说明");
    assert.match(text, /docs\/RELEASE-POLICY\.md/, "口径说明须指向定义出处");
  });

  // 没有这条，上面的「零违规」可以靠解析失败来通过——本仓已栽过「锚点缺失静默返回空」的坑
  test("结构锚点：解析必须真的看见各段，且四个开发期段都带声明", () => {
    const sections = splitSections(readFileSync(CHANGELOG, "utf8"));
    assert.ok(sections.length >= 10, `只解析出 ${sections.length} 段，CHANGELOG 解析失败`);
    const versions = sections.map((s) => s.version);
    for (const v of ["3.2.0", "3.1.0", "3.0.10", "3.0.9"])
      assert.ok(versions.includes(v), `漏段 ${v}（解析或标题格式变了）`);
    const dev = sections
      .filter((s) => s.body.some((l) => DEV_MARK.test(l)))
      .map((s) => s.version);
    assert.deepEqual(
      dev.sort(cmpVersion),
      ["3.0.9", "3.0.10", "3.1.0", "3.2.0"],
      "四个未对外分发的版本段必须都声明「影响面：开发期」",
    );
  });

  test("夹具：开发期段写「修复」必须报（证明检查真能红）", () => {
    const text = "## 9.9.9 · 2026-01-01\n\n> **影响面：开发期**\n\n- fix(x): 修复了授权重复登记的问题\n";
    const findings = auditChangelog(text);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "fix-word-in-dev");
    assert.equal(findings[0].version, "9.9.9");
  });

  test("夹具：未发布段缺声明必须报", () => {
    const findings = auditChangelog("## 9.9.9 · 2026-01-01\n\n- feat(x): 新增能力\n");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "missing-dev-mark");
  });

  test("夹具：已发布段标「开发期」必须报", () => {
    const findings = auditChangelog(
      "## 3.0.7 · 2026-01-01\n\n> **影响面：开发期**\n\n- feat(x): 新增\n",
      "3.0.7",
    );
    assert.ok(
      findings.some((f) => f.kind === "false-dev-mark"),
      "已发布版本声明「开发期」会让读者以为不必核对，须报",
    );
  });

  test("夹具：已发布段写「修复」是允许的", () => {
    const findings = auditChangelog(
      "## 3.0.7 · 2026-01-01\n\n- fix(x): 修复了授权重复登记的问题\n",
      "3.0.7",
    );
    assert.deepEqual(findings, [], "已发布的缺陷，对外就该写「修复」");
  });

  test("夹具：引用「修复」二字不算违规（在谈论这个词，不是在宣称修了东西）", () => {
    const text = "## 9.9.9 · 2026-01-01\n\n> **影响面：开发期**\n\n- docs(x): 定义「修复」的判据\n";
    assert.deepEqual(auditChangelog(text), [], "加引号是在谈论这个词，不能算宣称影响面");
  });
});
