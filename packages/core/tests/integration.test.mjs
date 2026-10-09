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
import { checkEligibility } from "../src/core/checkEligibility.mjs";
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

    test("b4. 【缺陷】适配层 fg_apply 入口无 profile 入参 → 画像在真实入口完全失效", async () => {
      // applyEligibility 形参里没有 profile，也没有向 checkEligibility 透传 profile，
      // 因此 fg_apply 实际执行时 profile=null（全层启用），与 b2/b3 的 decide() 结论分叉。
      const s = freshSession("it-b4");
      const r = await applyEligibility({
        session: s,
        ...WRITE_REQ,
        ttl: "turn",
        redlines: REDLINES,
        model: null,
      });
      console.log("[b4] 适配层入口（无法传画像）:", r.decision, r.layer, "|", layerLine(r));
      assert.equal(r.decision, "deny", "适配层入口在两种画像下都会 deny —— 画像未被读取");
      assert.equal(r.layer, "4");
      resetGrants(s);
    });
  });

  // ───────────────────────── c. 画像关掉审批层 ─────────────────────────
  describe("c. approvalGate 关闭时资格闸是否被绕过", () => {
    // 前提核对：任务描述称 gpt-astra 有 approvalGate.enabled=false —— 与源码不符，如实记录。
    test("c1. 前提核对：出厂 gpt-astra 的 approvalGate.enabled 实为 true（只有 scope 收窄）", () => {
      const astra = loadProfile("gpt-astra");
      console.log("[c1] gpt-astra.approvalGate =", JSON.stringify(astra.approvalGate));
      assert.equal(astra.approvalGate.enabled, true, "出厂画像并未关闭审批层");
      assert.equal(astra.approvalGate.scope, "irreversible");
      assert.equal(astra.evidenceGate.enabled, false, "gpt-astra 关的是 evidenceGate / stalledFuse");
      assert.equal(astra.stalledFuse.enabled, false);
    });

    test("c2. 出厂 gpt-astra 下 npm publish → L3 未被跳过，needApproval", async () => {
      const r = await decide({
        modelId: "gpt-astra",
        tool: "Bash",
        command: PUBLISH,
        purpose: "发布包",
        scope: "npm registry",
        redlines: REDLINES,
      });
      console.log("[c2] gpt-astra + publish:", r.decision, r.layer, "| skipped:", skipNames(r), "|", layerLine(r));
      assert.equal(r.decision, "needApproval");
      assert.equal(r.layer, "3");
      assert.equal(r.skipped.some((s) => s.layer === "3"), false, "L3 未被跳过");
      // scope:'irreversible' 是死配置：引擎只读 .enabled，任何高危命中一律 needApproval
      assert.equal(r.trace.find((s) => s.layer === "3").reason.includes("publish"), true);
    });

    // 合成画像：出厂 5 份画像**没有任何一份**关闭 approvalGate，故手工构造以压测该分支。
    const ASTRA_NO_APPROVAL = { ...loadProfile("gpt-astra"), approvalGate: { enabled: false } };

    test("c3. 合成「approvalGate off」画像 → L3 跳过 + 闸放行：审批被端到端绕过", async () => {
      const s = freshSession("it-c3");
      const r = await decide({
        profile: ASTRA_NO_APPROVAL,
        tool: "Bash",
        command: PUBLISH,
        purpose: "发布包",
        scope: "npm registry",
        redlines: REDLINES,
        grants: grantsFor(s),
      });
      console.log("[c3] 合成画像 decide:", r.decision, r.layer, "| skipped:", skipNames(r), "|", layerLine(r));
      assert.equal(r.decision, "allow", "L3 跳过 → 直落 L6 授权");
      assert.equal(r.layer, "6");
      assert.equal(r.skipped.some((x) => x.layer === "3"), true);

      const gate = gateToolCall({ session: s, tool: "Bash", command: PUBLISH });
      console.log("[c3] 闸:", JSON.stringify(gate));
      assert.equal(gate.kind, "pass", "闸只认授权表，不认门槛清单 —— L3 一关，闸即放行");
      assert.equal(gate.granted, true);
      assert.equal(gatedReasonOf("Bash", PUBLISH), "publish", "publish 仍在门槛清单里，但被授权覆盖");
      resetGrants(s);
    });

    test("c4. 【缺陷】同一请求同一 session：decide 放行、gateToolCall 拒绝（两条路径不同源）", async () => {
      const s = freshSession("it-c4");
      const r = await decide({
        profile: ASTRA_NO_APPROVAL,
        tool: "Bash",
        command: PUBLISH,
        purpose: "发布包",
        scope: "npm registry",
        redlines: REDLINES,
      });
      const gate = gateToolCall({ session: s, tool: "Bash", command: PUBLISH });
      console.log("[c4] decide:", r.decision, r.layer, "| gateToolCall:", gate.kind, "|", gate.reason);
      // 注意：decide 未注入 grantsFor(s)，故未在会话表里落授权；这正是"未申请"的等价现场。
      assert.equal(r.decision, "allow", "资格审核路径不看 gate 的门槛清单");
      assert.equal(gate.kind, "deny", "pre-execute 闸不看画像");
      assert.match(gate.reason, /fg_apply/);
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

    test("d2. 【缺陷】母版 L2 根本不调用 redlineExempt → 同一命令仍 deny（layer 2）", async () => {
      const r = await checkEligibility({
        tool: "Bash",
        command: QUOTED,
        purpose: "把危险命令当测试数据打印",
        scope: "仅终端输出",
        redlines: REDLINES,
      });
      console.log("[d2] 母版 L2:", r.decision, r.layer, "|", r.reason);
      assert.equal(r.decision, "deny", "豁免只在 pipeline 文本层生效，母版 L2 未接");
      assert.equal(r.layer, "2");
      assert.match(r.reason, /rm-rf-root/);
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
