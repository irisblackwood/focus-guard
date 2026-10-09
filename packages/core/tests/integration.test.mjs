// FocusGuard · 端到端集成测试（3.0.5）
//
// 链路：模型画像（loadProfile / decide）→ 资格审核（checkEligibility 六层）
//       → 授权（grants）→ pre-execute 闸（gateToolCall）
//
// 纪律：
//   · 审计一律重定向到 tmpdir（FG_AUDIT_FILE），绝不碰真实 AUDIT.log；
//   · 危险命令字面量全部拆分构造（FG 文本层会拦含完整危险字面量的 shell 调用）；
//   · 只读断言，不改任何源码。
// 运行：node --test packages/core/tests/integration.test.mjs

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, rmSync, existsSync } from "node:fs";

// —— 审计沙箱：必须在任何 applyEligibility 调用之前生效 ——
const AUDIT_TMP = join(tmpdir(), `fg-integration-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

import { loadProfile } from "../src/core/profileLoader.mjs";
import { checkEligibility, profileScope } from "../src/core/checkEligibility.mjs";
import { decide } from "../src/core/decisionEngine.mjs";
import { applyEligibility, gateToolCall, grantsFor, resetGrants, gatedReasonOf } from "../src/adapters/dsh/eligibility-gate.mjs";
import { redlineExempt } from "../src/core/redlines.mjs";

after(() => {
  delete process.env.FG_AUDIT_FILE;
  rmSync(AUDIT_TMP, { force: true });
});

// —— 危险字面量：拆分构造 ——
const RM_RF_ROOT = "rm " + "-rf " + "/"; // 递归删除根目录（故意拆分，免得被 FG 文本层自己拦下）
const PUBLISH = "npm publish --access public";

/** 复刻适配层 ABSOLUTE_REDLINES 的形状（母版测试不反向依赖 pipeline.mjs）。 */
const REDLINES = [
  { name: "rm-rf-root", re: /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*(?:r\w*f|f\w*r)\w*\s+["']?[\/~][\/\s"']*(?=\s|["']|$)/ },
  { name: "drop-database", re: /\b(?:drop\s+(?:database|schema)|truncate\s+table)\b/i },
  { name: "git-push-force", re: /\bgit\s+push\b[^\n]*\s(?:-f|--force(?:-with-lease)?)\b/i },
];

const layerLine = (r) => (r.trace || []).map((s) => `L${s.layer}:${s.decision}(${s.reason})`).join(" → ");
const skipNames = (r) => (r.skipped || []).map((s) => s.layer).join(",") || "（无）";

/** 每次调用都先清空该会话的授权表，避免用例间串污。 */
function freshSession(id) {
  resetGrants(id);
  return id;
}

describe("E2E · 模型画像 → 资格审核 → 授权 → pre-execute 闸", () => {
  // ───────────────────────── a. 申请 → 授权 → 闸放行闭环 ─────────────────────────
  describe("a. 申请→授权→闸放行闭环（含 session 隔离）", () => {
    test("a1. fg_apply 通过（L6）→ 同 session gateToolCall 放行 + 授权表落盘", async () => {
      const s = freshSession("it-a1");
      const applied = await applyEligibility({
        session: s,
        tool: "Bash",
        command: PUBLISH,
        purpose: "发布 3.0.5 到 npm",
        scope: "npm registry 上的 focus-guard 包",
        ttl: "turn",
        redlines: REDLINES,
        model: null,
      });
      console.log("[a1] 申请:", applied.decision, applied.layer, "|", layerLine(applied));
      assert.equal(applied.decision, "allow");
      assert.equal(applied.layer, "6");

      const gate = gateToolCall({ session: s, tool: "Bash", command: PUBLISH });
      console.log("[a1] pre-execute 闸:", JSON.stringify(gate));
      assert.equal(gate.kind, "pass");
      assert.equal(gate.granted, true);

      assert.equal(grantsFor(s).has("Bash"), true);
      assert.equal(grantsFor(s).get("Bash").ttl, "turn");

      // 审计确实流经适配层，且只写 tmpdir
      const lines = existsSync(AUDIT_TMP)
        ? readFileSync(AUDIT_TMP, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [];
      console.log("[a1] 审计条数:", lines.length);
      assert.ok(lines.some((l) => l.action === "grant" && l.decision === "allow" && l.layer === "6"), "应有一条 L6 grant 审计");
      resetGrants(s);
    });

    test("a2. 另一 session 无授权 → gateToolCall 拒（理由指向 fg_apply）", async () => {
      const a = freshSession("it-a2-a");
      const b = freshSession("it-a2-b");
      const applied = await applyEligibility({
        session: a,
        tool: "Bash",
        command: PUBLISH,
        purpose: "发布包",
        scope: "npm registry",
        redlines: REDLINES,
        model: null,
      });
      assert.equal(applied.decision, "allow");
      assert.equal(gateToolCall({ session: a, tool: "Bash", command: PUBLISH }).kind, "pass");

      const other = gateToolCall({ session: b, tool: "Bash", command: PUBLISH });
      console.log("[a2] B 会话:", other.kind, "|", other.reason);
      assert.equal(other.kind, "deny", "授权不得跨 session 生效");
      assert.match(other.reason, /fg_apply/);
      assert.equal(grantsFor(b).size, 0);
      resetGrants(a);
      resetGrants(b);
    });
  });

  // ───────────────────────── b. 画像跳层影响结果 ─────────────────────────
  describe("b. 同一「未取证的改动请求」在不同画像下结论不同", () => {
    const WRITE_REQ = {
      tool: "Write",
      command: "overwrite ./tmp/unread-target.txt",
      target: "./tmp/unread-target.txt",
      purpose: "写入目标文件",
      scope: "仅 ./tmp/unread-target.txt",
      state: { readSet: {} },
    };

    test("b1. 不传 profile（对照组）→ L4 生效，未取证 deny", async () => {
      const r = await checkEligibility({ ...WRITE_REQ });
      console.log("[b1] 无画像:", r.decision, r.layer, "|", layerLine(r));
      assert.equal(r.decision, "deny");
      assert.equal(r.layer, "4");
      assert.match(r.reason, /未取证/);
    });

    test("b2. deepseek-flash（七层全开）→ 被 L4 拦（deny，layer 4）", async () => {
      const r = await decide({ modelId: "deepseek-flash", ...WRITE_REQ });
      console.log("[b2] deepseek-flash:", r.decision, r.layer, "| skipped:", skipNames(r), "|", layerLine(r));
      assert.equal(r.profileId, "deepseek-flash");
      assert.equal(r.profileSource, "exact:deepseek-flash");
      assert.equal(r.decision, "deny");
      assert.equal(r.layer, "4");
      assert.match(r.reason, /未取证/);
      assert.equal(r.skipped.length, 0, "全开画像不应跳层");
    });

    test("b3. gpt-astra（evidenceGate off）→ L4 被跳过而放行（layer 6）", async () => {
      const r = await decide({ modelId: "gpt-astra", ...WRITE_REQ });
      console.log("[b3] gpt-astra:", r.decision, r.layer, "| skipped:", skipNames(r), "|", layerLine(r));
      assert.equal(r.profileId, "gpt-astra");
      assert.equal(r.decision, "allow", "L4 被画像关闭后应放行");
      assert.equal(r.layer, "6");
      const l4 = r.trace.find((s) => s.layer === "4");
      assert.equal(l4.decision, "skip");
      assert.equal(l4.reason, "profile:evidenceGate off");
      assert.ok(r.skipped.some((s) => s.layer === "4"), "skipped 清单应含 L4");
      // stalledFuse off / budgetGate on → L1 仍执行，只是子判据收窄
      assert.match(r.trace.find((s) => s.layer === "1").reason, /stalledFuse 子判据已关/);
    });

    test("b4. 适配层入口已接画像（缺陷 1 已修）→ 与 decide() 同结论", async () => {
      // 3.0.6 修复：applyEligibility 新增 profile / modelId 形参并透传给 checkEligibility。
      // 此前画像差异只在 decide() 可达，真实 fg_apply 入口 profile=null、画像全失效。
      const s1 = freshSession("it-b4a");
      const noProfile = await applyEligibility({
        session: s1,
        ...WRITE_REQ,
        ttl: "turn",
        redlines: REDLINES,
        model: null,
      });
      console.log("[b4] 不传画像:", noProfile.decision, noProfile.layer, "|", layerLine(noProfile));
      assert.equal(noProfile.decision, "deny", "不传画像 = 全层启用（最严）");
      assert.equal(noProfile.layer, "4");

      const s2 = freshSession("it-b4b");
      const withModelId = await applyEligibility({
        session: s2,
        ...WRITE_REQ,
        ttl: "turn",
        redlines: REDLINES,
        model: null,
        modelId: "gpt-astra",
      });
      console.log("[b4] 传 modelId=gpt-astra:", withModelId.decision, withModelId.layer, "|", layerLine(withModelId));
      assert.equal(withModelId.decision, "allow", "画像透传后 L4 应被跳过（与 decide() 同结论）");
      assert.equal(withModelId.layer, "6");
      assert.equal(withModelId.trace.find((x) => x.layer === "4").decision, "skip");

      const s3 = freshSession("it-b4c");
      const byObject = await applyEligibility({
        session: s3,
        ...WRITE_REQ,
        ttl: "turn",
        redlines: REDLINES,
        model: null,
        profile: loadProfile("deepseek-flash"),
      });
      console.log("[b4] 直接传 profile 对象（deepseek-flash）:", byObject.decision, byObject.layer);
      assert.equal(byObject.decision, "deny", "也可直接传 profile 对象");
      assert.equal(byObject.layer, "4");
      resetGrants(s1);
      resetGrants(s2);
      resetGrants(s3);
    });
  });

  // ───────────────────────── c. 画像关掉审批层 ─────────────────────────
  describe("c. 审批层不可被画像关闭 + scope 真判定（缺陷 4/5 已修）", () => {
    test("c1. 前提核对：出厂 gpt-astra 的 approvalGate.enabled 为 true，只有 scope 收窄", () => {
      const astra = loadProfile("gpt-astra");
      console.log("[c1] gpt-astra.approvalGate =", JSON.stringify(astra.approvalGate));
      assert.equal(astra.approvalGate.enabled, true, "出厂画像并未关闭审批层");
      assert.equal(astra.approvalGate.scope, "irreversible");
      assert.equal(astra.evidenceGate.enabled, false, "gpt-astra 关的是 evidenceGate / stalledFuse");
      assert.equal(astra.stalledFuse.enabled, false);
    });

    test("c2. scope='irreversible'：非不可逆高危放行，不可逆类仍须审批", async () => {
      const allow = await decide({
        modelId: "gpt-astra",
        tool: "Bash",
        command: PUBLISH,
        purpose: "发布包",
        scope: "npm registry",
        redlines: REDLINES,
      });
      console.log("[c2] astra + publish（非不可逆）:", allow.decision, allow.layer, "|", layerLine(allow));
      assert.equal(allow.decision, "allow", "publish 可撤销，超出 irreversible 审批范围");
      assert.equal(allow.layer, "6");
      assert.match(allow.trace.find((x) => x.layer === "3").reason, /超出审批范围/);

      // 样本选择说明：git push -f 本身是绝对红线，会先被 L2 拦（deny）而到不了 L3，
      // 测不到 scope。Format-Volume 属不可逆类别但不在红线表内，适合验 scope。
      const blocked = await decide({
        modelId: "gpt-astra",
        tool: "Bash",
        command: "Format-Volume -DriveLetter D",
        purpose: "格式化 D 盘",
        scope: "D 盘整卷",
        redlines: REDLINES,
      });
      console.log("[c2] astra + Format-Volume（不可逆）:", blocked.decision, blocked.layer);
      assert.equal(blocked.decision, "needApproval", "不可逆类仍在审批范围内");
      assert.equal(blocked.layer, "3");
    });

    test("c3. 画像试图关闭审批层 → 引擎侧不再绕过（安全项已修）", async () => {
      // 两条防线：① loadProfile 的 enforcePolicy 会强制启用（见 profileLoader 单测）；
      //          ② 母版 L3 已不查 layerEnabled，只认 scope —— 即使画像对象被改坏也拦得住。
      assert.equal(profileScope({ approvalGate: { enabled: false } }), "mutating", "缺 scope 时按最严");
      assert.equal(profileScope({ approvalGate: { enabled: false, scope: "irreversible" } }), "irreversible");

      const s = freshSession("it-c3");
      const r = await checkEligibility({
        tool: "Bash",
        command: PUBLISH,
        purpose: "发布包",
        scope: "npm registry",
        redlines: REDLINES,
        profile: { id: "broken", approvalGate: { enabled: false } }, // 被改坏的画像
      });
      console.log("[c3] 被改坏的画像（enabled:false，无 scope）:", r.decision, r.layer);
      assert.equal(r.decision, "needApproval", "审批层不可被画像关闭");
      assert.equal(r.layer, "3");
      resetGrants(s);
    });

    test("c4. 闸与母版同源：传 profile 后结论一致，未传则按最严", async () => {
      const s = freshSession("it-c4");
      const astra = loadProfile("gpt-astra");

      const decideRes = await decide({
        profile: astra,
        tool: "Bash",
        command: PUBLISH,
        purpose: "发布包",
        scope: "npm registry",
        redlines: REDLINES,
      });
      const gateWith = gateToolCall({ session: s, tool: "Bash", command: PUBLISH, profile: astra });
      console.log("[c4] 传画像：decide =", decideRes.decision, "| 闸 =", JSON.stringify(gateWith));
      assert.equal(decideRes.decision, "allow");
      assert.equal(gateWith.kind, "pass", "闸接线后与母版同源（publish 超出 irreversible 范围）");
      assert.equal(gateWith.outOfScope, true);

      const gateWithout = gateToolCall({ session: s, tool: "Bash", command: PUBLISH });
      console.log("[c4] 不传画像：闸 =", JSON.stringify(gateWithout));
      assert.equal(gateWithout.kind, "deny", "未传 profile → 默认最严 mutating（安全默认，非缺陷）");
      resetGrants(s);
    });
  });

  // ───────────────────────── d. 红线豁免与资格闸的边界 ─────────────────────────
  describe("d. 引号内数据被红线豁免后，资格闸是否仍拦", () => {
    // 危险命令被当作「测试数据」引用 —— 正是红线豁免要救的场景
    const QUOTED = "$samples = @('" + RM_RF_ROOT + "', 'ls -la')";
    const HIT = REDLINES[0];

    test("d1. L2 红线在引号内 → redlineExempt 判为 quoted-literal", () => {
      assert.ok(HIT.re.test(QUOTED), "命令应命中 rm-rf-root 红线");
      const ex = redlineExempt(QUOTED, HIT);
      console.log("[d1] 豁免:", JSON.stringify(ex));
      assert.ok(ex, "引号内字面量应被豁免");
      assert.equal(ex.basis, "quoted-literal");

      // 观测记录（判据归属不稳定）：同一段引号内数据若以 `echo "…"` 形式出现，
      // 红线正则的尾随 `[\/\s"']*` 会吃掉收尾引号，判据1（quoted-literal）落空，
      // 最终由判据3（readonly-head）豁免。豁免结果相同，判据名不同。
      const echoed = 'echo "' + RM_RF_ROOT + '"';
      const ex2 = redlineExempt(echoed, HIT);
      console.log("[d1] 同一数据的 echo 形式:", ex2 && ex2.basis);
      assert.equal(ex2.basis, "readonly-head");
    });

    test("d2. 母版 L2 已接 redlineExempt（缺陷 2 已修）→ 引号内数据不再被 L2 拦", async () => {
      const r = await checkEligibility({
        tool: "Bash",
        command: QUOTED,
        purpose: "把危险命令当测试数据打印",
        scope: "仅终端输出",
        redlines: REDLINES,
      });
      console.log("[d2] 母版 L2:", r.decision, r.layer, "|", layerLine(r));
      const l2 = r.trace.find((x) => x.layer === "2");
      assert.equal(l2.decision, "pass", "L2 命中后应因豁免而降级（不 deny）");
      assert.match(l2.reason, /红线豁免降级（quoted-literal）/);
      // 降级后继续往下：命令文本仍命中 HIGH_RISK_TOOLS 的 rm-rf 且无授权 → L3 转人工审批（缺陷 3 未修，属预期）
      assert.equal(r.decision, "needApproval");
      assert.equal(r.layer, "3");
    });

    test("d3. pre-execute 闸也不接豁免 → 同一命令被拦（命中 rm-rf，指向 fg_apply）", () => {
      const s = freshSession("it-d3");
      const reason = gatedReasonOf("Bash", QUOTED);
      const gate = gateToolCall({ session: s, tool: "Bash", command: QUOTED });
      console.log("[d3] 门槛:", reason, "| 闸:", gate.kind, "|", gate.reason);
      assert.equal(reason, "rm-rf", "HIGH_RISK_TOOLS 只看文本，不看引号");
      assert.equal(gate.kind, "deny");
      assert.match(gate.reason, /fg_apply/);
      assert.match(gate.reason, /rm-rf/);
      resetGrants(s);
    });

    test("d4. 对照：无引号的真执行命令同样不豁免，且闸拦", () => {
      assert.equal(redlineExempt(RM_RF_ROOT, HIT), null, "真执行不得豁免");
      assert.equal(gateToolCall({ session: freshSession("it-d4"), tool: "Bash", command: RM_RF_ROOT }).kind, "deny");
      console.log("[d4] 真执行: 不豁免 + 闸 deny（一致）");
    });
  });

  // ───────────────────────── e. 授权回收 ─────────────────────────
  describe("e. 授权回收：resetGrants 后同一命令再执行被拒", () => {
    test("e1. apply → 闸放行 → resetGrants → 同命令 deny", async () => {
      const s = freshSession("it-e1");
      const applied = await applyEligibility({
        session: s,
        tool: "Bash",
        command: PUBLISH,
        purpose: "发布包",
        scope: "npm registry",
        ttl: "turn",
        redlines: REDLINES,
        model: null,
      });
      assert.equal(applied.decision, "allow");
      assert.equal(gateToolCall({ session: s, tool: "Bash", command: PUBLISH }).kind, "pass");

      const removed = resetGrants(s);
      console.log("[e1] resetGrants 返回:", removed, "| 表大小:", grantsFor(s).size);
      assert.equal(removed, true);
      assert.equal(grantsFor(s).size, 0, "回收后必须是一张空表");

      const after = gateToolCall({ session: s, tool: "Bash", command: PUBLISH });
      console.log("[e1] 回收后闸:", after.kind, "|", after.reason);
      assert.equal(after.kind, "deny");
      assert.match(after.reason, /fg_apply/);
      resetGrants(s);
    });

    test("e2. 回收后重新申请仍可放行（闭环可重入）", async () => {
      const s = freshSession("it-e2");
      const req = {
        session: s,
        tool: "Bash",
        command: PUBLISH,
        purpose: "重新申请发布",
        scope: "npm registry",
        ttl: "turn",
        redlines: REDLINES,
        model: null,
      };
      assert.equal((await applyEligibility(req)).decision, "allow");
      resetGrants(s);
      assert.equal(gateToolCall({ session: s, tool: "Bash", command: PUBLISH }).kind, "deny");
      assert.equal((await applyEligibility(req)).decision, "allow");
      assert.equal(gateToolCall({ session: s, tool: "Bash", command: PUBLISH }).kind, "pass");
      console.log("[e2] 回收→重申请→放行: 闭环可重入");
      resetGrants(s);
    });
  });
});

