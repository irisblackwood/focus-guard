// FocusGuard · 反规避随机检查点（抽查B，2026-10-19 人类批示）
//
// 覆盖四件事：
//   ① 默认关闭：不设环境变量时，写操作不计数、不挂检查点、不写 random-fuse 行
//   ② 独立参数：FG_RANDOM_FUSE_EVERY=N 固定间隔；FG_RANDOM_FUSE=1 间隔在 [2,5] 随机
//   ③ 消费语义：post-execute 只「挂检查点」（那次写已发生），pre-execute 第 3 层对下一次变更拒**一次**，
//      审计 trigger 记 `random-fuse`（不是 evidence-gate）
//   ④ 与抽查A 完全独立：只开抽查B 时不会产生 random-audit 行；换回合作废检查点、保留计数
//
// 纪律：审计重定向 tmpdir；状态写 tmpdir；不碰真实工作区。
// 运行：node --test packages/core/tests/random-fuse.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const AUDIT_TMP = join(tmpdir(), `fg-randfuse-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

const { postProgressListener, randomFuseInterval } = await import("../src/dsh/postProgress.mjs");
const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { preStepListener } = await import("../src/dsh/seams.mjs");
const { statePath, loadState, saveState } = await import("../src/core/state.mjs");
const { RANDOM_FUSE_MIN, RANDOM_FUSE_MAX, RANDOM_AUDIT_EVERY } = await import("../src/core/constants.mjs");

