import { test } from "node:test";
import assert from "node:assert/strict";

// 前缀稳定性（2026-10-29）
//
// 缓存命中要求前缀**逐字节相同**。实测（tools/prefix-drift.mjs）四个真实会话：
// tools / user 段全程 1 个版本，system 段 2 个版本、分歧点恒定落在 FG 自己的 [FG-WORKSPACE] 段。
// 修内容是一半，能测出来是另一半——本文件锁"测"的那一半。

const {
  isFgSection,
  fingerprintSections,
  diffFingerprints,
  describeShift,
  createPrefixTracker,
} = await import("../src/core/prefixStability.mjs");

const sec = (name, text) => ({ name, text });

test("指纹：同内容同哈希，顺序不同也算变（前缀是字节序列）", () => {
  const a = fingerprintSections([sec("focus-guard-rules", "甲"), sec("focus-guard-cost", "乙")]);
  const b = fingerprintSections([sec("focus-guard-rules", "甲"), sec("focus-guard-cost", "乙")]);
  assert.equal(a.hash, b.hash, "同样的段同样的顺序 → 同一段字节");
  const swapped = fingerprintSections([sec("focus-guard-cost", "乙"), sec("focus-guard-rules", "甲")]);
  assert.notEqual(a.hash, swapped.hash, "顺序换了，前缀就不是同一段字节");
  assert.equal(a.chars, 2, "字符数应累加");
});

test("指纹：只认 focus-guard-* 段，宿主段不参与", () => {
  assert.equal(isFgSection("focus-guard-workspace"), true);
  assert.equal(isFgSection("focus-guard-fuse"), true);
  assert.equal(isFgSection("host-tools"), false);
  assert.equal(isFgSection(undefined), false);
});

test("差异：改 / 增 / 删三类都能报出来，带字节差", () => {
  const prev = fingerprintSections([sec("focus-guard-rules", "甲乙丙"), sec("focus-guard-workspace", "旧")]);
  const next = fingerprintSections([
    sec("focus-guard-rules", "甲乙丙"),
    sec("focus-guard-workspace", "新的内容更长"),
    sec("focus-guard-fuse", "熔断"),
  ]);
  const d = diffFingerprints(prev, next);
  assert.equal(d.stable, false);
  assert.deepEqual(
    d.changed.map((x) => x.name),
    ["focus-guard-workspace"],
  );
  assert.equal(d.changed[0].delta, 6 - 1, "字节差应可算出（6 字 vs 1 字）");
  assert.deepEqual(d.added, ["focus-guard-fuse"]);
  assert.deepEqual(d.removed, []);
  assert.ok(describeShift(d).includes("focus-guard-workspace(+5B)"), describeShift(d));
});

test("差异：删除也能报（段没了等于前缀短了）", () => {
  const prev = fingerprintSections([sec("focus-guard-rules", "甲"), sec("focus-guard-fuse", "熔断")]);
  const next = fingerprintSections([sec("focus-guard-rules", "甲")]);
  const d = diffFingerprints(prev, next);
  assert.deepEqual(d.removed, ["focus-guard-fuse"]);
  assert.equal(d.bytes, -2);
});

test("跟踪器：首见只建基线不报，之后变了才报一次", () => {
  const events = [];
  const t = createPrefixTracker({ audit: (e) => events.push(e) });
  const rules = sec("focus-guard-rules", "规则正文");
  assert.equal(t.note("s1", [rules, sec("focus-guard-workspace", "旧")]), null, "首见不报");
  assert.equal(t.note("s1", [rules, sec("focus-guard-workspace", "旧")]), null, "没变不报");
  const d = t.note("s1", [rules, sec("focus-guard-workspace", "新")]);
  assert.ok(d && !d.stable, "变了要返回差异");
  assert.equal(events.length, 1, "只报一次");
  assert.equal(events[0].sid, "s1");
});

test("跟踪器：会话之间不串味（换会话本来就会变，报警等于假阳性）", () => {
  const events = [];
  const t = createPrefixTracker({ audit: (e) => events.push(e) });
  t.note("A", [sec("focus-guard-workspace", "甲")]);
  assert.equal(t.note("B", [sec("focus-guard-workspace", "乙")]), null, "B 的第一次是它自己的基线");
  assert.equal(events.length, 0);
});

