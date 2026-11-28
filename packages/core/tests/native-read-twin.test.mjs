// FocusGuard · 内存读账的第二个写者（2026-11-28）
//
// 现象：24 条 deny **全部**落在「未取证」。成因有两条：
//   ① 回合级状态被按步清空（readSet 每步归零，已在 pre-step 修掉）；
//   ② 内存读账只有 `rememberReads`（guard 路径）一个写者，而原生路径的
//      `postProgress.trackReadSet` **只写状态文件**，key 还各算一套。
//
// ②的真实触发条件**不是**「状态文件丢失」——那种情况层 3 直接 fail-open 放行（evidence.mjs:205），
// 比误拦更宽松。真正会误拦的是「状态文件还在、但 readSet 里没有这条记录」：
// 被回合重置覆盖、被别的写者整体覆盖、或 ① 那种每步清空。
//
// 本文件就测这个形态：post 记一次 Read → 把状态文件里的 readSet 清空 → 再做 Edit。
// 内存那一份若在，就必须放行；不在（旧实现）就 deny。
// 运行：node --test packages/core/tests/native-read-twin.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const AUDIT_TMP = join(tmpdir(), `fg-native-twin-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;
// 状态目录独占：默认 tmpdir()/focus-guard 里有别的测试/会话残留，
// 不隔离就可能读到别人的 readSet，让用例假绿。
process.env.FG_STATE_DIR = mkdtempSync(join(tmpdir(), `fg-twin-state-${process.pid}-`));

const REPO = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]+$/, "");

const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { postProgressListener } = await import("../src/dsh/postProgress.mjs");
const { statePath, saveState, loadState } = await import("../src/core/state.mjs");

const noop = () => {};
const pass = () => ({ kind: "allow" });
const mkExec = (sid, cwd, name, args) => ({
  sessionId: sid,
  agent: { session: { header: { id: sid, cwd } } },
  name,
  arguments: args,
});

/** 把状态文件里的 readSet 清空，其余字段原样保留——模拟被回合重置/别的写者覆盖。 */
function wipeReadSetOnDisk(sid) {
  const s = loadState(statePath(sid));
  s.readSet = {};
  saveState(statePath(sid), s);
}

describe("内存读账：原生 Read 必须同时进内存 Set", () => {
  test("状态文件里的 readSet 被清空后，之前读过的文件仍判「已取证」", async () => {
    const sid = `native-twin-${process.pid}`;
    const rel = "package.json";
    saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {} });

    const post = postProgressListener({ warn: noop });
    await post(mkExec(sid, REPO, "Read", { file_path: rel }), { ok: true }, pass);
    assert.ok(Object.keys(loadState(statePath(sid)).readSet).length > 0, "pre 条件：状态文件里应先有记录");

    wipeReadSetOnDisk(sid);

    const pre = preExecuteListener({ warn: noop });
    const d = await pre(mkExec(sid, REPO, "Edit", { file_path: rel, old_string: "a", new_string: "b" }), pass);
    assert.ok(!d || d.kind !== "deny", `磁盘记录没了、内存还在时不得误拦，实际：${d && d.reason}`);
    rmSync(statePath(sid), { force: true });
  });

  test("没读过的文件照拦（内存记账不得变成无条件放行）", async () => {
    const sid = `native-twin-neg-${process.pid}`;
    saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {} });
    const pre = preExecuteListener({ warn: noop });
    const d = await pre(
      mkExec(sid, REPO, "Edit", { file_path: "packages/core/README.md", old_string: "a", new_string: "b" }),
      pass,
    );
    assert.equal(d && d.kind, "deny", "未读过的既有文件必须被拦");
    rmSync(statePath(sid), { force: true });
  });
});
