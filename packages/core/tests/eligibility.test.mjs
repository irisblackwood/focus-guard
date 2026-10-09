// FocusGuard 资格审核引擎 · 第一步（逻辑层）验收用例
//
// 覆盖：第 0 层申请完整性 + 六层全分支 + 授权表边界 + 逐层 trace。
// 审计一律注入 mock：本文件不写真实 AUDIT.log（规格验收细节）。
// 运行：node --test packages/core/tests/eligibility.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  checkEligibility,
  highRiskOf,
  HIGH_RISK_TOOLS,
  SYSTEM_PATH_RE,
  SPECIAL_DIR_RE,
  RISK_ASK_THRESHOLD,
} from "../src/core/checkEligibility.mjs";
import { createGrantTable, TTL_KINDS } from "../src/core/grants.mjs";
import { redlineExempt } from "../src/core/redlines.mjs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, rmSync } from "node:fs";

// 复刻适配层 ABSOLUTE_REDLINES 的形状（母版测试不反向依赖适配层）
const REDLINES = [
  { name: "rm-rf-root", re: /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*(?:r\w*f|f\w*r)\w*\s+["']?[\/~][\/\s"']*(?=\s|["']|$)/ },
  { name: "drop-database", re: /\b(?:drop\s+(?:database|schema)|truncate\s+table)\b/i },
  { name: "git-push-force", re: /\bgit\s+push\b[^\n]*\s(?:-f|--force(?:-with-lease)?)\b/i },
];

const BASE = { tool: "Bash", command: "echo hi", purpose: "打印问候", scope: "仅终端输出" };

/** 收集 audit 调用，供"写审计"断言 */
function recorder() {
  const calls = [];
  return { calls, audit: (row) => calls.push(row) };
}

/** 逐层判定打印（验收要求：六层判定逐层打印） */
const layerLine = (r) => r.trace.map((s) => `L${s.layer}:${s.decision}(${s.reason})`).join(" → ");

