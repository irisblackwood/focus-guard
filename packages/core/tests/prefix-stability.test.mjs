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
  assert.equal(a.bytes, Buffer.byteLength("甲乙", "utf8"), "字节数应累加（UTF-8，中文一字 3 字节）");
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
  assert.equal(d.changed[0].delta, Buffer.byteLength("新的内容更长") - Buffer.byteLength("旧"), "字节差按 UTF-8 算");
  assert.deepEqual(d.added, ["focus-guard-fuse"]);
  assert.deepEqual(d.removed, []);
  assert.ok(describeShift(d).includes("focus-guard-workspace(+15B)"), describeShift(d));
});

test("差异：删除也能报（段没了等于前缀短了）", () => {
  const prev = fingerprintSections([sec("focus-guard-rules", "甲"), sec("focus-guard-fuse", "熔断")]);
  const next = fingerprintSections([sec("focus-guard-rules", "甲")]);
  const d = diffFingerprints(prev, next);
  assert.deepEqual(d.removed, ["focus-guard-fuse"]);
  assert.equal(d.bytes, -Buffer.byteLength("熔断"), "删除段后总字节减少");
});

// 黄金指纹（2026-10-29）：固定输入 → FG 段指纹。**CI 可复现**，不依赖本机会话落盘。
// 改注入内容（规则 / 卷宗渲染 / 熔断告知）会让它红：确认是有意改，再同步更新这三个数字，
// 而不是直接删断言——它替代不了 prefix-drift（那是真机探针），但能把"注入内容漂移"挡在 CI。
const GOLDEN = {
  hash: "e2c278768158",
  bytes: 979,
  parts: { "focus-guard-rules": 520, "focus-guard-workspace": 242, "focus-guard-fuse": 217 },
};

