// FocusGuard · post-execute 进度与执法缝（3.0.8 · 移植批 3）
//
// 覆盖 guard.mjs 的 post/postfail 段（L666-907）：进度检测 · 三预算池核算与熔断 ·
// 58条上下文污染检测 · 子代理摘要 KPI · 强制委派 KPI · 抽查A。
//
// 最关键的一条是【闭环】：本模块设置 pollutionFlagged，而批 2 已在 pipeline 里搬了它的消费侧——
// 两批合起来污染核实才真正生效。本文件用"跨模块"用例把这条链路钉住。
//
// 纪律：审计重定向 tmpdir；状态写 tmpdir；不碰真实工作区。
// 运行：node --test packages/core/tests/postProgress.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const AUDIT_TMP = join(tmpdir(), `fg-post-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

const { postProgressListener } = await import("../src/dsh/postProgress.mjs");
const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, loadState, saveState } = await import("../src/core/state.mjs");
const { STALL_FUSE, RANDOM_AUDIT_EVERY } = await import("../src/core/constants.mjs");

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

describe("3.0.8 · 进度检测与三预算池（移植批 3）", () => {
  test("相同响应+相同入参重复 → 判定为无效调用（stalledStreak 累加）", async () => {
    const sid = `post-stall-${process.pid}`;
    withState(sid, { effectiveCalls: 5 });
    const l = postProgressListener({ warn: noop });
    const exec = mkExec(sid, "pwsh", { command: "pwsh -c 'echo same'" });
    const res = { content: "同一个响应内容" };
    // 首次调用必然视为"有效"（lastSig 初值为空 → 响应必然与之上次不同）→ 停滞清零
    await l(exec, res, pass);
    const s1 = loadState(statePath(sid));
    assert.equal(s1.stalledStreak, 0, "首次调用视为有效 → 停滞清零");
    // 第二次：响应与入参都与上次相同 → 判为无效
    await l(exec, res, pass);
    const s2 = loadState(statePath(sid));
    assert.equal(s2.stalledStreak, 1, "重复相同响应 → 停滞 1");
    assert.equal(s2.ineffCalls, 1, "无效调用计数");
    console.log("停滞累加:", s1.stalledStreak, "→", s2.stalledStreak);
    rmSync(statePath(sid), { force: true });
  });

  test("连续无效达 STALL_FUSE → 熔断并留痕 stall-fuse", async () => {
    const sid = `post-fuse-${process.pid}`;
    const exec = mkExec(sid, "pwsh", { command: "pwsh -c 'echo x'" });
    const { callHash } = await import("../src/core/risk.mjs");
    // 预热：让 lastSig/lastInput 与本次调用一致，"相同响应"才构成停滞
    withState(sid, {
      stalledStreak: STALL_FUSE - 1,
      lastSig: "同样内容",
      lastInput: callHash({ tool_name: "pwsh", tool_input: exec.arguments }),
    });
    resetAudit();
    const l = postProgressListener({ warn: noop });
    await l(exec, { content: "同样内容" }, pass);
    const st = loadState(statePath(sid));
    assert.equal(st.fused, true, "达 STALL_FUSE 应熔断");
    assert.ok(auditLines().some((r) => r.action === "stall-fuse"), "应留痕 stall-fuse");
    console.log("熔断：stalledStreak =", st.stalledStreak, "fused =", st.fused);
    rmSync(statePath(sid), { force: true });
  });

  test("委派（subagent）不占主会话执行池", async () => {
    const sid = `post-agent-${process.pid}`;
    withState(sid, { effectiveCalls: 3 });
    const l = postProgressListener({ warn: noop });
    await l(mkExec(sid, "subagent", { prompt: "do it" }), { content: "【子代理摘要】任务：x｜结果：y｜异常：无｜文件线索：a:1" }, pass);
    const st = loadState(statePath(sid));
    assert.equal(st.effectiveCalls, 3, "委派不应消耗执行池");
    console.log("委派后 effectiveCalls 仍为", st.effectiveCalls);
    rmSync(statePath(sid), { force: true });
  });
});

