import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// L5 收尾打回（DSH 侧）· 触发②（2026-10-25 模块普查）
// 病根：模块有 259 行，但 DSH 侧此前没有专门用例；probe 里我甚至用错字段（turnCalls vs turnCount）
// 导致"以为它不会拦"。本组用真实字段锁住：本回合调用 ≥5 且收尾无 [文件:行号] 锚点 → 必须留痕+提示。
// 注意 DSH 语义：只审计 + 提示**不阻断停止**（宿主无 stop 拦截口，阻断会把人卡死）。

const WORK = mkdtempSync(join(tmpdir(), "fg-stop-"));
process.env.FG_AUDIT_FILE = join(WORK, "AUDIT.log");
process.env.FG_WORKSPACE_FILE = join(WORK, "workspace.json");
process.env.FG_SHELL = "";

const sg = await import("../src/dsh/stopGuard.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");

function agentWith(text, sid) {
  return {
    session: {
      header: { id: sid, cwd: WORK },
      messages: [{ role: "assistant", content: [{ type: "text", text }] }],
    },
    sessionId: sid,
  };
}

function seed(sid, turnCount) {
  saveState(statePath(sid), {
    fused: false, probation: false, readSet: {}, caseCache: {},
    turnCount, turnPrompt: "改点东西", turnPromptFull: "改点东西", stopBlocked: false,
  });
}

test("≥5 次调用且无锚点 → 写 violation-no-anchor 并给提示", async () => {
  const sid = `stop-${process.pid}-a`;
  seed(sid, 7);
  const warns = [];
  const listener = sg.stopGuardListener({ warn: (...a) => warns.push(a.join(" ")) });
  await listener({ agent: agentWith("改完了，应该没问题。", sid) });
  const log = readFileSync(process.env.FG_AUDIT_FILE, "utf8");
  assert.match(log, /violation-no-anchor/);
  assert.ok(warns.join(" ").includes("触发②"), "应给出收尾提示");
  rmSync(statePath(sid), { force: true });
});

test("带 [文件:行号] 锚点 → 不触发", async () => {
  const sid = `stop-${process.pid}-b`;
  seed(sid, 7);
  const before = readFileSync(process.env.FG_AUDIT_FILE, "utf8").length;
  const listener = sg.stopGuardListener({ warn: () => {} });
  await listener({ agent: agentWith("已改 src/a.mjs:12，验证通过。", sid) });
  const after = readFileSync(process.env.FG_AUDIT_FILE, "utf8");
  assert.equal(after.length, before, "有锚点不应新增审计行");
  rmSync(statePath(sid), { force: true });
});

test.after(() => rmSync(WORK, { recursive: true, force: true }));
