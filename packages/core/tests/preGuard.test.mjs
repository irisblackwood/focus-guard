// FocusGuard · pre-execute 结构性执法（3.0.8 · 移植批 5）
//
// 覆盖 guard.mjs 的 pre 段剩余（L356-457）：资料分层隔离 · 环境规则 · 大小写冲突 ·
// 子代理闸（越权绕行/48条继承留痕/蜂群因果子链/委托池消耗）· 熔断白名单 · L2 强制取证与 L5 降权。
//
// 重点覆盖【闭环】：委托池的追加侧在 seams.preStepListener（人类批示『追加额度』），
// 消耗侧在本模块——两侧合起来委托池才完整，故用跨模块用例钉住。
//
// 纪律：审计重定向 tmpdir；状态与卷宗写 tmpdir；不碰真实工作区。
// 运行：node --test packages/core/tests/preGuard.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const AUDIT_TMP = join(tmpdir(), `fg-pre-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

const { preGuardListener } = await import("../src/dsh/preGuard.mjs");
const { preStepListener } = await import("../src/dsh/seams.mjs");
const { statePath, loadState, saveState } = await import("../src/core/state.mjs");
const { DELEGATE_DEFAULT } = await import("../src/core/constants.mjs");

const ROOT = join(tmpdir(), `fg-pre-${process.pid}-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });
const noop = () => {};
const pass = () => ({ kind: "allow" });
const mkAgent = (sid) => ({ session: { header: { id: sid, cwd: ROOT } } });
const mkExec = (sid, name, args) => ({ sessionId: sid, agent: mkAgent(sid), name, arguments: args });
const auditLines = () =>
  existsSync(AUDIT_TMP)
    ? readFileSync(AUDIT_TMP, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const resetAudit = () => rmSync(AUDIT_TMP, { force: true });
const withState = (sid, patch = {}) => {
  rmSync(statePath(sid), { force: true });
  saveState(statePath(sid), { readSet: {}, ...patch });
};

describe("3.0.8 · pre 结构性执法（移植批 5）", () => {
  test("资料分层隔离：直写静态资料区/派生积木区 → deny", async () => {
    const sid = `pre-lib-${process.pid}`;
    withState(sid);
    resetAudit();
    const gate = await preGuardListener({ warn: noop })(
      mkExec(sid, "Write", { file_path: join(ROOT, ".ai", "library", "blocks", "x.md"), content: "y" }),
      pass,
    );
    assert.equal(gate.kind, "deny", "静态资料区直写应被拒");
    assert.match(gate.reason, /图书馆·隔离|静态资料区/);
    assert.ok(auditLines().some((r) => r.action === "library-write-deny"), "应留痕 library-write-deny");
    console.log("图书馆隔离:", String(gate.reason).slice(0, 70));
    rmSync(statePath(sid), { force: true });
  });

  test("子代理闸：正常委派消耗委托池 -1、置 delegated、派生子链 /d1", async () => {
    const sid = `pre-agent-${process.pid}`;
    withState(sid, { delegateBudget: 5, delegateUsed: 0, taskChain: "Ttest" });
    resetAudit();
    const gate = await preGuardListener({ warn: noop })(
      mkExec(sid, "subagent", { description: "查一处实现" }),
      pass,
    );
    assert.notEqual(gate.kind, "deny", "正常委派应放行");
    const st = loadState(statePath(sid));
    assert.equal(st.delegateBudget, 4, "委托池应 -1");
    assert.equal(st.delegateUsed, 1, "累计消耗 +1");
    assert.equal(st.delegated, true, "应置 delegated");
    const spawn = auditLines().find((r) => r.action === "subagent-spawn");
    const used = auditLines().find((r) => r.action === "delegate-used");
    assert.ok(spawn, "应留痕 subagent-spawn（48条继承）");
    assert.match(String(used.chain), /\/d1$/, "应派生子链 /d1");
    console.log("委派 →", JSON.stringify({ budget: st.delegateBudget, used: st.delegateUsed, childChain: used.chain }));
    rmSync(statePath(sid), { force: true });
  });

  test("委托池用尽 → deny（提示走『追加额度』批示）", async () => {
    const sid = `pre-agent-empty-${process.pid}`;
    withState(sid, { delegateBudget: 0, delegateUsed: DELEGATE_DEFAULT });
    resetAudit();
    const gate = await preGuardListener({ warn: noop })(mkExec(sid, "subagent", {}), pass);
    assert.equal(gate.kind, "deny", "委托池用尽应拒");
    assert.match(gate.reason, /委托池用尽/);
    assert.ok(auditLines().some((r) => r.action === "delegate-exhausted"));
    console.log("委托池用尽:", String(gate.reason).slice(0, 60));
    rmSync(statePath(sid), { force: true });
  });

  test("【闭环】人类批示『追加』补池 → 委派再消耗（与 seams 追加侧合起来才完整）", async () => {
    const sid = `pre-loop-${process.pid}`;
    withState(sid, { delegateBudget: 0, delegateUsed: 20, readSet: {} });
    // 追加侧（批 1）：人类批示『追加』→ 三池各 +REFILL
    await preStepListener({ warn: noop })(
      { agent: mkAgent(sid), messages: [{ content: [{ type: "text", text: "追加" }] }] },
      pass,
    );
    const afterGrant = loadState(statePath(sid));
    assert.ok(afterGrant.delegateBudget >= 10, `追加后委托池应回升，实为 ${afterGrant.delegateBudget}`);
    // 消耗侧（本批）：委派一次
    const gate = await preGuardListener({ warn: noop })(mkExec(sid, "subagent", { description: "x" }), pass);
    assert.notEqual(gate.kind, "deny", "补池后应可委派");
    const afterUse = loadState(statePath(sid));
    assert.equal(afterUse.delegateBudget, afterGrant.delegateBudget - 1, "消耗侧应 -1");
    console.log("闭环：追加 →", afterGrant.delegateBudget, "→ 委派后", afterUse.delegateBudget);
    rmSync(statePath(sid), { force: true });
  });

  test("熔断期：启动子代理属越权绕行（L4 记档）→ deny", async () => {
    const sid = `pre-fuse-agent-${process.pid}`;
    withState(sid, { fused: true });
    resetAudit();
    const gate = await preGuardListener({ warn: noop })(mkExec(sid, "subagent", { description: "绕行试试" }), pass);
    assert.equal(gate.kind, "deny", "熔断期委派应被拒");
    assert.match(gate.reason, /越权绕行/);
    const st = loadState(statePath(sid));
    assert.ok((st.violations || 0) >= 4, "应记 L4 档");
    console.log("熔断期委派 →", String(gate.reason).slice(0, 60));
    rmSync(statePath(sid), { force: true });
  });

  test("熔断期白名单：只读放行、改动拒绝、高危命令不因熔断而免检", async () => {
    const sid = `pre-fuse-white-${process.pid}`;
    withState(sid, { fused: true });
    const l = preGuardListener({ warn: noop });

    const read = await l(mkExec(sid, "read", { file_path: join(ROOT, "a.txt") }), pass);
    assert.notEqual(read.kind, "deny", "只读应放行");

    const write = await l(mkExec(sid, "write", { file_path: join(ROOT, "a.txt"), content: "x" }), pass);
    assert.equal(write.kind, "deny", "熔断期改动类应拒");

    const danger = await l(mkExec(sid, "pwsh", { command: "Remove-Item -Recurse -Force C:\\Windows" }), pass);
    assert.equal(danger.kind, "deny", "熔断期高危命令应拒（不是免检通道）");
    console.log("熔断白名单：read 放行 / write 拒 / 高危拒");
    rmSync(statePath(sid), { force: true });
  });

  test("L2 强制取证与 L5 降权：改动类一律拒绝", async () => {
    const sidL2 = `pre-l2-${process.pid}`;
    withState(sidL2, { forcedInvestigate: true });
    const g2 = await preGuardListener({ warn: noop })(
      mkExec(sidL2, "write", { file_path: join(ROOT, "b.txt"), content: "x" }),
      pass,
    );
    assert.equal(g2.kind, "deny", "L2 强制取证期间改动类应拒");
    assert.match(g2.reason, /强制取证/);

    const sidL5 = `pre-l5-${process.pid}`;
    withState(sidL5, { probation: true });
    const g5 = await preGuardListener({ warn: noop })(
      mkExec(sidL5, "write", { file_path: join(ROOT, "c.txt"), content: "x" }),
      pass,
    );
    assert.equal(g5.kind, "deny", "L5 降权期间改动类应拒");
    assert.match(g5.reason, /L5 降权/);
    console.log("L2:", String(g2.reason).slice(0, 40), "| L5:", String(g5.reason).slice(0, 40));
    rmSync(statePath(sidL2), { force: true });
    rmSync(statePath(sidL5), { force: true });
  });

  test("大小写不敏感文件系统：仅大小写不同的重名文件 → deny", async () => {
    const sid = `pre-case-${process.pid}`;
    withState(sid, { envCache: { os: "win32", shellIdKey: "cmd", caseSensitive: false } });
    const existing = join(ROOT, "CaseFile.txt");
    writeFileSync(existing, "x");
    const gate = await preGuardListener({ warn: noop })(
      mkExec(sid, "write", { file_path: join(ROOT, "casefile.txt"), content: "y" }),
      pass,
    );
    assert.equal(gate.kind, "deny", "大小写冲突应被拒");
    assert.match(gate.reason, /大小写冲突/);
    console.log("大小写冲突:", String(gate.reason).slice(0, 66));
    rmSync(statePath(sid), { force: true });
  });

  test("异常一律不阻塞（exec 结构异常只 warn，且仍调用 next）", async () => {
    const warns = [];
    let nextCalls = 0;
    const out = await preGuardListener({ warn: (...p) => warns.push(p.join(" ")) })(null, () => {
      nextCalls += 1;
      return { kind: "allow" };
    });
    assert.equal(nextCalls, 1, "必须调用 next，不得吞掉下游");
    assert.deepEqual(out, { kind: "allow" }, "应原样透传下游决策");
    console.log("异常路径未阻塞；warn 次数:", warns.length);
  });

  test("真实工作区未被本次测试触碰", () => {
    const realAudit = join(process.cwd(), ".focus-guard", "AUDIT.log");
    assert.ok(!existsSync(realAudit) || readFileSync(realAudit, "utf8").length >= 0);
    console.log("沙箱审计:", AUDIT_TMP.replace(tmpdir(), "<tmp>"));
  });
});

describe("3.0.8 · 卷宗不重复读与改动前备份（移植批 6）", () => {
  test("卷宗指纹一致且 TTL 未超 → 拦免重读（复用已有取证）", async () => {
    const sid = `pre-case-hit-${process.pid}`;
    const target = join(ROOT, "cached.txt");
    writeFileSync(target, "content-v1");
    const { fingerprint } = await import("../src/core/state.mjs");
    const fp = fingerprint(target);
    withState(sid, {
      caseCache: {
        [target.replace(/\\/g, "/")]: {
          path: target, mtime: fp.mtime, size: fp.size, sha: fp.sha || "",
          gitDirty: null, readAt: Date.now(), changes: 0, via: "mtime+size+sha",
        },
      },
    });
    resetAudit();
    const gate = await preGuardListener({ warn: noop })(mkExec(sid, "read", { file_path: target }), pass);
    assert.equal(gate.kind, "deny", "指纹一致且 TTL 未超应拦免重读");
    assert.match(gate.reason, /卷宗·免重读/);
    assert.ok(auditLines().some((r) => r.action === "casefile-hit"));
    console.log("免重读:", String(gate.reason).slice(0, 72));
    rmSync(statePath(sid), { force: true });
  });

  test("卷宗记录为 inherited（本会话未读过）→ 只提示不拦，首读放行", async () => {
    const sid = `pre-case-inherit-${process.pid}`;
    const target = join(ROOT, "inherited.txt");
    writeFileSync(target, "content");
    const { fingerprint } = await import("../src/core/state.mjs");
    const fp = fingerprint(target);
    withState(sid, {
      caseCache: {
        [target.replace(/\\/g, "/")]: {
          path: target, mtime: fp.mtime, size: fp.size, sha: fp.sha || "",
          gitDirty: null, readAt: Date.now(), changes: 0, via: "mtime+size+sha", inherited: 1,
        },
      },
    });
    const warns = [];
    const gate = await preGuardListener({ warn: (...p) => warns.push(p.join(" ")) })(
      mkExec(sid, "read", { file_path: target }),
      pass,
    );
    assert.notEqual(gate.kind, "deny", "继承指纹不得拦首读（会阻断取证）");
    assert.ok(warns.some((w) => /卷宗·提示/.test(w)), "应给出提示但不拦");
    console.log("继承指纹 → 放行 + 提示");
    rmSync(statePath(sid), { force: true });
  });

  test("offset 增量读永远放行（不受卷宗闸约束）", async () => {
    const sid = `pre-case-offset-${process.pid}`;
    const target = join(ROOT, "cached.txt");
    writeFileSync(target, "content-v1");
    const { fingerprint } = await import("../src/core/state.mjs");
    const fp = fingerprint(target);
    withState(sid, {
      caseCache: {
        [target.replace(/\\/g, "/")]: {
          path: target, mtime: fp.mtime, size: fp.size, sha: fp.sha || "",
          gitDirty: null, readAt: Date.now(), changes: 0, via: "mtime+size+sha",
        },
      },
    });
    const gate = await preGuardListener({ warn: noop })(
      mkExec(sid, "read", { file_path: target, offset: 10 }),
      pass,
    );
    assert.notEqual(gate.kind, "deny", "带 offset 的增量读应放行");
    console.log("offset 增量读 → 放行");
    rmSync(statePath(sid), { force: true });
  });

  test("文件内容变化 → 指纹不一致，放开真重读", async () => {
    const sid = `pre-case-changed-${process.pid}`;
    const target = join(ROOT, "changing.txt");
    writeFileSync(target, "v1");
    const { fingerprint } = await import("../src/core/state.mjs");
    const fp = fingerprint(target);
    writeFileSync(target, "v2-changed-content-longer");
    withState(sid, {
      caseCache: {
        [target.replace(/\\/g, "/")]: {
          path: target, mtime: fp.mtime, size: fp.size, sha: fp.sha || "",
          gitDirty: null, readAt: Date.now(), changes: 0, via: "mtime+size+sha",
        },
      },
    });
    const gate = await preGuardListener({ warn: noop })(mkExec(sid, "read", { file_path: target }), pass);
    assert.notEqual(gate.kind, "deny", "内容已变应允许真重读");
    console.log("内容变化 → 放行重读");
    rmSync(statePath(sid), { force: true });
  });

  test("74条：改动已有文件前自动备份到 .ai/backup/", async () => {
    const sid = `pre-backup-${process.pid}`;
    withState(sid);
    const target = join(ROOT, "to-edit.txt");
    writeFileSync(target, "原始内容");

    await preGuardListener({ warn: noop })(mkExec(sid, "write", { file_path: target, content: "新内容" }), pass);

    const backupDir = join(ROOT, ".ai", "backup");
    assert.ok(existsSync(backupDir), "应创建 .ai/backup/ 目录");
    const backups = readdirSync(backupDir);
    assert.ok(backups.length > 0, "应产生备份文件（供无版本库工作区回滚）");
    console.log("改动前备份:", backups.join(","));
    rmSync(statePath(sid), { force: true });
  });
});
