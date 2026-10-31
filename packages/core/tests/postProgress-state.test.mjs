import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// postProgress 的 **state 断言**（2026-10-31）
//
// 起因：变异抽样 169 个里存活 110（杀伤率 34.9%），存活点集中在回退链与记账分支——
// 现有用例只断言"吐出的 reason 文案"，不断言"内部状态写没写对"。
// 本文件不新增行为，只把已有写状态的分支钉住：readSet / caseCache / scriptFiles /
// 三池计数 / 会话标识回退。改坏这些记账，这些用例就会红。
const AUDIT_TMP = join(tmpdir(), `fg-poststate-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

const { postProgressListener, randomFuseInterval } = await import("../src/dsh/postProgress.mjs");
// 工具语义表是**登记式**的：不加载适配层，`Read` 会被当 `other`（investigate=false、计执行池）。
// 真机由 pipeline 先加载它；本文件单独测 postProgress，必须自己补这一刀。
await import("../src/adapters/dsh/tool-kinds.mjs");
const { statePath, loadState, saveState } = await import("../src/core/state.mjs");

const noop = () => {};
const pass = () => ({ kind: "allow" });
const mkExec = (sid, name, args) => ({
  sessionId: sid,
  agent: { session: { header: { id: sid, cwd: process.cwd() } } },
  name,
  arguments: args,
});
const fresh = (sid) => {
  rmSync(statePath(sid), { force: true });
  saveState(statePath(sid), { readSet: {} });
};
const run = (l, exec, res = { content: `ok-${Math.random()}` }) => l(exec, res, pass);
const get = (sid) => loadState(statePath(sid));
const keys = (o) => Object.keys(o || {});

describe("postProgress 状态记账", () => {
  test("Read：readSet + caseCache 都落（真实文件指纹）", async () => {
    const sid = `poststate-read-${process.pid}`;
    fresh(sid);
    const dir = mkdtempSync(join(tmpdir(), "fg-poststate-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "abc");
    const l = postProgressListener({ warn: noop });
    await run(l, mkExec(sid, "read", { file_path: file }));
    const s = get(sid);
    assert.equal(keys(s.readSet).length, 1, "read 必须进 readSet");
    assert.equal(keys(s.caseCache).length, 1, "read 必须进 caseCache（免重读依据）");
    const entry = s.caseCache[keys(s.caseCache)[0]];
    assert.equal(entry.path, file, "caseCache 要保留原始路径");
    assert.equal(entry.size, 3, "指纹取真实文件大小");
    assert.equal(entry.via, "mtime+size+sha", "有 sha 时口径是 mtime+size+sha");
    rmSync(dir, { recursive: true, force: true });
  });

  test("Write 脚本：危险登记 d、安全登记 c，且写操作也进 readSet", async () => {
    const sid = `poststate-write-${process.pid}`;
    fresh(sid);
    const l = postProgressListener({ warn: noop });
    await run(l, mkExec(sid, "write", { file_path: "x/danger.ps1", content: "rm -rf /tmp/y" }));
    await run(l, mkExec(sid, "write", { file_path: "x/safe.py", content: "print(1)" }));
    const s = get(sid);
    assert.equal(keys(s.readSet).length, 2, "写过的文件也要进 readSet");
    assert.equal(keys(s.scriptFiles).length, 2, "脚本文件要单独登记");
    const vals = Object.values(s.scriptFiles).sort();
    assert.deepEqual(vals, ["c", "d"], "危险内容记 d、安全内容记 c");
  });

  test("Grep：path 进 readSet（不是 file_path 也要收）", async () => {
    const sid = `poststate-grep-${process.pid}`;
    fresh(sid);
    const l = postProgressListener({ warn: noop });
    await run(l, mkExec(sid, "grep", { path: "packages/core/src" }));
    assert.equal(keys(get(sid).readSet).length, 1, "grep 的 path 必须进 readSet");
  });

  test("失败调用：不落 readSet（避免把失败当取证）", async () => {
    const sid = `poststate-fail-${process.pid}`;
    fresh(sid);
    const l = postProgressListener({ warn: noop });
    await run(l, mkExec(sid, "read", { file_path: "x.txt" }), { error: "boom", isError: true });
    assert.equal(keys(get(sid).readSet).length, 0, "失败调用不得写 readSet");
  });

  test("会话标识三级回退：header.id / exec.sessionId / agent.id 各自落对文件", async () => {
    const l = postProgressListener({ warn: noop });
    const variants = [
      { sid: `poststate-h-${process.pid}`, exec: { agent: { session: { header: { id: `poststate-h-${process.pid}` } } }, name: "read", arguments: {} } },
      { sid: `poststate-s-${process.pid}`, exec: { sessionId: `poststate-s-${process.pid}`, name: "read", arguments: {} } },
      { sid: `poststate-a-${process.pid}`, exec: { agent: { id: `poststate-a-${process.pid}` }, name: "read", arguments: {} } },
    ];
    for (const v of variants) {
      fresh(v.sid);
      await run(l, v.exec);
      assert.equal(get(v.sid).turnCount, 1, `标识回退错了：${v.sid}`);
    }
    // 中间层存在但缺 id：必须继续回退，不能抛错（否则一次畸形事件就丢掉整个回合的记账）
    const sidMid = `poststate-fb-${process.pid}`;
    fresh(sidMid);
    await run(l, { sessionId: sidMid, agent: { session: {} }, name: "read", arguments: {} });
    assert.equal(get(sidMid).turnCount, 1, "agent.session 缺 header 时应回退到 exec.sessionId");
  });

  test("readSet 只收 read/write 且带 file_path 的调用（条件不许放宽）", async () => {
    const sid = `poststate-narrow-${process.pid}`;
    fresh(sid);
    const l = postProgressListener({ warn: noop });
    await run(l, mkExec(sid, "read", {})); // 缺 file_path
    assert.equal(keys(get(sid).readSet).length, 0, "无 file_path 不得写 readSet");
    await run(l, mkExec(sid, "list", { file_path: "x.txt" })); // 非 read/write
    assert.equal(keys(get(sid).readSet).length, 0, "非读写工具不得写 readSet");
  });

  test("三池：Read 计侦查池，Edit 计执行池（互不串账）", async () => {
    const sid = `poststate-pool-${process.pid}`;
    fresh(sid);
    const l = postProgressListener({ warn: noop });
    await run(l, mkExec(sid, "read", { file_path: "a.txt" }));
    let s = get(sid);
    assert.equal(s.invCalls, 1, "Read 进侦查池");
    assert.equal(s.effectiveCalls || 0, 0, "Read 不得计执行池");
    await run(l, mkExec(sid, "edit", { file_path: "a.txt", old_string: "a", new_string: "b" }));
    s = get(sid);
    assert.equal(s.effectiveCalls, 1, "Edit 进执行池");
    assert.equal(s.invCalls, 1, "侦查池不因 Edit 变动");
  });

  test("随机抽查间隔：FG_RANDOM_FUSE_EVERY 非法值必须退回 random", () => {
    const saved = { gate: process.env.FG_RANDOM_FUSE, every: process.env.FG_RANDOM_FUSE_EVERY };
    try {
      process.env.FG_RANDOM_FUSE = "1";
      process.env.FG_RANDOM_FUSE_EVERY = "4";
      assert.equal(randomFuseInterval().kind, "fixed", "正整数 → fixed");
      process.env.FG_RANDOM_FUSE_EVERY = "0";
      assert.equal(randomFuseInterval().kind, "random", "0 不是合法间隔（边界）");
      process.env.FG_RANDOM_FUSE_EVERY = "";
      assert.equal(randomFuseInterval().kind, "random", "空值 → random");
    } finally {
      if (saved.gate === undefined) delete process.env.FG_RANDOM_FUSE;
      else process.env.FG_RANDOM_FUSE = saved.gate;
      if (saved.every === undefined) delete process.env.FG_RANDOM_FUSE_EVERY;
      else process.env.FG_RANDOM_FUSE_EVERY = saved.every;
    }
  });
});