test("黄金指纹：固定输入下 FG 段指纹不得漂移", async () => {
  const { SESSION_RULES, FUSE_NOTICE } = await import("../src/core/constants.mjs");
  const { renderWorkspaceSection } = await import("../src/dsh/workspace.mjs");
  const record = {
    workspace_hash: "h".repeat(16),
    decisions: ["d1"],
    constraints: ["cmd-A"],
    next_action: [],
    snapshot: {
      sid: "sess-prev",
      at: "2026-10-29T09:00:00.000Z",
      toolCalls: 40,
      denies: 2,
      kpi: -9,
      delegateBudget: 12,
    },
  };
  const sections = [
    { name: "focus-guard-rules", text: SESSION_RULES },
    { name: "focus-guard-workspace", text: renderWorkspaceSection(record, { sid: "sess-current" }) },
    { name: "focus-guard-fuse", text: FUSE_NOTICE },
  ];
  const fp = fingerprintSections(sections);
  assert.equal(fp.hash, GOLDEN.hash, "注入内容变了：有意改就同步更新黄金值，别直接删断言");
  assert.equal(fp.bytes, GOLDEN.bytes, "总字节按 UTF-8 算");
  for (const p of fp.parts) assert.equal(p.bytes, GOLDEN.parts[p.name], `${p.name} 段字节数漂了`);
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

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
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
    const rulesChanged = { name: "focus-guard-rules", text: "规则已改" };
    assert.equal(mod.notePrefixShift(context, host, [rules]), null, "首见只建基线");
    assert.equal(mod.notePrefixShift(context, host, [rules]), null, "没变不写");
    mod.notePrefixShift(context, host, [rulesChanged, { name: "focus-guard-fuse", text: "熔断" }]);
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
    assert.match(shift[0].evidence, /focus-guard-rules/, "证据里要写清是哪一段变了");
    // 宿主段变化不该触发
    mod.notePrefixShift(context, { sections: [{ name: "host-base", text: "换了" }] }, [rulesChanged, { name: "focus-guard-fuse", text: "熔断" }]);
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

// 2026-10-29：原实现只在 rules 监听器里自算,而 cost 段由另一个监听器在 next() 之后追加,
// 观测点看不到 → cost 变了审计不响。改成最外层观测器后,这里锁两件事:
//   ① 观测器拿到的是 next() 返回的最终装配（含 cost 段）
//   ② 只有 fuse 段翻转（熔断开关）时不写审计（已知合法切换,别把真抖动淹掉）
test("接线：观测器看最终装配（含 cost 段），fuse 单独翻转不写审计", async () => {
  const TMP = mkdtempSync(join(tmpdir(), "fg-prefix-observer-"));
  const auditFile = join(TMP, "AUDIT.log");
  const saved = { audit: process.env.FG_AUDIT_FILE, ws: process.env.FG_WORKSPACE_FILE };
  process.env.FG_AUDIT_FILE = auditFile;
  process.env.FG_WORKSPACE_FILE = join(TMP, "workspace.json");
  const rows = () =>
    existsSync(auditFile)
      ? readFileSync(auditFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  try {
    const mod = await import(`../src/dsh/index.js?observer=${Date.now()}`);
    const observer = mod.prefixObserverListener();
    const context = { agent: { session: { header: { id: "obs-session" } } } };
    const base = (cost, host = "host-base-A") => [
      { name: "host-base", text: host },
      { name: "focus-guard-rules", text: "规则" },
      { name: "focus-guard-cost", text: cost },
    ];
    const call = (sections) => observer(null, context, async () => ({ sections }));

    await call(base("cost-A")); // 基线
    await call(base("cost-A")); // 稳定
    assert.equal(rows().length, 0, "稳定期不得写审计");
    await call(base("cost-B")); // cost 段变了 → 必须响（这就是原盲区的回归）
    const shifts = rows().filter((r) => r.action === "prompt-prefix-shift");
    assert.equal(shifts.length, 1, "cost 段变化必须被观测到");
    assert.match(shifts[0].evidence, /focus-guard-cost/, "证据要指出是哪一段变了");

    await call([...base("cost-B"), { name: "focus-guard-fuse", text: "熔断告知" }]);
    await call(base("cost-B"));
    assert.equal(
      rows().filter((r) => r.action === "prompt-prefix-shift").length,
      1,
      "只由 fuse 段翻转引起的抖动不写审计",
    );

    // 宿主段漂移：单独诊断、每会话只报一次，且不得混进 FG 的 shift 审计
    await call(base("cost-B", "host-base-B"));
    await call(base("cost-B", "host-base-C"));
    const hostRows = rows().filter((r) => r.action === "prompt-prefix-host");
    assert.equal(hostRows.length, 1, "宿主段漂移每会话最多一条");
    assert.match(hostRows[0].evidence, /host-base/, "证据要指出是哪个宿主段变了");
    assert.equal(
      rows().filter((r) => r.action === "prompt-prefix-shift").length,
      1,
      "宿主段变化不得写进 FG 的 prompt-prefix-shift",
    );
  } finally {
    if (saved.audit === undefined) delete process.env.FG_AUDIT_FILE;
    else process.env.FG_AUDIT_FILE = saved.audit;
    if (saved.ws === undefined) delete process.env.FG_WORKSPACE_FILE;
    else process.env.FG_WORKSPACE_FILE = saved.ws;
  }
});

// ── 注册顺序：观测器必须真的在最外层（2026-10-30）─────────────────────────
// 上面两条接线用例是**手工调用** observer 函数，绕过了注册链。若注册顺序错了
// （比如有人在 observer 之前 prepend 了别的监听器），它就成了内层，
// next() 只能看到下游，rules 追加的 workspace 段它永远看不见——而测试照样全绿。
// 这条走真实 apply(ctx)，并按 Cordis 语义跑链（源码 lib/index.js:317 `cbs.shift()`，
// 注释原文 "Listeners run outermost-first"）：注册在前的先跑 = 最外层。

test("注册顺序：apply 后观测器在最外层，基线含 rules 追加的 workspace 段", async () => {
  const TMP = mkdtempSync(join(tmpdir(), "fg-prefix-order-"));
  const saved = { ws: process.env.FG_WORKSPACE_FILE, audit: process.env.FG_AUDIT_FILE };
  process.env.FG_WORKSPACE_FILE = join(TMP, "workspace.json");
  process.env.FG_AUDIT_FILE = join(TMP, "AUDIT.log");
  try {
    const mod = await import(`../src/dsh/index.js?order=${Date.now()}`);
    const ws = await import("../src/dsh/workspace.mjs");
    const cwd = join(TMP, "proj");
    mkdirSync(cwd, { recursive: true });
    ws.resetWorkspaceSectionCache();
    ws.mergeWorkspace(cwd, { decisions: ["order-d1"], constraints: ["order-c1"] });

    // 假 ctx：**push 不覆盖**。fuse-lifecycle 那份用 Map.set，同事件只留最后一个，测不了顺序。
    const hooks = new Map();
    const ctx = {
      on: (event, fn) => {
        if (!hooks.has(event)) hooks.set(event, []);
        hooks.get(event).push(fn);
      },
      tools: { register: () => {}, guard: () => {}, schemas: () => [] },
      logger: { warn: () => {} },
      effect: () => {},
    };
    mod.apply(ctx);

    const chain = hooks.get("system-prompt/assemble") || [];
    assert.ok(chain.length >= 3, `装配缝应有 ≥3 个监听器，实际 ${chain.length}`);

    const sid = `order-${process.pid}`;
    const context = { agent: { session: { header: { id: sid, cwd } } } };
    const inner = () => ({ sections: [{ name: "host-base", text: "宿主" }] });
    // 按 Cordis waterfall 语义跑：cbs.shift() → 第一个先跑，next() 继续；没人接管就落到 inner。
    const runChain = (assembly) => {
      const cbs = [...chain];
      const next = () => {
        const cb = cbs.shift();
        return cb ? cb(assembly, context, next) : inner();
      };
      return next();
    };

    const out = await runChain({ sections: [{ name: "host-base", text: "宿主" }] });
    const names = (out && out.sections ? out.sections : []).map((s) => s.name);
    assert.ok(
      names.includes("focus-guard-workspace"),
      `rules 监听器应追加 workspace 段，实际：${names.join(",") || "(空)"}`,
    );

    // 关键断言：观测器的基线里必须有 workspace 段。
    // 若它被注册到内层，next() 返回的是 rules 之前的结果，基线里就只有 host-base。
    const fp = mod.prefixTracker.get(sid);
    assert.ok(fp, "观测器应已建基线");
    const tracked = fp.parts.map((p) => p.name);
    assert.ok(
      tracked.includes("focus-guard-workspace"),
      `观测器看不到 rules 追加的段（说明它不在最外层）：${tracked.join(",") || "(空)"}`,
    );
    assert.ok(!tracked.includes("host-base"), "宿主段不该进 FG 基线");
  } finally {
    if (saved.ws === undefined) delete process.env.FG_WORKSPACE_FILE;
    else process.env.FG_WORKSPACE_FILE = saved.ws;
    if (saved.audit === undefined) delete process.env.FG_AUDIT_FILE;
    else process.env.FG_AUDIT_FILE = saved.audit;
  }
});

// fuse 白名单是**限次免检**，不是免检（2026-10-30）：
// 正常熔断拨一下，连续拨第四次说明它在抖（state 读错/写错），必须报。
test("fuse 单独翻转超过阈值 → 判 churn 并写审计", async () => {
  const TMP = mkdtempSync(join(tmpdir(), "fg-prefix-churn-"));
  const auditFile = join(TMP, "AUDIT.log");
  const saved = { audit: process.env.FG_AUDIT_FILE, ws: process.env.FG_WORKSPACE_FILE };
  process.env.FG_AUDIT_FILE = auditFile;
  process.env.FG_WORKSPACE_FILE = join(TMP, "workspace.json");
  const rows = () =>
    existsSync(auditFile)
      ? readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  try {
    const mod = await import(`../src/dsh/index.js?churn=${Date.now()}`);
    const context = { agent: { session: { header: { id: "churn-session" } } } };
    const call = (fuse) =>
      mod.notePrefixShift(context, { sections: [{ name: "focus-guard-fuse", text: fuse }] }, []);

    call("关"); // 基线
    call("开"); // 1
    call("关"); // 2
    call("开"); // 3
    assert.equal(rows().filter((r) => r.action === "prompt-prefix-shift").length, 0, "前 3 次属正常拨动，不报");
    call("关"); // 4 > 阈值
    const shifts = rows().filter((r) => r.action === "prompt-prefix-shift");
    assert.equal(shifts.length, 1, "第 4 次必须报——白名单不能把真故障吞掉");
    assert.match(shifts[0].evidence, /fuse-churn/, "证据要标明这是 churn 而非普通抖动");
  } finally {
    if (saved.audit === undefined) delete process.env.FG_AUDIT_FILE;
    else process.env.FG_AUDIT_FILE = saved.audit;
    if (saved.ws === undefined) delete process.env.FG_WORKSPACE_FILE;
    else process.env.FG_WORKSPACE_FILE = saved.ws;
  }
});