test("跟踪器：非 FG 段变化不算抖动", () => {
  const events = [];
  const t = createPrefixTracker({ audit: (e) => events.push(e) });
  t.note("s1", [sec("host-tools", "1"), sec("focus-guard-rules", "规则")]);
  assert.equal(t.note("s1", [sec("host-tools", "2"), sec("focus-guard-rules", "规则")]), null);
  assert.equal(events.length, 0, "宿主段的锅 FG 不背");
});

test("跟踪器：无 sid 不记（拿不到会话身份就没法比同会话）", () => {
  const t = createPrefixTracker({});
  assert.equal(t.note(null, [sec("focus-guard-rules", "x")]), null);
  assert.equal(t.size(), 0);
});

test("跟踪器：有界——会话数超过上限时丢最老的，不无限长", () => {
  const t = createPrefixTracker({ max: 3 });
  for (const sid of ["a", "b", "c", "d"]) t.note(sid, [sec("focus-guard-rules", "x")]);
  assert.equal(t.size(), 3);
  assert.equal(t.get("a"), null, "最老的应被淘汰");
  assert.ok(t.get("d"), "最新的应在");
});

test("跟踪器：audit 抛错不影响跟踪（观测不能拖垮装配）", () => {
  const t = createPrefixTracker({
    audit: () => {
      throw new Error("boom");
    },
  });
  t.note("s1", [sec("focus-guard-rules", "甲")]);
  assert.throws(() => t.note("s1", [sec("focus-guard-rules", "乙")]), /boom/);
  // 抛错后基线仍应更新，否则每步都会重报
  assert.equal(t.get("s1").hash, fingerprintSections([sec("focus-guard-rules", "乙")]).hash);
});

// ── 接线：审计行真的会被写出来吗（2026-10-29）──────────────────────────────
// 前面测的是纯函数；这一条测"接线在不在"。没有它，纯函数全绿也可能根本没被调用。

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("接线：FG 段变了 → 写一条 prompt-prefix-shift（七字段齐）", async () => {
  const TMP = mkdtempSync(join(tmpdir(), "fg-prefix-wire-"));
  const auditFile = join(TMP, "AUDIT.log");
  const saved = { audit: process.env.FG_AUDIT_FILE, ws: process.env.FG_WORKSPACE_FILE };
  process.env.FG_AUDIT_FILE = auditFile;
  process.env.FG_WORKSPACE_FILE = join(TMP, "workspace.json");
  try {
    const mod = await import(`../src/dsh/index.js?wire=${Date.now()}`);
    const context = { agent: { session: { header: { id: "wire-session" } } } };
    const host = { sections: [{ name: "host-base", text: "宿主自带" }] };
    const rules = { name: "focus-guard-rules", text: "规则" };
    assert.equal(mod.notePrefixShift(context, host, [rules]), null, "首见只建基线");
    assert.equal(mod.notePrefixShift(context, host, [rules]), null, "没变不写");
    mod.notePrefixShift(context, host, [rules, { name: "focus-guard-fuse", text: "熔断" }]);
    const rows = readFileSync(auditFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const shift = rows.filter((r) => r.action === "prompt-prefix-shift");
    assert.equal(shift.length, 1, "变一次只写一条");
    for (const k of ["ts", "session", "action", "trigger", "level", "evidence", "pardon"]) {
      assert.ok(k in shift[0], `审计行缺字段 ${k}`);
    }
    assert.equal(shift[0].session, "wire-session");
    assert.match(shift[0].evidence, /focus-guard-fuse/, "证据里要写清是哪一段变了");
    // 宿主段变化不该触发
    mod.notePrefixShift(context, { sections: [{ name: "host-base", text: "换了" }] }, [rules, { name: "focus-guard-fuse", text: "熔断" }]);
    assert.equal(
      readFileSync(auditFile, "utf8").trim().split("\n").length,
      rows.length,
      "宿主段变化不得写 FG 的抖动审计",
    );
  } finally {
    if (saved.audit === undefined) delete process.env.FG_AUDIT_FILE;
    else process.env.FG_AUDIT_FILE = saved.audit;
    if (saved.ws === undefined) delete process.env.FG_WORKSPACE_FILE;
    else process.env.FG_WORKSPACE_FILE = saved.ws;
  }
});
