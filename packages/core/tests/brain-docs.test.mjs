/**
 * 文档 → 记忆块的判据（2026-11-02）。
 *
 * 四件事，都是"错了会静默"的那种：
 *   ① **切块**——切坏了不报错，只是变成一堆碎片，卡片上每块都读不懂；
 *   ② **同步幂等**——写错了每跑一次就多出一份副本，脑里长出一堆影子；
 *   ③ **关联**——连不上也不报错，只是图上全是散点，而输出照样写着"记忆 356 块"；
 *   ④ **作废**——把被推翻的旧口径当现行规矩读出来，不报错，但会照着错的口径办事。
 *
 * 用户原话：「真正的文件内容记忆呢？某某工具怎么执行，某某函数调用？踩过的坑，
 * 人格画像呢，use.md 培养呢」——这个文件的全部意义就是把"名字"换成"内容"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDocs, syncDocs } from "../tools/lib/brain-docs.mjs";
import { emptyIndex } from "../tools/lib/brain-core.mjs";

const SRC = [{ path: "rules.md", kind: "rule", label: "法条", region: "stem", defaultW: 8, start: /^- \*\*第/ }];

/** 建一个临时仓库、写一份 rules.md、跑完删掉。四个用例共用同一套脚手架。 */
function withRepo(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), "fg-docs-"));
  try {
    writeFileSync(join(dir, "rules.md"), body);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("文档切块：一块一个意思，子项跟着走，标题不带 markdown 记号", () => {
  const body = [
    "# 办法",
    "",
    "- **第一条** 制定依据：根据宪法制定。",
    "- **第二条** 适用范围：",
    "  - （一）本工作区全部人工智能体；",
    "  - （二）外部调用的全部模型。",
    "",
    "### 附则",
    "- **第三条** 施行日期。",
  ].join("\n");
  withRepo(body, (dir) => {
    const blocks = readDocs(dir, SRC);
    assert.equal(blocks.length, 3, "三条法条就是三块");
    assert.ok(blocks[0].title.startsWith("第一条"), `标题要以条号开头，实得 ${blocks[0].title}`);
    assert.ok(!blocks[0].title.includes("**"), "标题里的 markdown 粗体要去掉，否则卡片上是星号");
    assert.ok(blocks[1].text.includes("（二）外部调用的全部模型"), "子项必须跟着本条走，它不是独立的块");
    assert.ok(blocks[1].text.includes("（一）本工作区"), "子项要完整");
    assert.equal(blocks[1].kind, "rule");
    assert.equal(blocks[1].region, "stem", "分区由来源文档决定，不由标题文字猜");
  });
});

test("同步幂等：跑第二遍不会长出副本，源文件删了记忆也跟着消失", () => {
  withRepo("- **第一条** 甲。\n- **第二条** 乙。\n", (dir) => {
    const idx = emptyIndex();
    const first = syncDocs(idx, dir, SRC);
    assert.equal(first.blocks, 2);
    const ids = Object.keys(idx.entities).sort();

    const second = syncDocs(idx, dir, SRC);
    assert.equal(second.blocks, 2);
    assert.equal(second.removed, 2, "旧块要先删掉再建，否则第二遍就是四块");
    assert.deepEqual(Object.keys(idx.entities).sort(), ids, "同一份文档两次同步必须得到同一批 id");

    // 源文件没了，记忆不该继续挂在脑里——这正是"记名字不记内容"会犯的错。
    rmSync(join(dir, "rules.md"));
    const third = syncDocs(idx, dir, SRC);
    assert.equal(third.blocks, 0);
    assert.equal(Object.keys(idx.entities).length, 0, "源文件删了，对应记忆必须一起走");
  });
});

/* 关联算法。这条测试的由来是一个**已经发生过的假绿**：
   上一版只连「记忆 → 日志实体」，跑出来 356 块里 41 块有边、423 次提及落空，
   而重建输出只写「记忆 356 块」——没有任何一行说"其余 315 块是孤岛"。
   于是"关联做好了"这句话成立了三周，图上一直是散点。
   现在钉死三条：自指不算、互引要连、共享冷门对象要连。 */
test("关联：自指不算边，互引与同题各连各的", () => {
  const body = [
    "- **第一条** 总则，见 src/core/gate.mjs。",
    "- **第二条** 细则，同样落在 src/core/gate.mjs 上。",
    "- **第三条** 照第一条办理。",
  ].join("\n");
  withRepo(body, (dir) => {
    const idx = emptyIndex();
    const r = syncDocs(idx, dir, SRC);

    assert.equal(r.blocks, 3);
    assert.equal(r.ref, 1, "第三条提到第一条 → 一条互引边；第一条提到自己不算");
    assert.equal(r.share, 1, "第一、二条共享同一个冷门文件 → 一条同题边");
    assert.equal(r.trace, 0, "这些路径日志从没碰过，不该凭空造节点");

    const byId = Object.fromEntries(Object.entries(idx.entities).map(([k, v]) => [v.n.split(" ")[0], k]));
    const has = (a, b, kind) =>
      Object.values(idx.edges).some((e) =>
        e.k === kind && ((e.s === byId[a] && e.t === byId[b]) || (e.s === byId[b] && e.t === byId[a])));
    assert.ok(has("第一条", "第三条", "ref"), "互引要落在 ref 上");
    assert.ok(has("第一条", "第二条", "share"), "共享对象要落在 share 上");
    assert.ok(!has("第一条", "第一条", "ref"), "自己引用自己不是关系");
  });
});

test("作废的条目不画：挂着 {invalid:…} 的记忆是已经被推翻的旧口径", () => {
  const body =
    "- **第一条** 旧口径。 {origin:tool,src:user,imp:9,ttl:180} {invalid:2026-10-19T12:18:32+08:00,origin:panel}\n" +
    "- **第二条** 现行口径。 {origin:tool,src:user,imp:9,ttl:180}\n" +
    // 正文里**讲到**这个标记的条目不是作废条目。判据认结构不认词，否则它会把说明自己也吃掉。
    "- **第三条** 说明：尾部挂 `{invalid:…}` 的条目算作废。\n";
  withRepo(body, (dir) => {
    const idx = emptyIndex();
    const r = syncDocs(idx, dir, SRC);
    assert.equal(r.blocks, 2, "作废的那条不进记忆，但讲作废规则的那条要留");
    assert.equal(r.stale, 1);
    assert.ok(!Object.values(idx.entities).some((e) => e.n.startsWith("第一条")), "旧口径必须消失");
  });
});