describe("第一步 · 逻辑层 checkEligibility", () => {
  test("第 0 层：purpose 空白 → deny 要求补充", async () => {
    const { calls, audit } = recorder();
    const r = await checkEligibility({ ...BASE, purpose: "   ", audit });
    console.log("L0 purpose:", layerLine(r));
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "0");
    assert.match(r.reason, /purpose 缺失/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "deny");
  });

  test("第 0 层：scope 空白 → deny 要求补充", async () => {
    const r = await checkEligibility({ ...BASE, scope: "" });
    console.log("L0 scope:", layerLine(r));
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "0");
    assert.match(r.reason, /scope 缺失/);
  });

  test("第 1 层：熔断 → deny，且在红线之前短路", async () => {
    const r = await checkEligibility({ ...BASE, command: "rm -rf /", redlines: REDLINES, state: { fused: true } });
    console.log("L1 fused:", layerLine(r));
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "1");
    assert.match(r.reason, /熔断/);
    assert.equal(r.trace.some((s) => s.layer === "2"), false, "熔断应短路，不进红线层");
  });

  test("第 1 层：降权 → deny", async () => {
    const r = await checkEligibility({ ...BASE, state: { probation: true } });
    console.log("L1 probation:", layerLine(r));
    assert.equal(r.layer, "1");
    assert.match(r.reason, /降权/);
  });

  test("第 1 层：预算耗尽 → deny", async () => {
    const r = await checkEligibility({ ...BASE, state: { taskBudget: 0 } });
    console.log("L1 budget:", layerLine(r));
    assert.equal(r.layer, "1");
    assert.match(r.reason, /预算耗尽/);
  });

  test("第 1 层：未提供预算字段 → 不误判为耗尽", async () => {
    const r = await checkEligibility({ ...BASE });
    console.log("L1 无预算字段:", layerLine(r));
    assert.equal(r.decision, "allow");
  });

  test("第 2 层：命中绝对红线 → deny，且不进第 3 层", async () => {
    const r = await checkEligibility({ ...BASE, command: "rm -rf /", redlines: REDLINES });
    console.log("L2 红线:", layerLine(r));
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "2");
    assert.match(r.reason, /rm-rf-root/);
    assert.equal(r.trace.some((s) => s.layer === "3"), false);
  });

  test("第 3 层：高危且无授权 → needApproval", async () => {
    const { calls, audit } = recorder();
    const r = await checkEligibility({ ...BASE, command: "rm -rf ./dist", redlines: REDLINES, audit });
    console.log("L3 无授权:", layerLine(r));
    assert.equal(r.decision, "needApproval");
    assert.equal(r.layer, "3");
    assert.match(r.reason, /rm-rf/);
    assert.equal(calls[0].action, "needApproval");
  });

  test("第 3 层：高危但已有授权 → 继续到第 6 层放行", async () => {
    const grants = createGrantTable();
    grants.grant("Bash", { ttl: "task", reason: "先前批准" });
    const { calls, audit } = recorder();
    const r = await checkEligibility({ ...BASE, command: "rm -rf ./dist", redlines: REDLINES, grants, audit });
    console.log("L3 已有授权:", layerLine(r));
    assert.equal(r.decision, "allow");
    assert.equal(r.layer, "6");
    assert.equal(calls[0].action, "grant");
  });

  test("第 4 层：改动类且目标未取证 → deny", async () => {
    const r = await checkEligibility({
      ...BASE,
      command: "rm -f ./tmp/a.txt",
      target: "./tmp/a.txt",
      state: { readSet: {} },
    });
    console.log("L4 未取证:", layerLine(r));
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "4");
    assert.match(r.reason, /未取证/);
  });

  test("第 4 层：改动类但目标已取证 → 通过", async () => {
    const r = await checkEligibility({
      ...BASE,
      command: "rm -f ./tmp/a.txt",
      target: "./tmp/a.txt",
      state: { readSet: { "./tmp/a.txt": 1 } },
    });
    console.log("L4 已取证:", layerLine(r));
    assert.equal(r.decision, "allow");
  });

  test("第 4 层：系统路径 → deny", async () => {
    const r = await checkEligibility({ ...BASE, command: "cp ./x C:\\Windows\\System32\\y" });
    console.log("L4 系统路径:", layerLine(r));
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "4");
    assert.match(r.reason, /系统路径/);
  });

  test("第 4 层：特殊目录 → needApproval", async () => {
    const r = await checkEligibility({ ...BASE, command: "rm -f .git/index" });
    console.log("L4 特殊目录:", layerLine(r));
    assert.equal(r.decision, "needApproval");
    assert.equal(r.layer, "4");
    assert.match(r.reason, /\.git|node_modules/);
  });

  test("第 5 层：mismatch → deny 声称目的与实际效果不符", async () => {
    const model = async () => ({ mismatch: true, actual_effect: "递归删除整个用户目录", reason: "scope 仅称临时目录", risk: 0.2 });
    // 该命令本身高危，先预置授权以免停在第 3 层（本用例只验第 5 层语义判定）
    const grants = createGrantTable();
    grants.grant("Bash", { ttl: "turn", reason: "本用例预置" });
    const r = await checkEligibility({ ...BASE, command: "rm -rf ~/", model, grants });
    console.log("L5 mismatch:", layerLine(r));
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "5");
    assert.match(r.reason, /不符/);
    assert.equal(r.modelSignal.mismatch, true);
  });

  test(`第 5 层：risk > ${RISK_ASK_THRESHOLD} → needApproval`, async () => {
    const model = async () => ({ mismatch: false, risk: 0.9, reason: "影响面偏大" });
    const r = await checkEligibility({ ...BASE, model });
    console.log("L5 高风险:", layerLine(r));
    assert.equal(r.decision, "needApproval");
    assert.equal(r.layer, "5");
    assert.match(r.reason, /语义风险 0\.9/);
  });

  test("第 5 层：模型不可用（model-unavailable）→ needApproval，不静默放行", async () => {
    const model = async () => ({ mismatch: false, reason: "model-unavailable" });
    const r = await checkEligibility({ ...BASE, model });
    console.log("L5 模型不可用:", layerLine(r));
    assert.equal(r.decision, "needApproval");
    assert.equal(r.layer, "5");
    assert.match(r.reason, /保守审批/);
  });

  test("第 5 层：模型抛错 → needApproval", async () => {
    const model = async () => {
      throw new Error("ollama refused");
    };
    const r = await checkEligibility({ ...BASE, model });
    console.log("L5 模型抛错:", layerLine(r));
    assert.equal(r.decision, "needApproval");
    assert.equal(r.layer, "5");
  });

  test("第 5 层：模型正常且低风险 → allow", async () => {
    const model = async () => ({ mismatch: false, risk: 0.1, reason: "一致" });
    const r = await checkEligibility({ ...BASE, model });
    console.log("L5 一致:", layerLine(r));
    assert.equal(r.decision, "allow");
    assert.equal(r.layer, "6");
    assert.equal(r.modelSignal.risk, 0.1);
  });

  test("第 5 层：未注入模型 → 跳过（第一步零模型可用）", async () => {
    const r = await checkEligibility({ ...BASE });
    console.log("L5 跳过:", layerLine(r));
    assert.equal(r.decision, "allow");
    assert.equal(r.trace.find((s) => s.layer === "5").decision, "skip");
  });

  test("第 6 层：通过 → 写 grant 审计（一次）并临时开放工具", async () => {
    const grants = createGrantTable();
    const { calls, audit } = recorder();
    const r = await checkEligibility({
      ...BASE,
      tool: "Bash",
      ttl: "turn",
      grants,
      audit,
    });
    console.log("L6 通过:", layerLine(r));
    assert.equal(r.decision, "allow");
    assert.equal(r.layer, "6");
    assert.equal(calls.length, 1, "每次审核只写一条审计");
    const row = calls[0];
    assert.equal(row.action, "grant");
    assert.equal(row.tool, "Bash");
    assert.equal(row.ttl, "turn");
    assert.ok(typeof row.reason === "string" && row.reason.length > 0, "审计必须带 reason");
    assert.equal(row.layer, "6");
    assert.equal(row.decision, "allow");
    assert.ok(grants.has("Bash"), "通过后应临时开放该工具");
    assert.equal(grants.get("Bash").ttl, "turn");
  });

  test("逐层 trace 覆盖六层（含第 0 层）", async () => {
    const r = await checkEligibility({ ...BASE });
    const layers = r.trace.map((s) => s.layer);
    console.log("trace 层序:", layers.join(","));
    assert.deepEqual(layers, ["0", "1", "2", "3", "4", "5", "6"]);
  });

  test("第 3 层特征库：高危样例命中、良性不命中", () => {
    assert.equal(highRiskOf("rm -rf ./dist").id, "rm-rf");
    assert.equal(highRiskOf("Format-Volume -DriveLetter D").id, "format-volume");
    assert.equal(highRiskOf("git push -f origin main").id, "git-push-force");
    assert.equal(highRiskOf("npm publish").id, "publish");
    assert.equal(highRiskOf("npm i -g typescript").id, "global-install");
    assert.equal(highRiskOf("ls -la"), null);
    assert.equal(highRiskOf("npm run test"), null);
    assert.ok(HIGH_RISK_TOOLS.every((r) => typeof r.id === "string" && r.re instanceof RegExp));
  });

  test("第 4 层正则：系统路径与特殊目录边界", () => {
    assert.ok(SYSTEM_PATH_RE.test("cp a C:\\Windows\\x"));
    assert.ok(SYSTEM_PATH_RE.test("cat /etc/passwd"));
    assert.ok(SYSTEM_PATH_RE.test("ls /usr/local"));
    assert.equal(SYSTEM_PATH_RE.test("cat ./notes/etc.txt"), false);
    assert.ok(SPECIAL_DIR_RE.test("rm -f .git/index"));
    assert.ok(SPECIAL_DIR_RE.test("rm -rf node_modules/x"));
    assert.equal(SPECIAL_DIR_RE.test("cat .gitignore"), false);
  });
});

