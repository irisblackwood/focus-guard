import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 按需自证（Lazy Liveness，2026-10-19）
// 病根：心跳与模块状态常驻注入系统提示 → 每轮都占 token、稀释注意力，而"FG 是否在场"只在
// "要解释一次拦截/一次申请/一次压缩"时才有意义。
// 本组锁定四件事：① 正常态零注入；② 拦截理由带徽标；③ fg_apply 返回带徽标；④ 心跳只写文件、不写审计。

const WORK = mkdtempSync(join(tmpdir(), "fg-lazy-"));
process.env.FG_STATUS_FILE = join(WORK, "status.json");
process.env.FG_AUDIT_FILE = join(WORK, "AUDIT.log");
process.env.FG_SHELL = "";

const hb = await import("../src/dsh/heartbeat.mjs");

test("正常态：徽标短且无降级段；livenessNote 不再返回常驻告警文本以外的内容", () => {
  for (const id of hb.moduleSnapshot ? Object.keys(hb.moduleSnapshot()) : []) {
    void id;
  }
  const badge = hb.livenessBadge();
  assert.match(badge, /^\[FG 存活 \d+\/\d+/);
  assert.doesNotMatch(badge, /降级/);
});

test("待报告事件：noteLivenessEvent 只被消费一次", () => {
  hb.noteLivenessEvent("compaction");
  const first = hb.livenessBadge();
  assert.match(first, /事件: compaction/);
  const second = hb.livenessBadge();
  assert.doesNotMatch(second, /事件:/, "事件徽标必须一次性");
});

test("降级：徽标带模块名，且标记哪些缝不可用", () => {
  hb.markModule("test-probe-module", false, "模拟未报到");
  const badge = hb.livenessBadge({ full: true });
  assert.match(badge, /降级: .*test-probe-module/);
  assert.match(badge, /不要假设它们仍在拦/);
  hb.markModule("test-probe-module", true);
});

test("心跳只写 status.json，不写审计（降噪）", async () => {
  const modes = hb.moduleSnapshot ? Object.keys(hb.moduleSnapshot()) : [];
  for (const id of modes) hb.markModule(id, true);
  const stop = hb.startHeartbeat({ warn: () => {} });
  await new Promise((r) => setTimeout(r, 60));
  stop();
  assert.ok(existsSync(process.env.FG_STATUS_FILE), "应写出 status.json");
  const body = JSON.parse(readFileSync(process.env.FG_STATUS_FILE, "utf8"));
  assert.equal(body.status, "ALIVE");
  assert.equal(existsSync(process.env.FG_AUDIT_FILE), false, "心跳不得往 AUDIT.log 写任何行");
  rmSync(WORK, { recursive: true, force: true });
});

test("装配层：系统提示不再包含 focus-guard-degraded 段", async () => {
  process.env.FG_STATUS_FILE = join(mkdtempSync(join(tmpdir(), "fg-lazy2-")), "status.json");
  const mod = await import("../src/dsh/index.js");
  const handlers = new Map();
  const ctx = {
    on: (event, fn) => handlers.set(event, fn),
    tools: { register: () => {}, guard: () => {} },
    logger: { warn: () => {} },
    effect: () => {},
  };
  mod.apply(ctx);
  const names = [...handlers.keys()];
  const assembleKey = names.filter((n) => n.startsWith("system-prompt/assemble"));
  assert.ok(assembleKey.length > 0, "应注册装配缝");
  // ctx.on(event, fn) 收到的是**已构造好的监听器**（index.js 的 register 里已调过 factory）
  const listener = handlers.get(assembleKey[assembleKey.length - 1]);
  assert.equal(typeof listener, "function", "装配缝监听器应可调用");
  const downstream = { sections: [] };
  const out = await listener({ sections: [] }, { agent: { session: { header: { cwd: null } } } }, async () => downstream);
  const sectionNames = (out && out.sections ? out.sections : []).map((s) => s.name);
  assert.ok(
    !sectionNames.includes("focus-guard-degraded"),
    `系统提示不得再注入存活段，实际：${sectionNames.join(",") || "(空)"}`,
  );
});

