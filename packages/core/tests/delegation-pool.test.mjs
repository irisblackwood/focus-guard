import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 委派闸覆盖面（2026-10-22，A 项）
// 病根：`RE_AGENT` 只认 `agent|subagent`，而 DSH 原生委派工具是 `subagent_fork`、
// `spawn_teammate`、`summon_expert(s)` / `summon_expert_team` —— 全部绕过委托池，
// 于是 KPI（只经由委托池起作用）等于空转，熔断期也能起团队。
// 本组用真实工具名锁住：消耗委托池、熔断期拒绝、池尽拒绝。

const AUDIT = join(tmpdir(), `fg-deleg-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT;
process.env.FG_SHELL = "";

const { preGuardListener } = await import("../src/dsh/preGuard.mjs");
const { statePath, saveState, loadState } = await import("../src/core/state.mjs");

const DIR = mkdtempSync(join(tmpdir(), "fg-deleg-"));
const listener = preGuardListener({ warn: () => {} });
const allow = () => ({ kind: "allow" });
let seq = 0;

async function call(tool, args, seed) {
  const sid = `deleg-${process.pid}-${(seq += 1)}`;
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {}, ...seed });
  const r = await listener(
    { sessionId: sid, name: tool, arguments: args, agent: { session: { header: { id: sid, cwd: DIR } } } },
    allow,
  );
  const after = loadState(statePath(sid));
  rmSync(statePath(sid), { force: true });
  return { kind: (r && r.kind) || "allow", reason: r && r.reason, state: after };
}

for (const tool of ["subagent_fork", "spawn_teammate", "summon_expert", "summon_experts", "summon_expert_team"]) {
  test(`委派工具 ${tool} 消耗委托池并留痕`, async () => {
    const r = await call(tool, { description: "探查", prompt: "p" }, { delegateBudget: 5, delegateUsed: 0 });
    assert.equal(r.kind, "allow", `${tool} 应放行`);
    assert.equal(r.state.delegateBudget, 4, `${tool} 应扣 1 次委托额度`);
    assert.equal(r.state.delegateUsed, 1);
    assert.equal(r.state.childChainN, 1, "应派生蜂群因果子链 /dN");
  });
}

test("熔断期委派：spawn_teammate 被拒（越权绕行）", async () => {
  const r = await call("spawn_teammate", { name: "x", description: "d", prompt: "p" }, { fused: true, delegateBudget: 5 });
  assert.equal(r.kind, "deny");
  assert.match(String(r.reason), /越权绕行|熔断/);
});

test("委托池用尽：summon_expert_team 被拒", async () => {
  const r = await call("summon_expert_team", { team: "team-data", task: "t" }, { delegateBudget: 0 });
  assert.equal(r.kind, "deny");
  assert.match(String(r.reason), /委托池用尽/);
});

test("只读工具不消耗委托池（不误伤）", async () => {
  const r = await call("list_agents", {}, { delegateBudget: 5 });
  assert.equal(r.kind, "allow");
  assert.equal(r.state.delegateBudget, 5);
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
