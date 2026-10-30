import { test } from "node:test";
import assert from "node:assert/strict";

// 两种切法与书的渲染（2026-10-30）
//
// 起因：卡片式（按 `##` 切，28 块）便于定位"某条结论出自哪一节"，但同一份厂商资料被切成
// 四块后读起来会断。`--by-file` 按文件切（7 块）一个文件即一章，章节完整。
//
// 本文件锁住的是**两种切法的语义差别**，不只是各自能跑：
//   ① 卡片版丢掉每份资料开头的来源说明（`##` 之前的内容），章节版保留——这是章节版
//      多出 2052 字的来源，也是"章节完整"的实证，不能悄悄退化；
//   ② 章节版要剥掉 `# 一级标题`，否则书里会出现外层 h2 章节名 + 内层 h1 同名两层标题；
//   ③ 书里要能渲染 `>` 引用与 `---` 分隔线——章节版把来源说明带进来之后才暴露这两个缺口。

const { splitBlocks, wholeFileBlock } = await import("../tools/library-build.mjs");
const { mdToHtml, parseBlock, parseGroups } = await import("../tools/library-book.mjs");

const SRC = [
  "# Anthropic",
  "",
  "> 来源：material/Anthropic/（550 个文件，约 23 MB）",
  "> 抽样方式：关键词排名 → 精读 10 个代表文件",
  "",
  "## 一句话定位",
  "",
  "把价值观放进宪法层。",
  "",
  "## 核心机制",
  "",
  "1. **双层行为模型** — 硬约束 vs 可调整的 defaults",
  "2. 第二条",
  "",
  "---",
  "",
  "> 末尾备注",
].join("\n");

test("卡片切法：按 `##` 切，且**丢掉** `##` 之前的来源说明", () => {
  const blocks = splitBlocks(SRC);
  assert.deepEqual(
    blocks.map((b) => b.title),
    ["一句话定位", "核心机制"],
    "两个 `##` 各成一块",
  );
  assert.ok(!blocks.some((b) => b.body.includes("抽样方式")), "来源说明在 `##` 之前，卡片版不保留");
  assert.equal(blocks[1].body.includes("---"), true, "`---` 留在所属块正文里");
});

test("章节切法：一个文件一章，标题取 `#`，正文剥掉那一行", () => {
  const blocks = wholeFileBlock(SRC, "Anthropic.md");
  assert.equal(blocks.length, 1, "一个文件只出一章");
  assert.equal(blocks[0].title, "Anthropic", "标题取 `# ` 一级标题");
  assert.ok(!blocks[0].body.startsWith("# Anthropic"), "正文不能重复带 h1，否则书里两层同名标题");
  assert.ok(blocks[0].body.includes("抽样方式"), "章节版**保留**来源说明——这是它比卡片版多出的部分");
  assert.ok(blocks[0].body.includes("## 一句话定位"), "`##` 小节原样留在正文里，由书渲染成子标题");
});

test("章节切法：没有 `#` 标题时用文件名兜底", () => {
  const blocks = wholeFileBlock("## 只有二级标题\n\n正文", "misc.md");
  assert.equal(blocks[0].title, "misc.md", "无 h1 用兜底标题");
  assert.equal(blocks[0].body, "## 只有二级标题\n\n正文", "整篇都是正文");
});

test("章节切法：空文件不产块", () => {
  assert.deepEqual(wholeFileBlock("# 只有标题\n", "x.md"), [], "剥掉 h1 后没内容就不该成章");
});

test("书渲染：`##`→h3、`###`→h4、`#`→h2（层级整体下移一层，给章节名让位）", () => {
  assert.equal(mdToHtml("# A"), "<h2>A</h2>");
  assert.equal(mdToHtml("## B"), "<h3>B</h3>");
  assert.equal(mdToHtml("### C"), "<h4>C</h4>");
});

test("书渲染：连续的 `>` 行合并成一个引用块，每行一段", () => {
  const html = mdToHtml("> 第一行\n> 第二行");
  assert.equal(html, "<blockquote><p>第一行</p><p>第二行</p></blockquote>");
});

test("书渲染：`---` 是分隔线，不被当成空的列表项", () => {
  assert.equal(mdToHtml("---"), "<hr>", "`---` 必须先于列表判定");
  assert.equal(mdToHtml("- 真列表项"), "<ul><li>真列表项</li></ul>");
});

test("书渲染：引用块结束后正文能正常续接", () => {
  const html = mdToHtml("> 引用\n\n正文段");
  assert.equal(html, "<blockquote><p>引用</p></blockquote>\n<p>正文段</p>");
});

test("书渲染：粗体与行内码，且 HTML 特殊字符被转义", () => {
  assert.equal(mdToHtml("**粗** 和 `code`"), "<p><strong>粗</strong> 和 <code>code</code></p>");
  assert.equal(mdToHtml("a < b & c"), "<p>a &lt; b &amp; c</p>", "正文里的 < 与 & 不能直接进 HTML");
});

test("书渲染：`a > b` 这类正文比较符不该被当成引用块", () => {
  // 只有**行首**的 `>` 才是引用；行内出现是普通字符
  assert.equal(mdToHtml("优先级 a > b"), "<p>优先级 a &gt; b</p>");
});

test("书渲染：认笔记体例的三层——条目名 / 动作行 / 出处行", () => {
  // 整行只有一句粗体 → 小标题（sans、更大、上方留白）
  assert.equal(mdToHtml("**1. 漂移三问**"), '<p class="h"><strong>1. 漂移三问</strong></p>');
  // `→` 开头 → 动作行
  assert.equal(mdToHtml("→ 接入：FG 会话注入"), '<p class="act">→ 接入：FG 会话注入</p>');
  // `出处：` 开头 → 出处行（小字、灰、贴在条目尾部）
  assert.equal(mdToHtml("出处：Anthropic.md §3"), '<p class="ref">出处：Anthropic.md §3</p>');
});

test("书渲染：粗体只在句中（不是整行）时不升级为小标题", () => {
  // 「**加粗** — 后接解释」是条目内的强调，不是条目名；误判会把正文切成假标题
  assert.equal(
    mdToHtml("**双层行为模型** — 宪法把行为分为两类"),
    "<p><strong>双层行为模型</strong> — 宪法把行为分为两类</p>",
  );
});

test("parseBlock：有 frontmatter 时拆出 meta，没有时整体当正文", () => {
  const withFm = parseBlock("---\nid: B001\ntitle: 标题\n---\n正文");
  assert.deepEqual(withFm.meta, { id: "B001", title: "标题" });
  assert.equal(withFm.body, "正文");
  const noFm = parseBlock("就是正文");
  assert.deepEqual(noFm.meta, {});
  assert.equal(noFm.body, "就是正文");
});

test("parseGroups：从 INDEX 的分组标题里取 id→组名", () => {
  const index = ["### 研读精华（FG3）（1 块）", "", "| B001 | f.md | t | sha | s | 保留 |", "", "### 厂商研读（FG3）（1 块）", "", "| B002 | g.md | t | sha | s | 新建 |"].join("\n");
  const map = parseGroups(index);
  assert.equal(map.get("B001"), "研读精华（FG3）");
  assert.equal(map.get("B002"), "厂商研读（FG3）");
});
