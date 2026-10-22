// FocusGuard 3.0.5 模型画像验收用例
//
// 覆盖领导指定的四条验收 + 关键回归（不传 profile 时行为与 3.0.4 一致）。
// 运行：node --test packages/core/tests/profile.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkEligibility, profileScope } from "../src/core/checkEligibility.mjs";
// 2026-10-22 分层：母版只认语义类别，宿主工具名由适配层注册（本文件直接调 checkEligibility）。
await import("../src/adapters/dsh/tool-kinds.mjs");
import {
  loadProfile,
  PROFILES,
  LAYER_SWITCHES,
  layerEnabled,
  unimplementedSwitches,
  approvalScopeOf,
  evasionRiskOf,
  EVASION_RISKS,
} from "../src/core/profileLoader.mjs";
import { gateToolCall } from "../src/adapters/dsh/eligibility-gate.mjs";
import { decide, skippedFromTrace, activeFromTrace } from "../src/core/decisionEngine.mjs";

const PROFILE_IDS = ["deepseek-flash", "deepseek-pro", "glm", "gpt-astra", "default"];

// 未取证的改动请求：L4 应 deny（evidenceGate on）/ 跳过（evidenceGate off）
const UNEVIDENCED = {
  tool: "Write",
  command: "rm -f ./tmp/a.txt",
  target: "./tmp/a.txt",
  purpose: "清理临时文件",
  scope: "仅 ./tmp/a.txt",
  state: { readSet: {} },
};