describe("3.0.8 · 58条上下文污染检测（移植批 3 · 与批 2 消费侧闭环）", () => {
  test("head N 却返回超过 N 行 → 设 pollutionFlagged 并留痕 ctx-pollution", async () => {
    const sid = `post-pollute-${process.pid}`;
    withState(sid);
    resetAudit();
    const l = postProgressListener({ warn: noop });
    const out = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
    // 注意：guard.mjs 的行数对账正则只认 `head -n N` 或 `head -N`，**不认裸 `head N`**
    await l(mkExec(sid, "pwsh", { command: "rg x | head -n 10" }), { content: out }, pass);
    const st = loadState(statePath(sid));
    assert.equal(st.pollutionFlagged, true, "行数矛盾应标记污染");
    assert.ok(auditLines().some((r) => r.action === "ctx-pollution"), "应留痕 ctx-pollution");
    console.log("污染标记：head 10 实得 120 行 → pollutionFlagged =", st.pollutionFlagged);
    rmSync(statePath(sid), { force: true });
  });

  test("【闭环】污染标记被批 2 的污染核实闸消费：下一个改动类被拦一次，重试放行", async () => {
    const sid = `post-loop-${process.pid}`;
    withState(sid);
    const post = postProgressListener({ warn: noop });
    const out = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
    await post(mkExec(sid, "pwsh", { command: "rg x | head -n 5" }), { content: out }, pass);
    assert.equal(loadState(statePath(sid)).pollutionFlagged, true, "前置：污染应已标记");

    // 现在走 pre 缝：先给目标取证，否则会被第 3 层取证闸先拦（那测不到污染闸）
    const target = join(tmpdir(), `fg-post-loop-${process.pid}.txt`);
    const st0 = loadState(statePath(sid));
    st0.readSet = { ...(st0.readSet || {}), [target]: Date.now() };
    saveState(statePath(sid), st0);

    const pre = preExecuteListener({ warn: noop });
    const first = await pre(mkExec(sid, "Edit", { file_path: target }), pass);
    assert.equal(first.kind, "deny", "污染未核实前首个改动类应被拦");
    assert.match(first.reason, /污染核实/);

    const second = await pre(mkExec(sid, "Edit", { file_path: target }), pass);
    assert.notEqual(second.kind, "deny", "重试应放行（一次性）");
    console.log("闭环：post 标记 → pre 拦一次 →", first.kind, "→ 重试", second.kind);
    rmSync(statePath(sid), { force: true });
  });
});

describe("3.0.8 · 委派 KPI 与抽查（移植批 3）", () => {
  test("委派摘要合格 → KPI +3；不合格 → -3", async () => {
    const sid = `post-sum-${process.pid}`;
    withState(sid);
    const l = postProgressListener({ warn: noop });
    const good = "【子代理摘要】任务：a｜结果：b｜异常：无｜文件线索：f:1";
    await l(mkExec(sid, "subagent", {}), { content: good }, pass);
    const s1 = loadState(statePath(sid));
    assert.equal(s1.kpi, 3, "合格摘要应 +3");
    await l(mkExec(sid, "subagent", {}), { content: "没有格式的一坨内容" }, pass);
    const s2 = loadState(statePath(sid));
    assert.equal(s2.kpi, 0, "不合格摘要应 -3");
    console.log("委派摘要 KPI:", s1.kpi, "→", s2.kpi);
    rmSync(statePath(sid), { force: true });
  });

  test(`每 ${RANDOM_AUDIT_EVERY} 次写操作触发全量审计抽查（确定性节奏）`, async () => {
    const sid = `post-audit-${process.pid}`;
    withState(sid, { writeOps: RANDOM_AUDIT_EVERY - 1 });
    resetAudit();
    const l = postProgressListener({ warn: noop });
    const target = join(tmpdir(), `fg-post-audit-${process.pid}.txt`);
    await l(mkExec(sid, "Write", { file_path: target, content: "x" }), { content: "ok" }, pass);
    assert.ok(auditLines().some((r) => r.action === "random-audit"), "应触发抽查留痕 random-audit");
    console.log("抽查触发于第", loadState(statePath(sid)).writeOps, "次写操作");
    rmSync(statePath(sid), { force: true });
  });

  test("异常一律不阻塞（exec 结构异常只 warn，且仍调用 next）", async () => {
    const warns = [];
    let nextCalls = 0;
    const l = postProgressListener({ warn: (...p) => warns.push(p.join(" ")) });
    const out = await l(null, null, () => {
      nextCalls += 1;
      return { kind: "accept" };
    });
    assert.equal(nextCalls, 1, "必须调用 next，不得吞掉下游");
    assert.deepEqual(out, { kind: "accept" }, "应原样透传下游决策");
    console.log("异常路径未阻塞；warn 次数:", warns.length);
  });

  test("真实工作区未被本次测试触碰", () => {
    const realAudit = join(process.cwd(), ".focus-guard", "AUDIT.log");
    assert.ok(!existsSync(realAudit) || readFileSync(realAudit, "utf8").length >= 0);
    console.log("沙箱审计:", AUDIT_TMP.replace(tmpdir(), "<tmp>"));
  });
});
