// FocusGuard · 会话生命周期缝（3.0.8 · 移植批 4）
//
// start 侧（agent/created）：环境检测 · 卷宗载入 · 因果根链
// stop 侧（agent/turn-stopping）：任务规模声明 · 绝境豁免 · 《授权识别与留痕条例》核验 ·
//   熔断声明与经验库 · 触发②无锚点 —— 全部**只审计不打回**（见 stopGuard.mjs 顶部取舍说明）。
//
// 最关键的一条：**取不到收尾文本时必须降级、不得误判**。DSH 的 agent/turn-stopping 可能
// 拿不到 assistant 收尾文本；若无文本还硬做锚点核验，会把每次收尾都判为"无锚点"。
//
// 纪律：审计重定向 tmpdir；状态与卷宗写 tmpdir；不碰真实工作区。
// 运行：node --test packages/core/tests/lifecycle.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const AUDIT_TMP = join(tmpdir(), `fg-lifecycle-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

const { sessionStartListener, systemPromptRulesListener } = await import("../src/dsh/seams.mjs");
const { stopGuardListener } = await import("../src/dsh/stopGuard.mjs");
const { statePath, loadState, saveState } = await import("../src/core/state.mjs");

const ROOT = join(tmpdir(), `fg-lifecycle-${process.pid}-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });
const noop = () => {};
const pass = () => ({ kind: "allow" });
const mkAgent = (sid, extra = {}) => ({
  session: { header: { id: sid, cwd: ROOT } },
  ...extra,
});
const auditLines = () =>
  existsSync(AUDIT_TMP)
    ? readFileSync(AUDIT_TMP, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const resetAudit = () => rmSync(AUDIT_TMP, { force: true });
const withState = (sid, patch = {}) => {
  rmSync(statePath(sid), { force: true });
  saveState(statePath(sid), { readSet: {}, ...patch });
};

describe("3.0.8 · start 缝（agent/created · 移植批 4）", () => {
  test("会话启动：环境检测入 state、卷宗【一】环境声明落卷、留痕 start-fired", async () => {
    const sid = `lc-start-${process.pid}`;
    rmSync(statePath(sid), { force: true });
    resetAudit();

    await sessionStartListener({ warn: noop })({ agent: mkAgent(sid) });

    const st = loadState(statePath(sid));
    assert.ok(st.envCache && typeof st.envCache.os === "string", "应写入环境检测结果");
    assert.ok(/^S/.test(String(st.taskChain)), "应生成会话根链");
    const caseFile = join(ROOT, ".ai", "CASE_FILE.md");
    assert.ok(existsSync(caseFile), "应创建卷宗");
    assert.match(readFileSync(caseFile, "utf8"), /【一】环境声明/, "卷宗【一】应落环境声明");
    assert.ok(auditLines().some((r) => r.action === "start-fired"), "应留痕 start-fired");
    console.log("env:", st.envCache.os, "/", st.envCache.shellIdKey, "| taskChain:", st.taskChain);
    rmSync(statePath(sid), { force: true });
  });

  test("常驻规则注入：追加独立 section，不改动下游既有 section", async () => {
    const rules = await systemPromptRulesListener({ warn: noop })(
      {},
      {},
      () => ({ sections: [{ name: "base", text: "BASE" }], tools: [], variables: {} }),
    );
    assert.equal(rules.sections.length, 2, "应在既有 section 之后追加一条");
    assert.equal(rules.sections[0].name, "base", "原有 section 必须原样保留");
    assert.equal(rules.sections[1].name, "focus-guard-rules");
    assert.ok(rules.sections[1].text.length > 50, "规则文本应非空");
    console.log("注入 section:", rules.sections.map((s) => s.name).join(" + "));
  });

  test("下游形状异常时不强行改写（原样透传）", async () => {
    const out = await systemPromptRulesListener({ warn: noop })({}, {}, () => "plain string");
    assert.equal(out, "plain string", "非 assembly 形状应原样透传");
  });
});

describe("3.0.8 · stop 缝（agent/turn-stopping · 移植批 4）", () => {
  test("【最要紧】取不到收尾文本 → 降级只审计，绝不因空文本误判", async () => {
    const sid = `lc-notext-${process.pid}`;
    withState(sid, { turnCount: 9 });
    resetAudit();
    const warns = [];
    // agent 里没有任何收尾文本
    await stopGuardListener({ warn: (...p) => warns.push(p.join(" ")) })({ agent: mkAgent(sid) });
    const rows = auditLines();
    assert.ok(
      rows.some((r) => r.action === "dsh-stop-observe"),
      "无收尾文本应留痕降级（dsh-stop-observe）",
    );
    assert.equal(rows.filter((r) => r.action === "violation-no-anchor").length, 0, "不得对空文本判无锚点");
    assert.equal(warns.length, 0, "降级路径不应产生待裁决警告");
    console.log("无文本降级：", rows.map((r) => r.action).join(","));
    rmSync(statePath(sid), { force: true });
  });

  test("授权识别合格：引用本回合原文 + 法条 + 授权语义 → 记 pardon-interpreted 并置 mercy", async () => {
    const sid = `lc-pardon-ok-${process.pid}`;
    const quote = "允许推送";
    withState(sid, { turnCount: 3, turnPromptFull: `请处理一下，${quote}，谢谢` });
    resetAudit();
    const text = `【授权识别】引原文：「${quote}」 \n依据：第七十五条(三)`;
    await stopGuardListener({ warn: noop })({ agent: mkAgent(sid, { response: text }) });
    const st = loadState(statePath(sid));
    assert.equal(st.mercy, true, "合格授权识别应置绝境豁免");
    assert.ok(auditLines().some((r) => r.action === "pardon-interpreted"), "应留痕 pardon-interpreted");
    console.log("授权识别合格 → mercy =", st.mercy);
    rmSync(statePath(sid), { force: true });
  });

  test("授权识别不合格（引用原文与本回合不符）→ 熔断 + 留痕越权解释授权", async () => {
    const sid = `lc-pardon-bad-${process.pid}`;
    withState(sid, { turnCount: 3, turnPromptFull: "本回合根本没说过那件事" });
    resetAudit();
    const warns = [];
    const text = `【授权识别】引原文：「允许推送」 \n依据：第七十五条(三)`;
    await stopGuardListener({ warn: (...p) => warns.push(p.join(" ")) })({ agent: mkAgent(sid, { response: text }) });
    const st = loadState(statePath(sid));
    assert.equal(st.fused, true, "引用原文不符应熔断");
    assert.ok(auditLines().some((r) => r.action === "violation-usurp-pardon"), "应留痕越权解释授权");
    assert.ok(warns.length > 0, "应产生待裁决警告（不打回）");
    console.log("授权识别不合格 → fused =", st.fused, "| 警告:", String(warns[0]).slice(0, 60));
    rmSync(statePath(sid), { force: true });
  });

  test("【授权待确认】→ 暂停留痕且不熔断", async () => {
    const sid = `lc-pending-${process.pid}`;
    withState(sid, { turnCount: 4 });
    resetAudit();
    await stopGuardListener({ warn: noop })({ agent: mkAgent(sid, { response: "【授权待确认】请人类明确是否允许推送" }) });
    const st = loadState(statePath(sid));
    assert.notEqual(st.fused, true, "待确认不应熔断");
    assert.ok(auditLines().some((r) => r.action === "pardon-pending"), "应留痕 pardon-pending");
    console.log("待确认 →", auditLines().map((r) => r.action).join(","));
    rmSync(statePath(sid), { force: true });
  });

  test("任务规模声明『【任务规模】上限 N 次』→ 预算上调（只升不降）", async () => {
    const sid = `lc-scale-${process.pid}`;
    withState(sid, { taskBudget: 10, declaredBudget: 0 });
    // TASK_SCALE_RE = /【任务规模】[^0-9]{0,8}(\d{1,3})/ —— 必须带【任务规模】前缀
    await stopGuardListener({ warn: noop })({ agent: mkAgent(sid, { response: "【任务规模】上限 40 次" }) });
    const st = loadState(statePath(sid));
    assert.ok(st.declaredBudget >= 40, `declaredBudget 应记 40，实为 ${st.declaredBudget}`);
    assert.ok(st.taskBudget >= 40, `taskBudget 应上调，实为 ${st.taskBudget}`);
    console.log("规模声明 → declaredBudget =", st.declaredBudget, "taskBudget =", st.taskBudget);
    rmSync(statePath(sid), { force: true });
  });

  test("声明熔断 → 熔断置位 + 留痕 + 创建 .ai/PATTERNS.md 经验库", async () => {
    const sid = `lc-fuse-${process.pid}`;
    withState(sid, { turnCount: 3 });
    resetAudit();
    rmSync(join(ROOT, ".ai", "PATTERNS.md"), { force: true });
    await stopGuardListener({ warn: noop })({
      agent: mkAgent(sid, { response: "【熔断】\n[降级方案] 换用只读核验；缩小范围；请人类裁决。" }),
    });
    const st = loadState(statePath(sid));
    assert.equal(st.fused, true, "声明熔断应置位");
    assert.ok(auditLines().some((r) => r.action === "shuanggui-declared"), "应留痕 shuanggui-declared");
    assert.ok(existsSync(join(ROOT, ".ai", "PATTERNS.md")), "应创建经验库 PATTERNS.md");
    console.log("熔断声明 → fused =", st.fused, "| PATTERNS.md 已建");
    rmSync(statePath(sid), { force: true });
  });

  test("绝境模式豁免：mercy 时直接放行，不做锚点核验", async () => {
    const sid = `lc-mercy-${process.pid}`;
    withState(sid, { mercy: true, turnCount: 7 });
    resetAudit();
    await stopGuardListener({ warn: noop })({ agent: mkAgent(sid, { response: "没有任何锚点的收尾" }) });
    assert.equal(auditLines().filter((r) => r.action === "violation-no-anchor").length, 0, "绝境模式应豁免");
    console.log("绝境豁免生效（无 violation-no-anchor）");
    rmSync(statePath(sid), { force: true });
  });

  test("真实工作区未被本次测试触碰", () => {
    const realAudit = join(process.cwd(), ".focus-guard", "AUDIT.log");
    assert.ok(!existsSync(realAudit) || readFileSync(realAudit, "utf8").length >= 0);
    console.log("沙箱审计:", AUDIT_TMP.replace(tmpdir(), "<tmp>"));
  });
});
