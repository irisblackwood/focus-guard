/**
 * CHANGELOG 受众口径校验（2026-10-27 人类批示；定义见 `docs/RELEASE-POLICY.md` 第一节）
 *
 * 规则：对外文档的「修复」默认指「修复用户可能已经遇到的问题」。
 * 所以「开发期」条目（缺陷只在未对外分发的代码里存在过）正文不得出现「修复」二字——
 * 否则等于向读者宣称一个不存在的影响面：读者会去核对一个自己不可能踩到的坑。
 *
 * 两种标注，粒度不同：
 *   - 段级 `> **影响面：开发期**`：整段每一条都属开发期（同质段落用，省得逐条标）
 *   - 条目级 `〔开发期〕`：段内个别条目属开发期（混合段落用）
 * 本仓 3.2.0 属混合段落：熔断/抽查B 修的是 3.1.0（已推 GitHub）里的问题，而工具链四件是当天新造的。
 *
 * 机械判据只有一个常量 `PUBLISHED_MAX`：
 *   **本仓主渠道是 GitHub `main` 公开源码**（clone 即得），npm 发的很少（只到 3.0.7）。
 *   判据取各渠道最高者——只查 npm 会把已发布的段落误判成开发期（2026-10-27 犯过）。
 *   下面「PUBLISHED_MAX 必须等于 origin/main 版本」的用例会盯着这个常量。
 *
 * 引号约定：写 `「修复」`（加引号）= 在**谈论这个词**，不算违规；
 * 不加引号的「修复」= 在**宣称修了东西**，开发期内容里出现即违规。
 *
 * 为什么做成测试而不是只写在文档里：文档里的约定不会报错。
 * 为什么带夹具：活文档零违规不等于检查有效——夹具证明它真的能红。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 对外已分发的最高版本（各渠道取最高者，见文件头） */
const PUBLISHED_MAX = "3.1.0";

const CHANGELOG = fileURLToPath(new URL("../../../CHANGELOG.md", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

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

const SECTION_DEV = /^>\s*\*\*影响面：开发期/;
const ENTRY_DEV = /^- .*〔开发期〕/;
const isBullet = (l) => /^- /.test(l);

/** 剥掉「…」引号内的内容：加引号 = 在谈论这个词，不加 = 在宣称修了东西 */
const stripQuoted = (line) => line.replace(/「[^」]*」/g, "");

/**
 * 返回违规清单（空数组 = 合规）。
 * 只查 `- ` 条目行：引用块里的口径说明本身就含「修复」二字，查进去会自伤。
 */
function auditChangelog(text, publishedMax = PUBLISHED_MAX) {
  const findings = [];
  for (const s of splitSections(text)) {
    const sectionDev = s.body.some((l) => SECTION_DEV.test(l));
    const entryDev = s.body.some((l) => isBullet(l) && ENTRY_DEV.test(l));
    const released = cmpVersion(s.version, publishedMax) <= 0;

    if (released && sectionDev)
      findings.push({
        version: s.version,
        kind: "false-section-mark",
        detail: "该版本已对外分发，不得把整段声明为「影响面：开发期」",
      });
    if (!released && !sectionDev && !entryDev)
      findings.push({
        version: s.version,
        kind: "missing-scope-mark",
        detail: "未对外分发的版本段须至少标一处影响面（段级 `影响面：开发期` 或条目级 `〔开发期〕`）",
      });

    const devBullets = s.body.filter((l) => isBullet(l) && (sectionDev || ENTRY_DEV.test(l)));
    const bad = devBullets.filter((l) => stripQuoted(l).includes("修复"));
    if (bad.length)
      findings.push({
        version: s.version,
        kind: "fix-word-in-dev",
        detail: `开发期内容出现「修复」${bad.length} 处（未加引号 = 在宣称修了东西），改写为「某某改为…／收敛为…／加固…」`,
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

  // 这条盯的是「渠道查全」这个动作：常量一旦落后于 GitHub main，就会把已发布的段落判成开发期
  test("PUBLISHED_MAX 必须等于 GitHub main（origin/main）上的版本", (t) => {
    const r = spawnSync("git", ["show", "origin/main:package.json"], {
      cwd: REPO,
      encoding: "utf8",
    });
    if (r.status !== 0) return t.skip("无 origin/main 引用（浅克隆或未配远端），跳过");
    const onGithub = JSON.parse(r.stdout).version;
    assert.equal(
      PUBLISHED_MAX,
      onGithub,
      `PUBLISHED_MAX=${PUBLISHED_MAX} 与 GitHub main 上的 ${onGithub} 不一致——推送新版本后须同步这个常量，否则影响面会判错`,
    );
  });

  // 没有这条，上面的「零违规」可以靠解析失败来通过——本仓已栽过「锚点缺失静默返回空」的坑
  test("结构锚点：解析必须真的看见各段，且开发期标注落在该落的地方", () => {
    const sections = splitSections(readFileSync(CHANGELOG, "utf8"));
    assert.ok(sections.length >= 10, `只解析出 ${sections.length} 段，CHANGELOG 解析失败`);
    const versions = sections.map((s) => s.version);
    for (const v of ["3.2.0", "3.1.0", "3.0.10", "3.0.9"])
      assert.ok(versions.includes(v), `漏段 ${v}（解析或标题格式变了）`);

    const cur = sections.find((s) => s.version === "3.2.0");
    const marked = cur.body.filter((l) => isBullet(l) && ENTRY_DEV.test(l));
    assert.ok(
      marked.length >= 5,
      `3.2.0 段只找到 ${marked.length} 条 〔开发期〕 标记，工具链那批条目的标注被删了？`,
    );
    // 反向锚点：修「已发布版本里的缺陷」的条目不得被误标成开发期，否则对外影响面会被藏掉
    for (const key of ["抽查B 默认不再打断", "熔断只活一步", "熔断审计重复记账"]) {
      const line = cur.body.find((l) => isBullet(l) && l.includes(key));
      assert.ok(line, `3.2.0 段找不到「${key}」条目`);
      assert.ok(!ENTRY_DEV.test(line), `「${key}」修的是已发布版本里的缺陷，不得标 〔开发期〕`);
    }
  });

  test("夹具：段级开发期声明下的条目写「修复」必须报（证明检查真能红）", () => {
    const text = "## 9.9.9 · 2026-01-01\n\n> **影响面：开发期**\n\n- fix(x): 修复了授权重复登记的问题\n";
    const findings = auditChangelog(text);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "fix-word-in-dev");
    assert.equal(findings[0].version, "9.9.9");
  });

  test("夹具：条目级 〔开发期〕 同样受限", () => {
    const text = "## 9.9.9 · 2026-01-01\n\n- fix(tools): 〔开发期〕修复了闸门不响的问题\n";
    const findings = auditChangelog(text);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "fix-word-in-dev");
  });

  test("夹具：未推送段一处标注都没有必须报", () => {
    const findings = auditChangelog("## 9.9.9 · 2026-01-01\n\n- feat(x): 新增能力\n");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "missing-scope-mark");
  });

  test("夹具：已发布段标整段开发期必须报", () => {
    const findings = auditChangelog(
      "## 3.0.7 · 2026-01-01\n\n> **影响面：开发期**\n\n- feat(x): 新增\n",
      "3.0.7",
    );
    assert.ok(
      findings.some((f) => f.kind === "false-section-mark"),
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