describe("f. 最后一公里 · 画像经 exec 在真实 pre-execute 生效", () => {
  const loadPipeline = () => import("../src/dsh/pipeline.mjs");
  const allowNext = () => ({ kind: "allow" });

  test("f1. exec.agent.model=gpt-astra → 闸按 scope 放行 publish（画像真生效）", async () => {
    const { preExecuteListener } = await loadPipeline();
    const s = freshSession("it-f1");
    const listener = preExecuteListener({ warn: () => {} });
    const exec = {
      name: "Bash",
      arguments: { command: PUBLISH },
      agent: { model: "gpt-astra" },
      sessionId: s,
    };
    const out = await listener(exec, allowNext);
    console.log("[f1] astra 经 exec:", JSON.stringify(out));
    assert.equal(out.kind, "allow", "画像生效 → publish 超出 irreversible 范围 → 放行到 next");
    resetGrants(s);
  });

  test("f2. exec 无模型字段 → 最严 mutating，仍拦（安全默认）", async () => {
    const { preExecuteListener } = await loadPipeline();
    const s = freshSession("it-f2");
    const listener = preExecuteListener({ warn: () => {} });
    const exec = { name: "Bash", arguments: { command: PUBLISH }, sessionId: s };
    const out = await listener(exec, allowNext);
    console.log("[f2] 无模型:", JSON.stringify(out));
    assert.equal(out.kind, "deny", "取不到画像 → 最严 mutating");
    assert.match(out.reason, /fg_apply/);
    resetGrants(s);
  });

  test("f3. FG_MODEL_ID 作显式兜底同样生效", async () => {
    const { preExecuteListener } = await loadPipeline();
    const s = freshSession("it-f3");
    process.env.FG_MODEL_ID = "gpt-astra";
    try {
      const listener = preExecuteListener({ warn: () => {} });
      const exec = { name: "Bash", arguments: { command: PUBLISH }, sessionId: s };
      const out = await listener(exec, allowNext);
      console.log("[f3] FG_MODEL_ID 兜底:", JSON.stringify(out));
      assert.equal(out.kind, "allow");
    } finally {
      delete process.env.FG_MODEL_ID;
      resetGrants(s);
    }
  });

  test("f4. 红线层不受画像影响：gpt-astra 下裸危险命令照样 deny", async () => {
    const { preExecuteListener } = await loadPipeline();
    const s = freshSession("it-f4");
    const listener = preExecuteListener({ warn: () => {} });
    const exec = {
      name: "Bash",
      arguments: { command: RM_RF_ROOT },
      agent: { model: "gpt-astra" },
      sessionId: s,
    };
    const out = await listener(exec, allowNext);
    console.log("[f4] astra + 红线:", JSON.stringify(out).slice(0, 140));
    assert.equal(out.kind, "deny", "红线层不含画像开关（不可被画像放行）");
    assert.match(out.reason, /绝对红线/);
    resetGrants(s);
  });
});
