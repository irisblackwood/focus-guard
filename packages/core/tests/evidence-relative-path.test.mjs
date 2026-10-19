// FocusGuard · 取证闸路径归一化（2026-10-19 复现）
//
// 现象：真实会话里"先读后改"仍被拒一次，改的都是**相对路径**。
// 假设：rememberReads 记录的是宿主给的原始路径（相对），而取证闸查的是 resolveToolPath 后的绝对路径
//（cwd 来自 agent.session.header.cwd，Windows 下带反斜杠）——两边键不同 → 查不到 → 拒一次，
// 再靠 evidenceBlockedOnce 的"拒一次"逃生阀放行。若成立，取证闸在相对路径宿主上等于"礼貌提醒"。
//
// 本文件先按"应当放行"写断言：修复前红，修复后绿。
// 运行：node --test packages/core/tests/evidence-relative-path.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const AUDIT_TMP = join(tmpdir(), `fg-evidence-rel-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

// 仓库根：本文件在 <repo>/packages/core/tests/ → 上溯 3 级。
// 不能依赖 process.cwd()（从 packages/core 里跑测试时是子目录，夹具会全部找不到 → 闸静默放行）。
const REPO = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]+$/, "");

const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");

const noop = () => {};
const pass = () => ({ kind: "allow" });
const mkExec = (sid, cwd, name, args) => ({
  sessionId: sid,
  agent: { session: { header: { id: sid, cwd } } },
  name,
  arguments: args,
});
const withState = (sid, patch = {}) => {
  rmSync(statePath(sid), { force: true });
  saveState(statePath(sid), { readSet: {}, ...patch });
};

describe("取证闸 · 相对路径读后改应放行（键归一化）", () => {
  test("e1. 相对路径 Read → 相对路径 Edit 同一文件：必须放行（不得靠拒一次逃生）", async () => {
    const sid = `ev-rel-${process.pid}`;
    const cwd = REPO; // Windows 下是 E:\DSH\focus-guard-main（反斜杠）
    const rel = "packages/core/README.md";
    assert.ok(existsSync(join(cwd, rel)), "夹具文件必须存在（取证闸只对已存在目标生效）");
    withState(sid);
    const l = preExecuteListener({ warn: noop });

    await l(mkExec(sid, cwd, "Read", { file_path: rel }), pass);
    const out = await l(mkExec(sid, cwd, "Edit", { file_path: rel, old_string: "a", new_string: "b" }), pass);
    console.log("[e1] 读后改（相对路径）→", JSON.stringify(out).slice(0, 160));
    assert.equal(out.kind, "allow", "读过同一文件就该放行；被拒说明读记录与查证用了不同形态的键");
    rmSync(statePath(sid), { force: true });
  });

  test("e2. 绝对路径（正斜杠）Read → 相对路径 Edit：同样必须放行（跨形态）", async () => {
    const sid = `ev-abs-${process.pid}`;
    const cwd = REPO;
    const rel = "packages/core/docs/BENCH.md";
    const absForward = join(cwd, rel).replace(/\\/g, "/");
    withState(sid);
    const l = preExecuteListener({ warn: noop });

    await l(mkExec(sid, cwd, "Read", { file_path: absForward }), pass);
    const out = await l(mkExec(sid, cwd, "Edit", { file_path: rel, old_string: "a", new_string: "b" }), pass);
    console.log("[e2] 正斜杠绝对路径读过 → 相对路径改 →", JSON.stringify(out).slice(0, 160));
    assert.equal(out.kind, "allow", "同一个文件不该因路径写法不同被判未取证");
    rmSync(statePath(sid), { force: true });
  });

  test("e3. 真的没读就改：仍必须拒一次（修复不得放宽闸门）", async () => {
    const sid = `ev-unread-${process.pid}`;
    const cwd = REPO;
    withState(sid);
    const l = preExecuteListener({ warn: noop });
    const out = await l(mkExec(sid, cwd, "Edit", { file_path: "packages/core/README.md", old_string: "a", new_string: "b" }), pass);
    assert.equal(out.kind, "deny", "未取证必须拦");
    assert.match(out.reason, /第3层状态校验/);
    rmSync(statePath(sid), { force: true });
  });
});