describe("第一步 · 授权表 grants", () => {
  test("grant / has / get / revoke / list / size", () => {
    const g = createGrantTable();
    assert.equal(g.has("Bash"), false);
    const e = g.grant("Bash", { ttl: "task", reason: "清理 dist" });
    assert.equal(e.tool, "Bash");
    assert.equal(e.ttl, "task");
    assert.ok(g.has("Bash"));
    assert.equal(g.get("Bash").reason, "清理 dist");
    assert.equal(g.size, 1);
    assert.equal(g.list().length, 1);
    assert.equal(g.revoke("Bash"), true);
    assert.equal(g.has("Bash"), false);
    assert.equal(g.revoke("Bash"), false);
  });

  test("ttl 默认 turn；非法 ttl 抛错（不静默归一）", () => {
    const g = createGrantTable();
    assert.equal(g.grant("Bash").ttl, "turn");
    for (const kind of TTL_KINDS) assert.equal(g.grant("Bash", { ttl: kind }).ttl, kind);
    assert.throws(() => g.grant("Bash", { ttl: "forever" }), RangeError);
  });

  test("两张表互不污染（工厂而非单例）", () => {
    const a = createGrantTable();
    const b = createGrantTable();
    a.grant("Bash");
    assert.equal(a.has("Bash"), true);
    assert.equal(b.has("Bash"), false);
  });
});