describe("3.0.5 · 模型画像", () => {
  test("验收 1：五个画像加载正常", () => {
    assert.equal(Object.keys(PROFILES).length, 5, "注册表应正好 5 个画像");
    for (const id of PROFILE_IDS) {
      const p = loadProfile(id);
      assert.equal(p.id, id, `${id} 的 id 应为自身`);
      assert.ok(typeof p.displayName === "string" && p.displayName.length > 0, `${id} 应有 displayName`);
      for (const sw of ["stalledFuse", "budgetGate", "reasoningWatch", "evidenceGate", "emotionFilter", "approvalGate", "redlineGate"]) {
        assert.equal(typeof p[sw], "object", `${id} 缺开关 ${sw}`);
        assert.equal(typeof p[sw].enabled, "boolean", `${id}.${sw}.enabled 应为 boolean`);
      }
    }
  });

  test("验收 2：未匹配 modelId 走 default", () => {
    for (const raw of ["", null, undefined, "no-such-model-xyz", "qwen-unknown-9b"]) {
      const p = loadProfile(raw);
      assert.equal(p.id, "default", `${String(raw)} 应落 default`);
      assert.match(p.profileSource, /^default:/);
    }
    // 归一化：大小写/空白不影响命中
    assert.equal(loadProfile("  DeepSeek-Flash  ").id, "deepseek-flash");
    assert.equal(loadProfile("gpt-astra-v9").id, "gpt-astra", "前缀应命中");
  });

  test("验收 3：同请求在 flash(evidenceGate on) 与 astra(evidenceGate off) 下决策不同", async () => {
    const flash = await decide({ ...UNEVIDENCED, modelId: "deepseek-flash" });
    const astra = await decide({ ...UNEVIDENCED, modelId: "gpt-astra" });
    console.log("flash:", flash.decision, "L" + flash.layer, "| skipped:", JSON.stringify(flash.skipped));
    console.log("astra:", astra.decision, "L" + astra.layer, "| skipped:", JSON.stringify(astra.skipped));
    assert.equal(flash.decision, "deny", "flash 的 evidenceGate 开启 → 未取证应 deny");
    assert.equal(flash.layer, "4");
    assert.equal(astra.decision, "allow", "astra 的 evidenceGate 关闭 → L4 跳过 → 放行");
    assert.equal(astra.layer, "6");
    assert.notEqual(flash.decision, astra.decision, "同一请求在不同画像下决策必须不同");
  });

  test("验收 4：跳过的层不出现在 active 里", async () => {
    const r = await decide({ ...UNEVIDENCED, modelId: "gpt-astra" });
    const active = activeFromTrace(r.trace).map((s) => s.layer);
    const skipped = skippedFromTrace(r.trace).map((s) => s.layer);
    console.log("active:", JSON.stringify(active), "| skipped:", JSON.stringify(skipped));
    assert.equal(active.includes("4"), false, "L4 已跳过，不得出现在 active");
    assert.ok(skipped.includes("4"), "L4 应出现在 skipped");
    // 跳过的层必须在 trace 里带 skip 标记
    const l4 = r.trace.find((s) => s.layer === "4");
    assert.equal(l4.decision, "skip");
    assert.match(l4.reason, /evidenceGate/);
  });

  test("层开关判定：L1 拆子开关、L0/L5/L6 不受画像控制", () => {
    const flash = loadProfile("deepseek-flash");
    const astra = loadProfile("gpt-astra");
    assert.equal(LAYER_SWITCHES["1-fuse"], "stalledFuse");
    assert.equal(LAYER_SWITCHES["1-budget"], "budgetGate");
    for (const k of ["0", "5", "6"]) assert.equal(LAYER_SWITCHES[k], null, `L${k} 应无画像开关`);
    assert.equal(layerEnabled(flash, "4"), true);
    assert.equal(layerEnabled(astra, "4"), false);
    assert.equal(layerEnabled(astra, "1-fuse"), false, "astra 的 stalledFuse 关闭");
    assert.equal(layerEnabled(null, "2"), true, "无画像时应保守启用");
    assert.equal(layerEnabled({}, "2"), true, "画像缺字段时应保守启用");
  });

  test("未实现开关：只登记、进 skipped、不参与执行", async () => {
    const flash = loadProfile("deepseek-flash");
    const sw = unimplementedSwitches(flash);
    assert.equal(sw.length, 2);
    assert.deepEqual(sw.map((s) => s.name).sort(), ["emotionFilter", "reasoningWatch"]);
    assert.ok(sw.every((s) => s.reason === "no engine implementation, TODO"));

    const r = await decide({ tool: "Read", command: "", purpose: "查看", scope: "只读", modelId: "deepseek-flash" });
    const skipped = skippedFromTrace(r.trace);
    for (const name of ["reasoningWatch", "emotionFilter"]) {
      const hit = skipped.find((s) => s.layer === name);
      assert.ok(hit, `${name} 应出现在 skipped`);
      assert.equal(hit.reason, "no engine implementation, TODO");
    }
  });

  test("回归：不传 profile 时行为与 3.0.4 一致（全部层启用、无 skip 追加）", async () => {
    const r = await checkEligibility({
      tool: "Write",
      command: "rm -f ./tmp/a.txt",
      target: "./tmp/a.txt",
      purpose: "清理临时文件",
      scope: "仅 ./tmp/a.txt",
      state: { readSet: {} },
    });
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "4");
    assert.deepEqual(r.trace.map((s) => s.layer), ["0", "1", "2", "3", "4"]);
    assert.equal(r.trace.some((s) => s.decision === "skip"), false, "未传 profile 不应出现 skip");
  });

  test("审计带 skipped：跳过信息进入 audit 的 trace 字段", async () => {
    const calls = [];
    const r = await decide({
      ...UNEVIDENCED,
      modelId: "gpt-astra",
      audit: (row) => calls.push(row),
      redlines: [],
    });
    assert.equal(r.decision, "allow");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "grant");
    assert.ok(Array.isArray(calls[0].skipped), "audit 记录应含 skipped 数组");
    assert.ok(calls[0].skipped.some((s) => s.layer === "4"), "L4 应写进审计 skipped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L1 画像包 · evasionRisk → 审批 scope（未发版）
//
// 口径：evasionRisk 是**纯参数**（画像文件里只有数据），解析收敛到 profileLoader.approvalScopeOf：
// ① 显式 approvalGate.scope 优先；② 否则 low → 'irreversible'、high/缺省/非法 → 'mutating'。
// 安全边界：不可逆类别（rm-rf / format-volume / drop-database / git-push-force / write-system-path）
// 在任何 scope 下都要审批——本字段只能「收窄到不可逆」，放不掉它们。
// ─────────────────────────────────────────────────────────────────────────────
describe("L1 画像包 · evasionRisk → 审批 scope", () => {
  const LEGACY_SCOPE = {
    "deepseek-flash": "mutating",
    "deepseek-pro": "mutating",
    glm: "mutating",
    "gpt-astra": "irreversible",
    default: "mutating",
  };

  test("g1. 五画像带合法 evasionRisk，派生结果与旧口径逐一相同（回归锁）", () => {
    for (const id of PROFILE_IDS) {
      const p = loadProfile(id);
      assert.ok(EVASION_RISKS.includes(p.evasionRisk), `${id}.evasionRisk 应为 ${EVASION_RISKS.join("/")}`);
      assert.equal(evasionRiskOf(p), p.evasionRisk, `${id} 的 evasionRisk 应被原样识别`);
      assert.equal(approvalScopeOf(p), LEGACY_SCOPE[id], `${id} 的审批 scope 必须与 3.0.8 前口径一致`);
      assert.equal(profileScope(p), approvalScopeOf(p), "profileScope 必须委托 approvalScopeOf（单一真源）");
    }
    // 兜底画像不得被低设成「只收不可逆」
    assert.equal(loadProfile("").evasionRisk, "high");
  });

  test("g2. 派生三分支 / 显式 scope 优先 / 非法值一律按最严", () => {
    assert.equal(approvalScopeOf({ evasionRisk: "low" }), "irreversible");
    assert.equal(approvalScopeOf({ evasionRisk: "low" }), "irreversible");
    assert.equal(approvalScopeOf({ evasionRisk: " HIGH " }), "mutating", "大小写/空白应归一化");
    assert.equal(approvalScopeOf({}), "mutating", "缺字段按最严");
    assert.equal(approvalScopeOf(null), "mutating");
    assert.equal(approvalScopeOf({ evasionRisk: "medium" }), "mutating", "非法值按最严");
    assert.equal(evasionRiskOf({ evasionRisk: 1 }), "high", "非字符串按最严");
    // 显式 scope 优先（数据 > 派生）
    assert.equal(approvalScopeOf({ evasionRisk: "low", approvalGate: { scope: "mutating" } }), "mutating");
    assert.equal(approvalScopeOf({ evasionRisk: "high", approvalGate: { scope: "irreversible" } }), "irreversible");
    assert.equal(
      approvalScopeOf({ evasionRisk: "low", approvalGate: { scope: "bogus" } }),
      "irreversible",
      "非法显式值应回落到派生",
    );
  });

  test("g3. 端到端：low 画像放行 publish，但不放行不可逆 rm-rf", async () => {
    const low = { id: "low", evasionRisk: "low", approvalGate: { enabled: true } };
    const high = { id: "high", evasionRisk: "high", approvalGate: { enabled: true } };
    const base = { tool: "Bash", purpose: "依赖发布演练", scope: "仅本地 dry-run", redlines: [], state: {} };

    const pubLow = await checkEligibility({ ...base, command: "npm publish --dry-run", profile: low });
    const pubHigh = await checkEligibility({ ...base, command: "npm publish --dry-run", profile: high });
    console.log("[g3] publish @low:", pubLow.decision, "L" + pubLow.layer, "| @high:", pubHigh.decision, "L" + pubHigh.layer);
    assert.equal(pubLow.decision, "allow", "publish 属可逆类别，超出 low 画像的审批范围 → 放行");
    assert.equal(pubHigh.decision, "needApproval", "high 画像 scope=mutating → publish 转人工");
    assert.equal(pubHigh.layer, "3");

    const rmLow = await checkEligibility({ ...base, command: "rm -rf ./src", profile: low });
    const rmHigh = await checkEligibility({ ...base, command: "rm -rf ./src", profile: high });
    console.log("[g3] rm-rf @low:", rmLow.decision, "L" + rmLow.layer, "| @high:", rmHigh.decision, "L" + rmHigh.layer);
    assert.equal(rmLow.decision, "needApproval", "不可逆类别在 low 画像下仍必须审批");
    assert.equal(rmHigh.decision, "needApproval");
    assert.equal(rmLow.layer, "3");
  });

  test("g4. pre-execute 闸同源：low 画像下 publish 以 outOfScope 放行、high 画像下仍 deny", () => {
    // 闸的 deny 分支会写审计 → 必须重定向到 tmpdir（2026-10-09 事故：套件写进真实 AUDIT.log）。
    const tmpAudit = join(tmpdir(), `fg-profile-evasion-${process.pid}.log`);
    const prev = process.env.FG_AUDIT_FILE;
    process.env.FG_AUDIT_FILE = tmpAudit;
    try {
      const low = { id: "low", evasionRisk: "low", approvalGate: { enabled: true } };
      const out = gateToolCall({ session: "profile-evasion-g4", tool: "Bash", command: "npm publish --dry-run", profile: low });
      console.log("[g4] gate @low:", JSON.stringify(out));
      assert.equal(out.kind, "pass", "闸必须与母版 L3 同源，不得在此分叉出 deny");
      assert.equal(out.outOfScope, true, "应明确标记为「超出审批范围」而非「已授权」");

      const strict = gateToolCall({
        session: "profile-evasion-g4",
        tool: "Bash",
        command: "npm publish --dry-run",
        profile: { id: "high", evasionRisk: "high", approvalGate: { enabled: true } },
      });
      assert.equal(strict.kind, "deny", "high 画像下 publish 无授权 → 闸应拦，并指引 fg_apply");
      assert.match(strict.reason, /fg_apply/);
      assert.ok(existsSync(tmpAudit), "deny 必须留痕（写的是 tmpdir，不是真实工作区）");
    } finally {
      if (prev === undefined) delete process.env.FG_AUDIT_FILE;
      else process.env.FG_AUDIT_FILE = prev;
      try {
        rmSync(tmpAudit, { force: true });
      } catch {
        /* 清理失败可忽略 */
      }
    }
  });
});
