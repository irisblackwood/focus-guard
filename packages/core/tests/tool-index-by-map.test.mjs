import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// 两处「手写线性查找」换成一次性索引（2026-11-28）
//
// 病理一样：数据是一次性读进来的，索引本该建一次，却在循环里反复 `arr.find(...)`。
//   · `tools/audit-chain.mjs` 的 mermaid：按 seq 取节点、按 chain 取链首事件，各是一次 O(n²)。
//     实测 2 万行 532ms → 6 万行 3042ms（行数 3 倍、耗时 5.7 倍）；AUDIT.log 体积轮转上限
//     5MB ≈ 2 万条，正好落在曲线翘起的那段。同文件 `textTree` 早就建了 bySeq，只有它没建。
//   · `tools/library-build.mjs`：按 sha 找已有积木、按主题名找分组，同样在循环里线性扫。
//
// 本文件锁的是**换索引后的语义**，因为「快」这个理由会诱使人把语义一起换掉：
//   ① 重复 seq 必须取**首条**（`find` 的语义），不是末条（`new Map(...)` 的默认）
//   ② 内容相同即复用旧 id —— 与源文件路径无关，两个文件里的同一段共用一块积木
// 这两条都靠一次性的 Map 兜住，但 Map 的「后写覆盖」与「先到先得」只差一个 if。
// 换成后者，日志里 17 组 seq 撞号那些行的标签会静默换人。

const AUDIT_CHAIN = fileURLToPath(new URL("../tools/audit-chain.mjs", import.meta.url));
const LIBRARY_BUILD = fileURLToPath(new URL("../tools/library-build.mjs", import.meta.url));

const run = (tool, argv) => {
  const r = spawnSync(process.execPath, [tool, ...argv], { encoding: "utf8" });
  assert.equal(r.status, 0, `工具应正常退出：${r.stderr || ""}`);
  return r.stdout;
};

const tmp = (tag) => mkdtempSync(join(tmpdir(), `fg-${tag}-`));

describe("audit-chain：因果图按索引渲染", () => {
  test("重复 seq 取首条；父边与跨链虚线按链首事件连", () => {
    const dir = tmp("chain");
    try {
      const recs = [
        { ts: "2026-11-28T00:00:01.000Z", session: "s", action: "deny", trigger: "deny", level: 1, evidence: "第一条取证", pardon: false, seq: "a1", chain: "main" },
        // 同 seq 的第二条：标签取的是**这一条之前**的首条，不是它
        { ts: "2026-11-28T00:00:02.000Z", session: "s", action: "deny", trigger: "deny", level: 1, evidence: "同 seq 的第二条", pardon: false, seq: "a1", chain: "main" },
        { ts: "2026-11-28T00:00:03.000Z", session: "s", action: "allow", trigger: "allow", level: null, evidence: "子动作", pardon: false, seq: "a2", chain: "main", ref: "a1" },
        { ts: "2026-11-28T00:00:04.000Z", session: "s", action: "delegate", trigger: "delegate", level: null, evidence: "派单", pardon: false, seq: "b1", chain: "main/d1", ref: "a2" },
      ];
      const log = join(dir, "AUDIT.log");
      writeFileSync(log, recs.map((r) => JSON.stringify(r)).join("\n"), "utf8");

      const out = run(AUDIT_CHAIN, [log, "--mermaid"]);

      assert.ok(out.startsWith("graph TD"), "应是 Mermaid 图");
      assert.ok(out.includes("第一条取证"), "重复 seq 的标签应取首条");
      assert.ok(!out.includes("同 seq 的第二条"), "末条覆盖首条即为语义退化");
      assert.match(out, /-->\s*\n?/, "应渲染父边");
      assert.ok(out.includes("-.->"), "子代理链首事件应连一条虚线到父链首事件");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("library-build：按内容指纹复用积木", () => {
  test("同标题同正文的两个源共用一块积木；重跑不换号、不新增", () => {
    const dir = tmp("lib");
    try {
      const src = join(dir, "src");
      const out = join(dir, "lib");
      mkdirSync(src, { recursive: true });
      // 定位段两文件逐字相同（标题 + 正文）→ 指纹相同；机制/成本各自独立
      writeFileSync(join(src, "a.md"), "# 甲\n\n## 定位\n\n把价值观放进宪法层。\n\n## 机制\n\n训练前先对齐。\n", "utf8");
      writeFileSync(join(src, "b.md"), "# 乙\n\n## 定位\n\n把价值观放进宪法层。\n\n## 成本\n\n每千次调用约三美元。\n", "utf8");

      const first = run(LIBRARY_BUILD, ["--src", src, "--out", out, "--name", "甲"]);
      assert.match(first, /新建 4/, "首跑四块都是新的");

      const second = run(LIBRARY_BUILD, ["--src", src, "--out", out, "--name", "甲"]);
      assert.match(second, /新建 0/, "重跑不应新建任何积木");
      assert.match(second, /保留 4/, "四块全部按指纹复用");

      const index = readFileSync(join(out, "INDEX.md"), "utf8");
      const dupRow = index.split("\n").filter((l) => l.startsWith("| B001 |"));
      assert.equal(dupRow.length, 2, "同一段内容出现在两个源里 → 两行都指向 B001（按内容配对，与路径无关）");
      assert.equal(readdirSync(out).filter((f) => f.endsWith(".md")).length, 5, "4 块积木 + INDEX.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