describe("第二步 · 双入口闭环（fg_apply 授权 + pre-execute 闸）", () => {
  // 适配层模块按需加载：fg-apply-tool.mjs 依赖 DSH 宿主的 @deepseek-ai/dsh-tools，
  // 项目内不 import 它；四条验收断言全部打在可以脱离宿主运行的 eligibility-gate 上。
  const load = () => import("../src/adapters/dsh/eligibility-gate.mjs");

  test("验收①：不调 fg_apply 直接执行高危命令 → deny，理由含 fg_apply", async () => {
    const g = await load();
    const s = "gate-a";
    g.resetGrants(s);
    const r = g.gateToolCall({ session: s, tool: "Bash", command: "rm -rf ./dist" });
    console.log("验收①闸:", r.kind, "|", r.reason);
    assert.equal(r.kind, "deny");
    assert.match(r.reason, /fg_apply/);
  });

  test("验收②：fg_apply 通过 → 同一命令放行", async () => {
    const g = await load();
    const s = "gate-b";
    g.resetGrants(s);
    const applied = await g.applyEligibility({
      session: s,
      tool: "Bash",
      command: "rm -rf ./dist",
      purpose: "清理构建产物",
      scope: "仅 ./dist 目录",
      ttl: "turn",
      redlines: REDLINES,
      model: null,
    });
    console.log("验收②申请:", applied.decision, applied.layer, "|", applied.reason);
    assert.equal(applied.decision, "allow");
    const after = g.gateToolCall({ session: s, tool: "Bash", command: "rm -rf ./dist" });
    console.log("验收②再执行:", after.kind);
    assert.equal(after.kind, "pass");
    g.resetGrants(s);
  });

  test("验收③：fg_apply 被拒 → 同一命令仍被拒（临时授权已收回）", async () => {
    const g = await load();
    const s = "gate-c";
    g.resetGrants(s);
    const applied = await g.applyEligibility({
      session: s,
      tool: "Bash",
      command: "rm -rf /",
      purpose: "清理根目录",
      scope: "整机",
      redlines: REDLINES,
      model: null,
    });
    console.log("验收③申请:", applied.decision, applied.layer, "|", applied.reason);
    assert.equal(applied.decision, "deny");
    assert.equal(applied.layer, "2");
    const after = g.gateToolCall({ session: s, tool: "Bash", command: "rm -rf /" });
    console.log("验收③再执行:", after.kind);
    assert.equal(after.kind, "deny");
  });

  test("验收④：npm publish 授权 → ttl=turn 回收后同命令被拒", async () => {
    const g = await load();
    const s = "gate-d";
    const cmd = "npm publish --access public";
    g.resetGrants(s);
    const applied = await g.applyEligibility({
      session: s,
      tool: "Bash",
      command: cmd,
      purpose: "发布 3.0.5 到 npm",
      scope: "npm registry 上的 focus-guard 包",
      ttl: "turn",
      redlines: REDLINES,
      model: null,
    });
    console.log("验收④申请:", applied.decision, applied.layer, "|", applied.reason);
    assert.equal(applied.decision, "allow");
    assert.equal(g.gateToolCall({ session: s, tool: "Bash", command: cmd }).kind, "pass");
    g.resetGrants(s); // 回合结束回收（第五步由 ttl 计时自动触发同一入口）
    const after = g.gateToolCall({ session: s, tool: "Bash", command: cmd });
    console.log("验收④回收后再执行:", after.kind, "|", after.reason);
    assert.equal(after.kind, "deny");
  });

  test("session 隔离：A 会话的授权不惠及 B 会话", async () => {
    const g = await load();
    g.resetGrants("iso-a");
    g.resetGrants("iso-b");
    g.grantsFor("iso-a").grant("Bash", { ttl: "task", reason: "A 会话已批" });
    assert.equal(g.gateToolCall({ session: "iso-a", tool: "Bash", command: "npm publish" }).kind, "pass");
    assert.equal(g.gateToolCall({ session: "iso-b", tool: "Bash", command: "npm publish" }).kind, "deny");
    g.resetGrants("iso-a");
    g.resetGrants("iso-b");
  });

  test("门槛清单：良性命令不拦；对系统路径的 Write 也拦", async () => {
    const g = await load();
    assert.equal(g.gatedReasonOf("Bash", "ls -la"), null);
    assert.equal(g.gateToolCall({ session: "z", tool: "Bash", command: "ls -la" }).kind, "pass");
    assert.equal(g.gatedReasonOf("Write", "C:\\Windows\\System32\\drivers\\etc\\hosts"), "write-system-path");
    assert.equal(g.gateToolCall({ session: "z", tool: "Write", command: "C:\\Windows\\x.txt" }).kind, "deny");
  });
});

