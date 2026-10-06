// FocusGuard 扩展包桥测试（packages/extended）——主分支 npm test 不执行本文件
// 运行：npm run test:bridges（仓库根）或 cd packages/extended && npm test
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = `${process.pid}-${Date.now()}`;

after(() => {
  for (const f of readdirSync(tmpdir())) {
    if (f.startsWith("focus-guard-") && f.includes(RUN)) {
      try {
        rmSync(join(tmpdir(), f), { force: true });
      } catch {}
    }
  }
});

describe("focus-guard-extended 桥", () => {
  test("viking-bridge：INDEX 解析与 batch-write 载荷组装（纯函数）", async () => {
    const bridge = await import("../bridges/viking-bridge.mjs");
    const rows = bridge.parseIndex(
      "| id | 积木 | 标题 | sha256 | 源 | 状态 |\n|---|---|---|---|---|---|\n| B001 | B001-x.md | 积木一 | abc123 | src.md | 新建 |\n| B002 | B002-y.md | 积木二 | def456 | src.md | retired |"
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "B001");
    const payload = bridge.toOperations(bridge.ROOT_URI, rows, (f) => (f === "B001-x.md" ? "内容A" : null));
    assert.equal(payload.root_uri, "viking://resources/focus-guard-library");
    assert.equal(payload.operations.length, 1, "retired/缺失积木不投影");
    assert.equal(payload.operations[0].uri, "viking://resources/focus-guard-library/B001-x.md");
    assert.equal(payload.operations[0].mode, "upsert");
  });

  test("audit-chain-semantica：因果链导出 LPG 图谱（caused/spawned 边）", () => {
    const log = join(tmpdir(), `focus-guard-sem-${RUN}.log`);
    const recs = [
      { ts: "2026-10-06T12:00:00Z", session: "s", seq: "s1", chain: "T1", ref: null, action: "reset-fired", trigger: "x", level: null, evidence: "kw=10", pardon: false },
      { ts: "2026-10-06T12:01:00Z", session: "s", seq: "s2", chain: "T1", ref: null, action: "subagent-spawn", trigger: "x", level: null, evidence: "派单", pardon: false },
      { ts: "2026-10-06T12:02:00Z", session: "s", seq: "s3", chain: "T1/d1", ref: "s2", action: "delegate-used", trigger: "x", level: null, evidence: "委托消耗", pardon: false },
    ];
    writeFileSync(log, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const tool = join(HERE, "..", "bridges", "audit-chain-semantica.mjs");
    const p = spawnSync("node", [tool, log], { encoding: "utf8" });
    const g = JSON.parse(p.stdout);
    assert.equal(g.format, "lpg-v1");
    assert.equal(g.nodes.length, 3);
    assert.deepEqual(g.edges.filter((e) => e.label === "caused").map((e) => [e.src, e.dst]), [["s2", "s3"]]);
    assert.ok(g.edges.some((e) => e.label === "spawned"), "父链→子代理链应有 spawned 边");
    rmSync(log, { force: true });
  });

  test("契约符合性：桥不 import 主分支源码，只依赖契约", async () => {
    const files = ["../bridges/viking-bridge.mjs", "../bridges/needle2-sentinel.mjs", "../bridges/audit-chain-semantica.mjs"];
    for (const f of files) {
      const src = readFileSync(join(HERE, f), "utf8");
      assert.ok(!src.includes('from "../../'), `${f} 不得越出 bridges/ 引用主分支源码`);
      assert.ok(!src.includes("hooks/guard.mjs"), `${f} 不得直接引用引擎源码（只走契约）`);
    }
  });
});
