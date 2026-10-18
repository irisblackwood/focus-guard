// FocusGuard · 压缩监察（2026-10-18）
//
// 覆盖 compactionWatch.mjs 的两个监听器：
//   session/event        → compaction/start · user/message(replace) · compaction/end · compaction/prune
//   agent/request-error  → 撞窗留痕 + 压缩栈失效看门狗（waterfall，必须始终放行）
//
// 纪律：审计重定向到 tmpdir（FG_AUDIT_FILE），绝不碰真实工作区。
// 运行：node --test packages/core/tests/compactionWatch.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 审计沙箱：必须在任何 audit 调用之前生效
const AUDIT_TMP = join(tmpdir(), `fg-compaction-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

const {
  compactionEventListener,
  contextOverflowListener,
  _compactionWatchState,
  CONTEXT_OVERFLOW_CODE,
  announceWatchReady,
  _resetWatchAnnounce,
  WATCH_SEAMS,
} = await import("../src/dsh/compactionWatch.mjs");
const { markModule } = await import("../src/dsh/heartbeat.mjs");

const noop = () => {};
const mkSession = (id) => ({ id, header: { id } });
const auditRows = () =>
  existsSync(AUDIT_TMP)
    ? readFileSync(AUDIT_TMP, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const resetAudit = () => rmSync(AUDIT_TMP, { force: true });
const rowsOf = (action) => auditRows().filter((r) => r.action === action);

// ── 事件构造器：形状取自真实会话日志（session-c240683f 解压样本）──
const evStart = (id, turn = 3, seq = 100, time = 1_000, sourceCommandId) => ({
  type: "compaction/start",
  seq,
  time,
  data: sourceCommandId === undefined ? { compactionId: id, turn } : { compactionId: id, turn, sourceCommandId },
});
const evSummary = (startSeq, endSeq, sourceSeqs) => ({
  type: "user/message",
  seq: endSeq + 1,
  time: 1_100,
  data: { content: [{ type: "text", text: "summary" }] },
  surfaceOp: { op: "replace", startSeq, endSeq },
  sourceEventSeqs: sourceSeqs,
});
const evEnd = (id, turn = 3, seq = 200, time = 1_500, error) => ({
  type: "compaction/end",
  seq,
  time,
  data: error === undefined ? { compactionId: id, turn } : { compactionId: id, turn, error },
});
const evPrune = (tokens, seq = 300) => ({
  type: "compaction/prune",
  seq,
  time: 2_000,
  data: { shadowedRange: { start: 32, end: 32 }, shadowedSeqs: [32], shadowedTokenCount: tokens },
});
const evAssistant = (inputTokens, seq = 400) => ({
  type: "assistant/message",
  seq,
  time: 2_100,
  data: { turn: 1, step: 1, message: {}, usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 } },
  surfaceOp: "append",
});

describe("压缩监察 · 标记对与剪枝", () => {
  test("完整标记对 → 一条 compaction 记录，带影子节点数与区间", () => {
    resetAudit();
    const session = mkSession(`cw-ok-${process.pid}`);
    const listen = compactionEventListener({ warn: noop });

    listen(session, evStart("c-1", 7, 100, 1_000));
    listen(session, evSummary(14, 40, [14, 15, 16, 17]));
    listen(session, evEnd("c-1", 7, 200, 1_500));

    const rows = rowsOf("compaction");
    assert.equal(rows.length, 1, "一次压缩落定只应写一条");
    const [r] = rows;
    assert.equal(r.result, "ok");
    assert.equal(r.compaction_id, "c-1");
    assert.equal(r.turn, 7);
    assert.equal(r.duration_ms, 500, "时长取 end.time - start.time");
    assert.equal(r.shadowed_nodes, 4, "影子节点数取 sourceEventSeqs.length");
    assert.equal(r.shadowed_range, "14..40");
    assert.equal(r.session, session.id, "会话口径取 session.id");
    assert.equal(r.pardon, false);
    assert.equal(r.action, "compaction");
  });

  test("带 sourceCommandId → 记为手动 /compact 触发，可与自动压缩区分", () => {
    resetAudit();
    const session = mkSession(`cw-manual-${process.pid}`);
    const listen = compactionEventListener({ warn: noop });

    listen(session, evStart("c-9", 3, 100, 1_000, "cmd-abc"));
    listen(session, evEnd("c-9"));

    const [r] = rowsOf("compaction");
    assert.equal(r.basis, "builtin:command-compact");
    assert.equal(r.source_command_id, "cmd-abc");
  });

  test("end 带 error → result=failed，错误进 error 字段", () => {
    resetAudit();
    const session = mkSession(`cw-fail-${process.pid}`);
    const listen = compactionEventListener({ warn: noop });

    listen(session, evStart("c-2"));
    listen(session, evEnd("c-2", 3, 200, 1_500, "summarizer exploded"));

    const [r] = rowsOf("compaction");
    assert.equal(r.result, "failed");
    assert.match(r.error, /summarizer exploded/);
    assert.equal(r.trigger, "compaction/end(error)");
  });

  test("未闭合 start 后再次 start → unmatched-start 异常记录", () => {
    resetAudit();
    const session = mkSession(`cw-unmatched-${process.pid}`);
    const listen = compactionEventListener({ warn: noop });

    listen(session, evStart("c-3"));
    listen(session, evStart("c-4"));

    const rows = rowsOf("compaction-anomaly");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].trigger, "unmatched-start");
    assert.match(rows[0].detail, /c-3/);
  });

  test("无主的 end → orphan-end 异常记录", () => {
    resetAudit();
    const session = mkSession(`cw-orphan-${process.pid}`);
    const listen = compactionEventListener({ warn: noop });

    listen(session, evEnd("c-5"));

    const rows = rowsOf("compaction-anomaly");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].trigger, "orphan-end");
  });

  test("start/end 的 compactionId 不一致 → mismatched-id 异常，且仍落一条 compaction", () => {
    resetAudit();
    const session = mkSession(`cw-mismatch-${process.pid}`);
    const listen = compactionEventListener({ warn: noop });

    listen(session, evStart("c-6"));
    listen(session, evEnd("c-7"));

    const anomalies = rowsOf("compaction-anomaly");
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].trigger, "mismatched-id");
    assert.equal(rowsOf("compaction").length, 1, "异常不吞掉主记录");
  });

  test("prune 累计进状态，不逐条刷审计", () => {
    resetAudit();
    const session = mkSession(`cw-prune-${process.pid}`);
    const listen = compactionEventListener({ warn: noop });

    listen(session, evPrune(3248));
    listen(session, evPrune(3555));

    assert.equal(rowsOf("compaction").length, 0, "prune 不写 compaction 记录");
    assert.equal(auditRows().length, 0, "prune 本身不刷审计行");
    const state = _compactionWatchState(session);
    assert.equal(state.prunes, 2);
    assert.equal(state.prunedTokens, 6803);
  });

  test("assistant/message 的 usage.inputTokens 记入状态（供应商回报，非估算）", () => {
    resetAudit();
    const session = mkSession(`cw-usage-${process.pid}`);
    const listen = compactionEventListener({ warn: noop });

    listen(session, evAssistant(11627));
    assert.equal(_compactionWatchState(session).lastInputTokens, 11627);
  });

  test("非压缩事件一律忽略（不建状态、不写审计）", () => {
    resetAudit();
    const session = mkSession(`cw-ignore-${process.pid}`);
    const listen = compactionEventListener({ warn: noop });

    listen(session, { type: "tool/result", seq: 1, time: 1, data: {} });
    listen(session, { type: "turn/start", seq: 2, time: 1, data: { turn: 1 } });

    assert.equal(auditRows().length, 0);
    assert.equal(_compactionWatchState(session), null, "被忽略的事件不应创建会话状态");
  });

  test("脏事件不抛（监察不能成为宿主故障点）", () => {
    resetAudit();
    const warns = [];
    const listen = compactionEventListener({ warn: (...a) => warns.push(a.join(" ")) });
    const session = mkSession(`cw-dirty-${process.pid}`);

    assert.doesNotThrow(() => {
      listen(session, null);
      listen(session, {});
      listen(session, { type: "compaction/start" }); // 无 data
      listen(session, { type: "compaction/end", data: null });
    });
    assert.equal(warns.length, 0, "可容忍的空值不该刷 warn");
  });

  test("工厂未传 warn 时退化为静默，绝不在 catch 块里再抛", async () => {
    resetAudit();
    const session = mkSession(`cw-nowarn-${process.pid}`);

    assert.doesNotThrow(() => {
      const listen = compactionEventListener();
      listen(session, { type: "compaction/start" });
      listen(session, { type: "compaction/end" });
      listen(session, null); // 触发 catch 路径
    });

    const listen = contextOverflowListener();
    await assert.doesNotReject(() =>
      listen({ agent: { session }, failure: { code: CONTEXT_OVERFLOW_CODE } }, () => "downstream"),
    );
  });
});

describe("压缩监察 · 撞窗看门狗（waterfall，必须始终放行）", () => {
  test("撞窗且 0 压缩 0 剪枝 → stack_looks_dead=true，并只喊一次", async () => {
    resetAudit();
    const warns = [];
    const session = mkSession(`cw-overflow-dead-${process.pid}`);
    const listen = contextOverflowListener({ warn: (...a) => warns.push(a.join(" ")) });

    let nextCalls = 0;
    const next = () => {
      nextCalls += 1;
      return "downstream";
    };

    const failure = { code: CONTEXT_OVERFLOW_CODE, message: "context window exceeded" };
    const out1 = await listen({ agent: { session }, failure }, next);
    const out2 = await listen({ agent: { session }, failure }, next);

    assert.equal(out1, "downstream", "必须把 next() 的结果原样传下去");
    assert.equal(nextCalls, 2, "每次调用都要放行，本模块没有拦截权");
    assert.equal(warns.length, 1, "同一会话只喊一次");

    const rows = rowsOf("context-overflow");
    assert.equal(rows.length, 2, "每次撞窗都留痕");
    assert.equal(rows[0].stack_looks_dead, true);
    assert.equal(rows[0].compactions_so_far, 0);
    assert.equal(rows[0].prunes_so_far, 0);
    assert.match(rows[0].evidence, /压缩栈疑似未生效/);
  });

  test("已有压缩记录 → stack_looks_dead=false，不喊", async () => {
    resetAudit();
    const warns = [];
    const session = mkSession(`cw-overflow-alive-${process.pid}`);
    const watch = compactionEventListener({ warn: noop });
    const listen = contextOverflowListener({ warn: (...a) => warns.push(a.join(" ")) });

    watch(session, evStart("c-8"));
    watch(session, evEnd("c-8"));

    await listen({ agent: { session }, failure: { code: CONTEXT_OVERFLOW_CODE } }, () => "downstream");

    const [r] = rowsOf("context-overflow");
    assert.equal(r.stack_looks_dead, false);
    assert.equal(r.compactions_so_far, 1);
    assert.equal(warns.length, 0);
  });

  test("非撞窗错误 → 不写审计，但仍然放行", async () => {
    resetAudit();
    const session = mkSession(`cw-overflow-other-${process.pid}`);
    const listen = contextOverflowListener({ warn: noop });

    let nextCalls = 0;
    await listen({ agent: { session }, failure: { code: "QUOTA" } }, () => {
      nextCalls += 1;
      return "downstream";
    });

    assert.equal(nextCalls, 1);
    assert.equal(auditRows().length, 0);
  });

  test("failure 缺失 / agent 缺失 都不抛，仍放行", async () => {
    resetAudit();
    const listen = contextOverflowListener({ warn: noop });
    let nextCalls = 0;
    const next = () => {
      nextCalls += 1;
      return "downstream";
    };

    await assert.doesNotReject(async () => {
      await listen({}, next);
      await listen({ agent: null, failure: { code: CONTEXT_OVERFLOW_CODE } }, next);
    });
    assert.equal(nextCalls, 2, "缺字段也必须放行，否则会卡死 waterfall");
  });
});

// ── 启动自证（2026-10-18）────────────────────────────────────────────────
// 目的：让 AUDIT.log 能独立回答"监察层在不在"，而不是靠 status.json 侧面推断。
// 纪律：每进程一次；ready↔degraded 真翻转时才再报。
//
// ⚠ 本 describe 的第一个用例依赖"本进程尚无任何模块报到"（heartbeat 的 MODULES 只增不减，
//   没有清空 API）。node --test 每个文件独立进程、describe 内顺序执行，故成立；
//   若将来新增用例插到它前面并调用了 markModule，需一并调整。
describe("压缩监察 · 启动自证（每进程一次）", () => {
  test("一条缝都没报到 → compaction-watch-degraded，且明写 MISSING 而不是静默", () => {
    resetAudit();
    _resetWatchAnnounce();
    const warns = [];
    const out = announceWatchReady({ warn: (...a) => warns.push(a.join(" ")) });

    assert.equal(out, "degraded", "未报到时不得自称就位");
    const rows = rowsOf("compaction-watch-degraded");
    assert.equal(rows.length, 1);
    assert.equal(rowsOf("compaction-watch-ready").length, 0);
    assert.match(rows[0].evidence, /MISSING/);
    assert.equal(warns.length, 1, "降级必须在宿主日志里喊出来");
  });

  test("两条缝都报到 → 一条 compaction-watch-ready，自带 pid / 缝清单 / 只读标记", () => {
    resetAudit();
    _resetWatchAnnounce();
    for (const k of WATCH_SEAMS) markModule(k, true);
    const warns = [];
    const out = announceWatchReady({ warn: (...a) => warns.push(a.join(" ")) });

    assert.equal(out, "ready");
    const rows = rowsOf("compaction-watch-ready");
    assert.equal(rows.length, 1, "就位只报一条");
    const r = rows[0];
    assert.equal(r.action, "compaction-watch-ready");
    assert.equal(r.trigger, "startup");
    assert.equal(r.scope, "process", "进程级记录必须与会话级留痕可区分");
    assert.equal(r.basis, "fg:compaction-watch");
    assert.equal(r.pid, process.pid);
    assert.equal(r.readonly, true, "自证行必须标明本层只读（没有拦截权）");
    assert.deepEqual(r.watching, WATCH_SEAMS);
    for (const k of WATCH_SEAMS) assert.equal(r.seams[k], "OK");
    assert.equal(r.degraded_modules.length, 0);
    assert.match(r.evidence, /监察层就位/);
    assert.equal(warns.length, 0, "全就位时零噪音");
  });

  test("同一状态重复调用 → 只留一条（每进程一次）", () => {
    resetAudit();
    _resetWatchAnnounce();
    for (const k of WATCH_SEAMS) markModule(k, true);

    announceWatchReady({ warn: noop });
    announceWatchReady({ warn: noop });
    announceWatchReady({ warn: noop });

    assert.equal(rowsOf("compaction-watch-ready").length, 1, "重复宣告不得刷屏");
  });

  test("一条缝 FAIL → degraded，evidence 里带缝名与失败原因", () => {
    resetAudit();
    _resetWatchAnnounce();
    markModule(WATCH_SEAMS[0], true);
    markModule(WATCH_SEAMS[1], false, "boom: no such event");
    const warns = [];
    const out = announceWatchReady({ warn: (...a) => warns.push(a.join(" ")) });

    assert.equal(out, "degraded");
    const [r] = rowsOf("compaction-watch-degraded");
    assert.equal(r.seams[WATCH_SEAMS[1]], "FAIL: boom: no such event");
    assert.deepEqual(r.degraded_modules, [WATCH_SEAMS[1]]);
    assert.match(r.evidence, /agent\/request-error\(compaction-watch\)/);
    assert.match(r.evidence, /boom/);
    assert.equal(warns.length, 1);
  });

  test("degraded → ready 真翻转 → 再报一条（这是状态变化，不是重复）", () => {
    resetAudit();
    _resetWatchAnnounce();
    markModule(WATCH_SEAMS[0], true);
    markModule(WATCH_SEAMS[1], false, "first");
    announceWatchReady({ warn: noop });

    markModule(WATCH_SEAMS[1], true); // 缝补上了
    const out = announceWatchReady({ warn: noop });

    assert.equal(out, "ready");
    assert.equal(rowsOf("compaction-watch-degraded").length, 1);
    assert.equal(rowsOf("compaction-watch-ready").length, 1, "翻转必须留痕");
  });

  test("未传 warn 也不抛（自证失败不能成为新故障点）", () => {
    resetAudit();
    _resetWatchAnnounce();
    for (const k of WATCH_SEAMS) markModule(k, true);
    assert.doesNotThrow(() => announceWatchReady());
    assert.doesNotThrow(() => announceWatchReady({ warn: "not-a-function" }));
  });
});