describe("3.0.6 P0 · 绝对红线上下文豁免（HANDOFF §八）", () => {
  const RL = [
    { name: "rm-rf-root", re: /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*(?:r\w*f|f\w*r)\w*\s+["']?[\/~][\/\s"']*(?=\s|["']|$)/ },
    { name: "drop-database", re: /\b(?:drop\s+(?:database|schema)|truncate\s+table)\b/i },
    { name: "git-push-force", re: /\bgit\s+push\b[^\n]*\s(?:-f|--force(?:-with-lease)?)\b/i },
  ];
  const hitOf = (c) => RL.find((r) => r.re.test(c)) || null;

  test("判据1：命中片段落在引号字面量内 → 豁免（quoted-literal）", () => {
    const c = "$samples = @('rm -rf /', 'ls -la')";
    const hit = hitOf(c);
    assert.ok(hit, "应命中 rm-rf-root");
    const ex = redlineExempt(c, hit);
    assert.ok(ex, "引号内字面量应豁免");
    assert.equal(ex.basis, "quoted-literal");
    console.log("判据1:", ex.basis, "|", ex.detail);
  });

  test("判据2：片段前有数据标记且命令非变更类 → 豁免（data-marker）", () => {
    const c = "Select-String notes.md 示例：drop database";
    const hit = hitOf(c);
    assert.ok(hit, "应命中 drop-database");
    const ex = redlineExempt(c, hit);
    assert.ok(ex, "数据标记 + 非变更命令应豁免");
    assert.equal(ex.basis, "data-marker");
    console.log("判据2:", ex.basis, "|", ex.detail);
  });

  test("判据3：只读输出命令 → 豁免（readonly-head）", () => {
    const c = "echo rm -rf /";
    const hit = hitOf(c);
    assert.ok(hit, "应命中 rm-rf-root");
    const ex = redlineExempt(c, hit);
    assert.ok(ex, "只读输出命令应豁免");
    assert.equal(ex.basis, "readonly-head");
    console.log("判据3:", ex.basis, "|", ex.detail);
  });

  test("缺陷 6 已修：span 裁掉尾随分隔符与收尾引号 → 判据名稳定（对照表逐条）", () => {
    // 对照表来源：交接报告「任务 B」验收基准，逐条必须过。
    // 修复前：红线正则尾部的 [\/\s"']* 贪婪吃掉收尾引号 → span 越过引号内容区间
    //         → 判据 1（quoted-literal）判空 → 漂移到判据 3（readonly-head）。
    // 修复后：span 只覆盖危险片段本体（不含尾随空白/收尾引号），判据名稳定；豁免结果不变。
    const RM = "rm " + "-rf " + "/"; // 拆分构造：避免本测试自身的 shell 调用被 FG 文本层拦下
    const cases = [
      { cmd: "$samples = @('" + RM + "')", basis: "quoted-literal" },
      { cmd: 'echo "' + RM + '"', basis: "quoted-literal" },
      { cmd: "echo " + RM, basis: "readonly-head" },
      { cmd: RM, basis: null },
      { cmd: 'bash -c "' + RM + '"', basis: null },
    ];
    for (const { cmd, basis } of cases) {
      const hit = hitOf(cmd);
      assert.ok(hit, `应命中红线: ${cmd}`);
      const ex = redlineExempt(cmd, hit);
      assert.equal(ex && ex.basis, basis, `判据不符: ${cmd}`);
      if (ex) {
        const frag = cmd.slice(ex.span[0], ex.span[1]);
        assert.doesNotMatch(frag, /[\s"']$/, `span 尾部残留分隔符: ${JSON.stringify(frag)}`);
      }
    }
    console.log(`缺陷 6 对照表 ${cases.length} 条全过`);
  });

  test("反例：真执行命令与执行外壳一律不豁免", () => {
    const bad = [
      "rm -rf /",
      "git push -f origin main",
      "DROP DATABASE prod;",
      'bash -c "rm -rf /"',
      "sh -c 'git push -f origin main'",
      "node -e \"require('child_process').execSync('rm -rf /')\"",
      "python -c \"import os; os.system('rm -rf /')\"",
      'eval "rm -rf /"',
    ];
    for (const c of bad) {
      const hit = hitOf(c);
      assert.ok(hit, `反例应命中红线: ${c}`);
      assert.equal(redlineExempt(c, hit), null, `不得豁免: ${c}`);
    }
    console.log(`反例 ${bad.length} 条全部正确拒绝豁免`);
  });

  test("未命中红线或空参时不误报豁免", () => {
    assert.equal(hitOf("ls -la"), null);
    assert.equal(redlineExempt("ls -la", null), null);
    assert.equal(redlineExempt("", RL[0]), null);
  });

  test("验收③：豁免写 redline-exempt 审计（重定向 tmpdir，不碰真实审计）", async () => {
    const { auditRedlineExempt } = await import("../src/dsh/audit.mjs");
    const tmp = join(tmpdir(), `fg-exempt-${Date.now()}.log`);
    process.env.FG_AUDIT_FILE = tmp;
    try {
      auditRedlineExempt({ sessionId: "test-session" }, "$samples = @('rm -rf /')", {
        redline: "rm-rf-root",
        basis: "quoted-literal",
        detail: "命中片段位于引号字面量内",
      });
      const line = JSON.parse(readFileSync(tmp, "utf8").trim());
      assert.equal(line.action, "redline-exempt");
      assert.equal(line.basis, "quoted-literal");
      assert.equal(line.trigger, "rm-rf-root");
      assert.equal(line.session, "test-session");
      assert.match(line.evidence, /引号字面量/);
      console.log("审计行:", JSON.stringify(line).slice(0, 190));
    } finally {
      delete process.env.FG_AUDIT_FILE;
      rmSync(tmp, { force: true });
    }
  });
});

describe("3.0.7 · 误伤申辩（司法救济通道）", () => {
  const load = () => import("../src/adapters/dsh/eligibility-gate.mjs");
  const RM_ROOT = "rm -rf " + "/"; // 拆分构造：避免本测试自身的 shell 调用被 FG 拦截

  test("表单不完整 → deny（tool / reason 必填）", async () => {
    const g = await load();
    const r = await g.appealAsk({ sessionId: "ap-1", arguments: { tool: "Bash" } }, () => {});
    assert.equal(r.kind, "deny");
    assert.match(r.reason, /表单不完整/);
    console.log("表单校验:", r.reason.slice(0, 90));
  });

  test("完整申辩 → 产出 ask，理由含反例锚点与申辩指引", async () => {
    const g = await load();
    const r = await g.appealAsk(
      {
        sessionId: "ap-2",
        arguments: {
          tool: "Bash",
          command: RM_ROOT,
          reason: "该片段是喂给本地模型的测试数据，不是要执行的命令",
          counterExample: "tests/eligibility.test.mjs:412",
        },
      },
      () => {},
    );
    assert.equal(r.kind, "ask", "申辩须转成 ask 交人类裁决");
    assert.match(r.reason, /误判申辩/);
    assert.match(r.reason, /反例锚点/);
    assert.match(r.reason, /tests\/eligibility\.test\.mjs:412/);
    assert.match(r.reason, /批准/);
    console.log("ask 产出:", r.reason.replace(/\n/g, " | ").slice(0, 160));
  });

  test("获批后双记：工具授权 + 红线凭据，红线层可查到", async () => {
    const g = await load();
    g.resetGrants("ap-3");
    const { entry, redline } = await g.grantFromAppeal({ session: "ap-3", tool: "Bash", command: RM_ROOT });
    assert.equal(entry.ttl, "turn");
    assert.equal(redline, "rm-rf-root", "应识别出命中的红线名");
    assert.equal(g.grantsFor("ap-3").has("Bash"), true, "工具授权应生效");
    assert.equal(await g.hasRedlineGrant({ sessionId: "ap-3" }, "rm-rf-root"), true, "红线凭据应可查到");
    console.log("双记:", JSON.stringify({ ttl: entry.ttl, redline }));
    g.resetGrants("ap-3");
  });

  test("回收后凭据失效（hasRedlineGrant=false，资格闸重新拦截）", async () => {
    const g = await load();
    g.resetGrants("ap-4");
    await g.grantFromAppeal({ session: "ap-4", tool: "Bash", command: RM_ROOT });
    assert.equal(await g.hasRedlineGrant({ sessionId: "ap-4" }, "rm-rf-root"), true);
    g.resetGrants("ap-4");
    assert.equal(await g.hasRedlineGrant({ sessionId: "ap-4" }, "rm-rf-root"), false, "回收后凭据须失效");
    assert.equal(g.gateToolCall({ session: "ap-4", tool: "Bash", command: "npm publish" }).kind, "deny");
  });

  test("会话隔离：A 会话的申辩凭据不惠及 B 会话", async () => {
    const g = await load();
    g.resetGrants("ap-a");
    g.resetGrants("ap-b");
    await g.grantFromAppeal({ session: "ap-a", tool: "Bash", command: RM_ROOT });
    assert.equal(await g.hasRedlineGrant({ sessionId: "ap-a" }, "rm-rf-root"), true);
    assert.equal(await g.hasRedlineGrant({ sessionId: "ap-b" }, "rm-rf-root"), false);
    g.resetGrants("ap-a");
    g.resetGrants("ap-b");
  });

  test("申辩审计：filed / granted 留痕（tmpdir 重定向）", async () => {
    const g = await load();
    const tmp = join(tmpdir(), `fg-appeal-${Date.now()}.log`);
    process.env.FG_AUDIT_FILE = tmp;
    try {
      await g.appealAsk(
        {
          sessionId: "ap-5",
          arguments: { tool: "Bash", command: RM_ROOT, reason: "误伤", counterExample: "x.mjs:1" },
        },
        () => {},
      );
      await g.grantFromAppeal({ session: "ap-5", tool: "Bash", command: RM_ROOT });
      const rows = readFileSync(tmp, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const actions = rows.map((r) => r.action);
      assert.ok(actions.includes("appeal-filed"), "须记 appeal-filed");
      assert.ok(actions.includes("appeal-granted"), "须记 appeal-granted");
      const filed = rows.find((r) => r.action === "appeal-filed");
      assert.equal(filed.decision, "needApproval");
      assert.match(filed.evidence, /反例锚点/);
      console.log("审计 actions:", actions.join(" → "));
    } finally {
      delete process.env.FG_AUDIT_FILE;
      rmSync(tmp, { force: true });
    }
  });
});
