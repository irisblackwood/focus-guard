import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 改动面收尾报告（2026-10-25）
// 人类判据："改大量文件只换来一个小彩灯" —— 收尾时必须能看见改了多大面。
// 本组锁：① 达到阈值写 blast-radius 审计行 ② 未达阈值不写 ③ FG_BLAST_REPORT=0 关闭。

const WORK = mkdtempSync(join(tmpdir(), "fg-blast-"));
process.env.FG_AUDIT_FILE = join(WORK, "AUDIT.log");
process.env.FG_STATUS_FILE = join(WORK, "status.json");
process.env.FG_WORKSPACE_FILE = join(WORK, "workspace.json");
process.env.FG_SHELL = "";

const seams = await import("../src/dsh/seams.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");

function seed(sid, files) {
  const edited = {}
  for (let i = 0; i < files; i += 1) edited[`src/f${i}.mjs`] = true
  saveState(statePath(sid), {
    fused: false, probation: false, readSet: {}, caseCache: {},
    kpi: 0, editedFiles: edited, turnPrompt: "x",
  })
}

async function stop(sid) {
  const listener = seams.turnStoppingListener({ warn: () => {} })
  return listener(
    { agent: { session: { header: { id: sid, cwd: WORK } } }, sessionId: sid },
    () => undefined,
  )
}

test("改动 ≥6 文件 → 写入 blast-radius 审计行", async () => {
  const sid = `blast-${process.pid}-a`;
  seed(sid, 7);
  await stop(sid);
  const log = readFileSync(process.env.FG_AUDIT_FILE, "utf8");
  assert.match(log, /blast-radius/);
  assert.match(log, /7 个文件/);
  rmSync(statePath(sid), { force: true });
});

test("改动 <6 文件 → 不写", async () => {
  const sid = `blast-${process.pid}-b`;
  seed(sid, 3);
  const before = readFileSync(process.env.FG_AUDIT_FILE, "utf8").length;
  await stop(sid);
  const after = readFileSync(process.env.FG_AUDIT_FILE, "utf8");
  assert.equal(after.length, before, "未达阈值不应新增审计行");
  rmSync(statePath(sid), { force: true });
});

test("FG_BLAST_REPORT=0 → 关闭", async () => {
  process.env.FG_BLAST_REPORT = "0";
  const sid = `blast-${process.pid}-c`;
  seed(sid, 9);
  const before = readFileSync(process.env.FG_AUDIT_FILE, "utf8");
  await stop(sid);
  const after = readFileSync(process.env.FG_AUDIT_FILE, "utf8");
  assert.equal(after, before, "关闭后不得写 blast-radius");
  delete process.env.FG_BLAST_REPORT;
  rmSync(statePath(sid), { force: true });
});

test.after(() => rmSync(WORK, { recursive: true, force: true }));
