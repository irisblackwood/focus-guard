import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 2026-11-28：记忆沉淀的「谁是主体」判据锁。
//
// 病根：`PROMOTE_TYPES` 原含 `action`，而审计里的 action **全部由 FG 自己写**
// （回合重置、残留核验、KPI 结算、拦截、心跳）。沉淀成「方法」等于把自己的心跳当成本事。
// 实测代价：`self-improvement/memory/methods.md` 10 行里 8 行是这种条目，
// 头一条是「反复做 residue-check 7356 次」——而 7356 里绝大多数是每 step 重复记账的假象。
const { distill } = await import("../tools/memory-distill.mjs");

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400e3).toISOString();
const dayKey = (daysAgo) => iso(daysAgo).slice(0, 10);

/** 造一个「跨 days 天、共 c 次、最近 lastDaysAgo 天还在出现」的实体。 */
function ent(t, n, c, { days = 10, lastDaysAgo = 1, sample = "样本" } = {}) {
  const h = {};
  for (let i = 0; i < days; i++) h[dayKey(i + lastDaysAgo)] = Math.ceil(c / days);
  return { t, n, c, f: iso(days + lastDaysAgo), l: iso(lastDaysAgo), h, x: [sample] };
}

function run(entities) {
  const repo = mkdtempSync(join(tmpdir(), "fg-distill-"));
  const r = distill({ repo, idx: { entities }, min: 8, dry: false });
  let body = "";
  try {
    body = readFileSync(join(repo, "self-improvement", "memory", "methods.md"), "utf8");
  } catch {
    body = "";
  }
  rmSync(repo, { recursive: true, force: true });
  return { r, body };
}

describe("记忆沉淀：只记人做的事，不记系统自己的心跳", () => {
  test("action 再频繁也不沉淀——它是 FG 自己写的事件", () => {
    const { r, body } = run({
      "action:residue-check": ent("action", "residue-check", 7356, { days: 20, sample: "43条 残留(已清理): readSet=1" }),
      "action:kpi-settle": ent("action", "kpi-settle", 400, { days: 15 }),
    });
    assert.equal(r.added.length, 0, "action 不该进记忆");
    assert.ok(!body.includes("residue-check"), "「反复做 residue-check」这类条目必须消失");
  });

  test("tool 仍然沉淀——那才是真实调用过的动作", () => {
    const { r, body } = run({
      Read: ent("tool", "Read", 60, { days: 10 }),
      "action:reset-fired": ent("action", "reset-fired", 900, { days: 10 }),
    });
    assert.deepEqual(
      r.added.map((a) => a.name),
      ["Read"],
      "同一份索引里 tool 进、action 不进",
    );
    assert.ok(body.includes("Read"), "tool 条目应写进 methods.md");
    assert.ok(!body.includes("reset-fired"), "同批的 action 不得混入");
  });

  test("次数不够或跨天不足的 tool 也不沉淀（原判据不得被这次改动放宽）", () => {
    const { r } = run({
      A: ent("tool", "A", 7, { days: 10 }), // 次数 < min(8)
      B: ent("tool", "B", 99, { days: 2 }), // 只跨 2 天，不构成习惯
    });
    assert.equal(r.added.length, 0);
  });
});