const noop = () => {};
const pass = () => ({ kind: "allow" });
const mkAgent = (sid) => ({ session: { header: { id: sid, cwd: process.cwd() } } });
const mkExec = (sid, name, args) => ({ sessionId: sid, agent: mkAgent(sid), name, arguments: args });
const auditLines = () =>
  existsSync(AUDIT_TMP)
    ? readFileSync(AUDIT_TMP, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const resetAudit = () => rmSync(AUDIT_TMP, { force: true });
const withState = (sid, patch = {}) => {
  rmSync(statePath(sid), { force: true });
  saveState(statePath(sid), { readSet: {}, ...patch });
};
const clearEnv = () => {
  delete process.env.FG_RANDOM_FUSE;
  delete process.env.FG_RANDOM_FUSE_EVERY;
};

describe("反规避抽查B · 随机检查点", () => {
  test("r1. 默认关闭：写操作不计数、不挂检查点、无 random-fuse 行", async () => {
    clearEnv();
    assert.equal(randomFuseInterval(), null, "默认必须关闭");
    const sid = `rf-off-${process.pid}`;
    withState(sid);
    resetAudit();
    const l = postProgressListener({ warn: noop });
    for (let i = 0; i < 4; i += 1) {
      await l(mkExec(sid, "Write", { file_path: join(tmpdir(), `rf-off-${i}.txt`), content: "x" }), { content: "ok" }, pass);
    }
    const st = loadState(statePath(sid));
    assert.equal(st.fuseOps, undefined, "关着就不该计数");
    assert.equal(st.randomFusePending, undefined, "关着就不该挂检查点");
    assert.equal(auditLines().filter((r) => r.action === "random-fuse").length, 0);
    rmSync(statePath(sid), { force: true });
  });

  test("r2. FG_RANDOM_FUSE_EVERY=2 → 第 3 次写操作命中检查点（间隔 2 次后查）", async () => {
    clearEnv();
    process.env.FG_RANDOM_FUSE_EVERY = "2";
    const sid = `rf-fixed-${process.pid}`;
    withState(sid);
    resetAudit();
    const l = postProgressListener({ warn: noop });
    const run = (i) =>
      l(mkExec(sid, "Write", { file_path: join(tmpdir(), `rf-fixed-${i}.txt`), content: "x" }), { content: "ok" }, pass);
    await run(0);
    assert.equal(loadState(statePath(sid)).randomFusePending, undefined, "第 1 次不触发");
    await run(1);
    assert.equal(loadState(statePath(sid)).randomFusePending, undefined, "第 2 次不触发");
    await run(2);
    const st = loadState(statePath(sid));
    console.log("[r2] fuseOps =", st.fuseOps, "pending =", st.randomFusePending);
    assert.equal(st.randomFusePending, true, "第 3 次应挂检查点");
    const row = auditLines().find((r) => r.action === "random-fuse");
    assert.ok(row, "应留痕 random-fuse");
    assert.match(row.evidence, /第 3 次写操作/, "证据里要有写操作序号");
    clearEnv();
    rmSync(statePath(sid), { force: true });
  });

  test("r3. pre-execute 消费检查点：拒一次 → 重试放行；审计 trigger 是 random-fuse", async () => {
    clearEnv();
    const sid = `rf-consume-${process.pid}`;
    withState(sid, { randomFusePending: true, randomFuseAt: 3 });
    resetAudit();
    const l = preExecuteListener({ warn: noop });
    const target = join(tmpdir(), `rf-new-${process.pid}.txt`);
    rmSync(target, { force: true }); // 新文件：不触发取证闸，变量收敛到抽查B
    const exec = mkExec(sid, "Write", { file_path: target, content: "x" });

    const first = await l(exec, pass);
    console.log("[r3] first =", JSON.stringify(first).slice(0, 160));
    assert.equal(first.kind, "deny", "检查点应拒一次");
    assert.match(first.reason, /反规避抽查B/);
    const denyRow = auditLines().find((r) => r.action === "deny");
    assert.equal(denyRow.trigger, "random-fuse", "审计要能回答「为什么被拦」");

    const second = await l(exec, pass);
    assert.equal(second.kind, "allow", "重试必须放行（只拒一次，不做死锁）");
    rmSync(statePath(sid), { force: true });
  });

  test("r4. 与抽查A 完全独立：只开抽查B 时不产生 random-audit", async () => {
    clearEnv();
    process.env.FG_RANDOM_FUSE_EVERY = "2";
    const sid = `rf-indep-${process.pid}`;
    withState(sid, { writeOps: RANDOM_AUDIT_EVERY - 2 }); // 抽查A 差 2 次就满
    resetAudit();
    const l = postProgressListener({ warn: noop });
    await l(mkExec(sid, "Write", { file_path: join(tmpdir(), `rf-indep-${process.pid}.txt`), content: "x" }), { content: "ok" }, pass);
    const rows = auditLines();
    assert.equal(rows.filter((r) => r.action === "random-audit").length, 0, "抽查A 的节拍不该被抽查B 搅动");
    clearEnv();
    rmSync(statePath(sid), { force: true });
  });

  test("r5. 换回合作废检查点、保留计数（计数是会话级，检查点是回合级）", async () => {
    clearEnv();
    const sid = `rf-reset-${process.pid}`;
    withState(sid, { randomFusePending: true, randomFuseAt: 3, fuseOps: 7, fuseNextAt: 9 });
    await preStepListener({ warn: noop })({ agent: mkAgent(sid), messages: [], turn: 2, step: 1 }, () => ({ kind: "allow" }));
    const st = loadState(statePath(sid));
    assert.equal(st.randomFusePending, false, "换回合应作废检查点");
    assert.equal(st.fuseOps, 7, "写操作计数是会话级，保留");
    assert.equal(st.fuseNextAt, 9, "阈值保留，避免换回合就重置成'刚查过'");
    rmSync(statePath(sid), { force: true });
  });

  test("r6. 随机模式：间隔落在 [2,5]，两端都能取到", () => {
    clearEnv();
    process.env.FG_RANDOM_FUSE = "1";
    const itv = randomFuseInterval();
    assert.equal(itv.kind, "random");
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const n = itv.pick();
      assert.ok(n >= RANDOM_FUSE_MIN && n <= RANDOM_FUSE_MAX, `间隔 ${n} 越界`);
      seen.add(n);
    }
    console.log("[r6] 取到的间隔值 =", [...seen].sort().join(","));
    assert.ok(seen.has(RANDOM_FUSE_MIN) && seen.has(RANDOM_FUSE_MAX), "两端都应出现（200 次抽样）");
    clearEnv();
  });
});
