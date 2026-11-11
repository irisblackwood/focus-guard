// FocusGuard · 环境检测缓存复用（2026-10-29）
//
// 锁四件事：
//   ① 首次 SessionStart 写入 envCache；
//   ② 二次 SessionStart **复用**缓存，不重算（detectedAt 必须原样保留）；
//   ③ 平台 / 执行体与缓存对不上时重算（缓存不能比它的输入活得久）；
//   ④ detectEnv 的版本探测默认不跑——那是每次启动 202.6ms 的元凶，且产物零消费。
//
// 背景（2026-10-29 实测）：SessionStart 中位 231.2ms，其中 detectEnv 占 230.9ms；
// detectEnv 内部 powershell 版本探测 202.6ms + cmd /c chcp 18.9ms + PATH 扫描 6.7ms。
// 而 `agent/created` 会对同一会话反复触发（审计日志：82 次调用 / 21 个会话，单会话最多 33 次），
// 每次都重算。修法 = ① 去掉版本探测 ② 已检测就跳过。
//
// 纪律：审计、卷宗、状态全部重定向到 tmpdir，绝不碰真实工作区。
// 运行：node --test packages/core/tests/env-cache-reuse.test.mjs

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 沙箱：必须在任何 audit / 卷宗调用之前生效
const WORK = mkdtempSync(join(tmpdir(), "fg-envcache-"));
process.env.FG_AUDIT_FILE = join(WORK, "AUDIT.log");
process.env.FG_CASE_FILE = join(WORK, "CASE_FILE.md");

const { sessionStartListener } = await import("../src/dsh/seams.mjs");
const { statePath, loadState, saveState } = await import("../src/core/state.mjs");
const { detectEnv } = await import("../src/core/env.mjs");

const noop = () => {};
// 每次运行的唯一前缀：pid 会被复用，光靠 pid 会让两次运行撞同一个状态文件
// （decision-bench 2026-10-29 就是这么串味的）。
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const PROJ = join(WORK, "proj");
mkdirSync(PROJ, { recursive: true });

const mkAgent = (sid) => ({ session: { header: { id: sid, cwd: PROJ } } });
const start = (sid) => sessionStartListener({ warn: noop })({ agent: mkAgent(sid) });
const envOf = (sid) => loadState(statePath(sid)).envCache;
const clean = (sid) => rmSync(statePath(sid), { force: true });
const FIXED = "2000-01-01T00:00:00.000Z";

after(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe("环境检测缓存复用（修「每次会话启动重付 228ms」）", () => {
  test("首次启动写入 envCache", async () => {
    const sid = `envcache-first-${RUN}`;
    clean(sid);
    await start(sid);
    const env = envOf(sid);
    assert.ok(env, "应写入 envCache");
    assert.equal(env.os, process.platform, "应记录平台");
    assert.ok(env.shellIdKey, "应记录执行体");
    clean(sid);
  });

  test("二次启动复用缓存，不重算（detectedAt 原样保留）", async () => {
    const sid = `envcache-reuse-${RUN}`;
    clean(sid);
    // 2026-11-09：预置值必须取自**引擎自己**写出的结果，不能靠测试另猜一个。
    // 原来这里硬编码 `"powershell"`，把「DSH 在 win32 上跑 pwsh」那个错误假定又抄了一遍；
    // 执行体改成 bash 后，预置值永远对不上真值，这条"复用"用例实际在测"重算"。
    // 现在先真启动一次拿 shellIdKey，再拿它去预置——测的是「同 key 就复用」，不依赖具体值。
    await start(sid);
    const realShell = envOf(sid).shellIdKey;
    saveState(statePath(sid), { envCache: { os: process.platform, shellIdKey: realShell, detectedAt: FIXED } });
    await start(sid);
    assert.equal(envOf(sid).detectedAt, FIXED, "已检测过就不该重算——这是每次启动 228ms 的来源");
    clean(sid);
  });

  test("平台对不上时重算（缓存不能比输入活得久）", async () => {
    const sid = `envcache-stale-os-${RUN}`;
    clean(sid);
    saveState(statePath(sid), { envCache: { os: "plan9", shellIdKey: "sh", detectedAt: FIXED } });
    await start(sid);
    assert.notEqual(envOf(sid).detectedAt, FIXED, "平台变了必须重算");
    assert.equal(envOf(sid).os, process.platform, "重算后应记成当前平台");
    clean(sid);
  });

  test("执行体对不上时重算", async () => {
    const sid = `envcache-stale-shell-${RUN}`;
    clean(sid);
    saveState(statePath(sid), { envCache: { os: process.platform, shellIdKey: "csh", detectedAt: FIXED } });
    await start(sid);
    assert.notEqual(envOf(sid).detectedAt, FIXED, "执行体变了必须重算");
    clean(sid);
  });

  test("版本探测默认不跑，显式索取时才跑", () => {
    // shell 选 cmd：无版本探测分支，两条路都不 spawn，纯验「默认关闭」不改变返回值形状。
    const plain = detectEnv(PROJ, { shell: "cmd" });
    assert.equal(plain.shell, "cmd", "不索取版本时 shell 就是执行体标识本身，不带版本串");
    const probed = detectEnv(PROJ, { shell: "cmd", probeVersion: true });
    assert.equal(probed.shell, "cmd", "cmd 无版本分支，索取也不变（只验不崩）");
    // 形状不变：消费方只读 os / shellIdKey / caseSensitive / encoding，这四个必须还在。
    for (const k of ["os", "shellIdKey", "shell", "encoding", "caseSensitive", "cmds", "detectedAt"]) {
      assert.ok(k in plain, `字段 ${k} 不应被删——消费方可能依赖`);
    }
  });
});
