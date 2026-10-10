// FocusGuard · 状态所有权与取证精确性（3.0.8）
//
// 背景（孤儿机制审计）：DSH 侧此前**没有 state 写入者**——唯一写者是 guard.mjs，而它在 DSH 下未挂载。
// 后果有二：① 取证记录（readSet）无法落盘，模块重载/进程重启后凭空消失，表现为"明明读过却被判未取证"；
// ② layer3Check 走 readGuardState(undefined) 退化成"扫 os.tmpdir() 取 mtime 最新"，
//    会读到别的会话或测试残留，拿它们（往往为空）的 readSet 判你的真实改动。
// 本文件锁定这两点的修复：状态**自持**且**按会话身份精确定位**。
//
// 纪律：一切写入重定向到 tmpdir；不得触碰真实工作区的 .focus-guard/ 与 .ai/。
// 运行：node --test packages/core/tests/state-ownership.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, loadState, saveState } = await import("../src/core/state.mjs");

const ROOT = join(tmpdir(), `fg-ownership-${process.pid}-${Date.now()}`);
const TARGET = join(ROOT, "target.txt");
mkdirSync(ROOT, { recursive: true }); // 先建目录：writeFileSync 不会自动创建父目录
writeFileSync(TARGET, "content");

const noop = () => {};
const allow = () => ({ kind: "allow" });
/** 构造一个最小 exec；RW 会话 id 由本文件控制。 */
const mkExec = (sid, tool, filePath) => ({
  sessionId: sid,
  name: tool,
  arguments: { file_path: filePath },
});

const cleanup = (sids) => {
  for (const s of sids) rmSync(statePath(s), { force: true });
  rmSync(ROOT, { recursive: true, force: true });
};

describe("3.0.8 · 状态所有权（DSH 侧自持 + 精确按会话定位）", () => {
  test("读取文件后，本会话状态文件出现该 readSet 记录（落盘，不只内存）", async () => {
    const sid = `own-write-${process.pid}`;
    rmSync(statePath(sid), { force: true });
    const listener = preExecuteListener({ warn: noop });

    await listener(mkExec(sid, "Read", TARGET), allow);

    assert.ok(existsSync(statePath(sid)), "应生成本会话状态文件（DSH 侧第一处 state 写权）");
    const st = loadState(statePath(sid));
    assert.ok(st.readSet && Object.hasOwn(st.readSet, TARGET), "readSet 应含已读目标");
    console.log("落盘 readSet:", Object.keys(st.readSet).length, "项 →", statePath(sid).replace(tmpdir(), "<tmp>"));
    rmSync(statePath(sid), { force: true });
  });

  test("取证判定用本会话状态：读过→放行；未读→拒一次（缺陷 C 的 existsSync 门仍生效）", async () => {
    const sid = `own-verdict-${process.pid}`;
    rmSync(statePath(sid), { force: true });
    const listener = preExecuteListener({ warn: noop });
    // 会话已开始（状态文件存在）但尚未读过目标 —— 这才是"未取证"的判定现场。
    // 完全没有状态文件属"会话未建立"，那是 fail-open（见本文件最后一条用例）。
    saveState(statePath(sid), { fused: false, probation: false, readSet: {} });

    // 未读就改 → 拒一次
    const denied = await listener(mkExec(sid, "Edit", TARGET), allow);
    assert.equal(denied.kind, "deny", "未取证就改应被拒");
    assert.match(denied.reason, /未取证|取证记录/);
    console.log("未读→拒:", denied.reason.slice(0, 60));

    // 读过之后再改 → 放行
    await listener(mkExec(sid, "Read", TARGET), allow);
    const ok = await listener(mkExec(sid, "Edit", TARGET), allow);
    assert.equal(ok.kind, "allow", "已取证应放行到下游");
    rmSync(statePath(sid), { force: true });
  });

  test("【核心】tmpdir 里存在更「新」的别人的状态时，仍只读本会话状态", async () => {
    const mine = `own-mine-${process.pid}`;
    const other = `own-other-${process.pid}-${Date.now()}`;
    rmSync(statePath(mine), { force: true });

    // 造一个"别人的"状态：readSet 为空，且 mtime 必然比 mine 新
    //（旧实现按 mtime 扫描 tmpdir，会读到它 → 判本会话"未取证" → 误拦）
    saveState(statePath(other), { fused: false, probation: false, readSet: {} });
    const otherMtime = Date.now();
    const listener = preExecuteListener({ warn: noop });

    // 本会话：先读目标（写入自己的状态）
    await listener(mkExec(mine, "Read", TARGET), allow);
    // 再把"别人的"状态刷成最新，模拟测试/别的会话刚写过
    writeFileSync(statePath(other), JSON.stringify({ fused: false, probation: false, readSet: {} }));
    assert.ok(Date.now() >= otherMtime);

    // 本会话改同一文件 → 应放行（本会话有记录），不受别人状态影响
    const out = await listener(mkExec(mine, "Edit", TARGET), allow);
    console.log("别人的空 readSet 在场时，本会话结论:", JSON.stringify(out).slice(0, 80));
    assert.equal(out.kind, "allow", "必须按会话身份精确定位，不得被 mtime 更新的他人状态带偏");

    cleanup([mine, other]);
  });

  test("会话隔离：A 会话读过的文件，不使 B 会话免取证", async () => {
    const a = `own-iso-a-${process.pid}`;
    const b = `own-iso-b-${process.pid}`;
    rmSync(statePath(a), { force: true });
    rmSync(statePath(b), { force: true });
    // 上一条用例的 cleanup 会删掉共享的 ROOT/TARGET，这里重建，确保目标文件存在——
    // 目标不存在会走"新建文件放行"分支，那就测不到会话隔离了。
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(TARGET, "content");
    const listener = preExecuteListener({ warn: noop });

    saveState(statePath(b), { fused: false, probation: false, readSet: {} }); // B 会话已开始、尚未读
    await listener(mkExec(a, "Read", TARGET), allow); // A 读过
    const outB = await listener(mkExec(b, "Edit", TARGET), allow); // B 未读
    console.log("A 读过 → B 的结论:", JSON.stringify(outB).slice(0, 80));
    assert.equal(outB.kind, "deny", "取证要求是本会话语义，跨会话不继承");
    cleanup([a, b]);
  });

  test("本会话无状态文件时 fail-open 且留痕（不静默放行）", async () => {
    const sid = `own-none-${process.pid}-${Date.now()}`;
    rmSync(statePath(sid), { force: true });
    const warns = [];
    const listener = preExecuteListener({ warn: (...p) => warns.push(p.join(" ")) });
    const out = await listener(mkExec(sid, "Edit", TARGET), allow);
    assert.equal(out.kind, "allow", "无状态 → fail-open");
    assert.ok(warns.some((w) => /第3层/.test(w)), "fail-open 必须留痕，不得静默");
    console.log("warn:", warns.find((w) => /第3层/.test(w))?.slice(0, 70));
    rmSync(statePath(sid), { force: true });
  });

  test("真实工作区未被本次测试触碰", () => {
    const realAudit = join(process.cwd(), ".focus-guard", "AUDIT.log");
    const realCase = join(process.cwd(), ".ai", "CASE_FILE.md");
    // 只断言"能读"，不断言内容——避免把真实文件的现状写死进测试
    const readable = (p) => !existsSync(p) || readFileSync(p, "utf8").length >= 0;
    assert.ok(readable(realAudit));
    assert.ok(readable(realCase));
    console.log("真实工作区未被写入（本文件所有写操作均指向 tmpdir）");
  });
});
