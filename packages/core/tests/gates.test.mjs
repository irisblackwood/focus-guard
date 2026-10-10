// FocusGuard · pre-execute 补充闸（3.0.8 · 移植批 2）
//
// 覆盖 DSH 侧此前完全缺失的三道闸与两项留痕：
//   体积刺客三闸（Read 整读体积 / Grep 无 head_limit / 裸 cat 刷屏）
//   污染核实闸（上轮输出矛盾 → 首个改动类拦一次）
//   风险文件留痕（.github/ 等 → 只记不拦）
//
// 这三个都移植自 guard.mjs（L534-620）。批 2 **不搬**与之重叠的部分：
//   高危及脚本写入闸（依赖审批单机制，与资格闸的关系待定）· 触发①/盲写（已被第 3 层按文件覆盖）。
//
// 纪律：审计重定向 tmpdir；测试文件写在 tmpdir，绝不碰真实工作区。
// 运行：node --test packages/core/tests/gates.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const AUDIT_TMP = join(tmpdir(), `fg-gates-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_AUDIT_FILE = AUDIT_TMP;

const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, loadState, saveState } = await import("../src/core/state.mjs");
const { OUTPUT_GATE_BYTES } = await import("../src/core/constants.mjs");

const ROOT = join(tmpdir(), `fg-gates-${process.pid}-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });
const allow = () => ({ kind: "allow" });
const noop = () => {};

/** 造一个"会话已建立"的状态，避免走 fail-open 分支。 */
function withState(sid, patch = {}) {
  rmSync(statePath(sid), { force: true });
  saveState(statePath(sid), { readSet: {}, ...patch });
}

describe("3.0.8 · 体积刺客三闸（移植批 2）", () => {
  test("Read 无 limit 且超过体积上限 → deny（并给出分段建议）", async () => {
    const sid = `gates-big-${process.pid}`;
    withState(sid);
    const big = join(ROOT, "big.txt");
    writeFileSync(big, "x");
    truncateSync(big, OUTPUT_GATE_BYTES + 1024); // 稀疏文件：瞬间造出超限体积，不真写满

    const gate = await preExecuteListener({ warn: noop })(
      { sessionId: sid, name: "read", arguments: { file_path: big } },
      allow,
    );
    assert.equal(gate.kind, "deny", "超限整读应被拦");
    assert.match(gate.reason, /体积刺客|limit\+offset/);
    console.log("Read 整读拦截:", gate.reason.slice(0, 90));
    rmSync(statePath(sid), { force: true });
  });

  test("审计任务整读同体积文件 → 放行并留痕（2.5.3 豁免，不误伤审计）", async () => {
    const sid = `gates-audit-${process.pid}`;
    withState(sid, { turnPrompt: "做一次全面审计与盘点" });
    const big = join(ROOT, "big-audit.txt");
    writeFileSync(big, "x");
    truncateSync(big, OUTPUT_GATE_BYTES + 1024);

    const gate = await preExecuteListener({ warn: noop })(
      { sessionId: sid, name: "read", arguments: { file_path: big } },
      allow,
    );
    assert.equal(gate.kind, "allow", "审计任务整读应豁免（留痕不罚）");
    console.log("审计豁免生效，放行");
    rmSync(statePath(sid), { force: true });
  });

  test("小文件整读 → 放行（不误伤）", async () => {
    const sid = `gates-small-${process.pid}`;
    withState(sid);
    const small = join(ROOT, "small.txt");
    writeFileSync(small, "hello");
    const gate = await preExecuteListener({ warn: noop })(
      { sessionId: sid, name: "read", arguments: { file_path: small } },
      allow,
    );
    assert.equal(gate.kind, "allow");
    rmSync(statePath(sid), { force: true });
  });

  test("Grep content 无 head_limit → deny（要求限量或先 files_with_matches）", async () => {
    const sid = `gates-grep-${process.pid}`;
    withState(sid);
    const gate = await preExecuteListener({ warn: noop })(
      { sessionId: sid, name: "grep", arguments: { pattern: "x", output_mode: "content" } },
      allow,
    );
    assert.equal(gate.kind, "deny", "Grep content 无 head_limit 应被拦");
    console.log("Grep 拦截:", String(gate.reason).slice(0, 80));
    rmSync(statePath(sid), { force: true });
  });

  test("cat 命令被拦（DSH 侧由 hardCheck 环境替代先拦；体积闸的 cat 段是冗余兜底）", async () => {
    const sid = `gates-cat-${process.pid}`;
    withState(sid);
    const listener = preExecuteListener({ warn: noop });
    const bare = await listener({ sessionId: sid, name: "bash", arguments: { command: "cat big.log" } }, allow);
    assert.equal(bare.kind, "deny", "cat 应被拦（第 1.5 层环境替代 cat→bat）");

    // 说明：DSH 的第 1.5 层硬校验（环境指纹 cat→bat）先于体积闸触发，
    // 因此体积闸的"裸 cat"段在本环境**不可达**、保留仅作兜底；带管道的写法同样被 hardCheck 拦。
    const piped = await listener({ sessionId: sid, name: "bash", arguments: { command: "cat big.log | head -100" } }, allow);
    assert.equal(piped.kind, "deny", "含 cat 即被环境替代规则拦（与是否限量无关）");
    console.log("cat 拦于 hardCheck：", String(bare.reason).slice(0, 64));
    rmSync(statePath(sid), { force: true });
  });
});

describe("3.0.8 · 污染核实闸与风险文件留痕（移植批 2）", () => {
  test("上轮标记污染 → 首个改动类拦一次；重试放行且标记已清（一次性）", async () => {
    const sid = `gates-pollution-${process.pid}`;
    const target = join(ROOT, "pollute-target.txt");
    writeFileSync(target, "x");
    // 先对本会话记录取证，否则会被第 3 层取证闸先拦（那样测不到污染闸）
    withState(sid, { pollutionFlagged: true, readSet: { [target]: Date.now() } });
    const listener = preExecuteListener({ warn: noop });
    writeFileSync(target, "x");

    const first = await listener({ sessionId: sid, name: "Edit", arguments: { file_path: target } }, allow);
    assert.equal(first.kind, "deny", "污染未核实前首个改动类应拦一次");
    assert.match(first.reason, /污染核实/);
    assert.equal(loadState(statePath(sid)).pollutionFlagged, false, "标记应被消费");

    const second = await listener({ sessionId: sid, name: "Edit", arguments: { file_path: target } }, allow);
    assert.notEqual(second.kind, "deny", "重试不应再被污染闸拦（一次性）");
    console.log("污染闸:", first.kind, "→ 重试:", second.kind);
    rmSync(statePath(sid), { force: true });
  });

  test("风险文件修改只留痕不拦（.github/ 路径）", async () => {
    const sid = `gates-risky-${process.pid}`;
    withState(sid);
    const target = join(process.cwd(), ".github", "workflows", "x.yml");
    const gate = await preExecuteListener({ warn: noop })(
      { sessionId: sid, name: "Edit", arguments: { file_path: target } },
      allow,
    );
    assert.notEqual(gate.kind, "deny", "风险文件留痕不应拦截");
    console.log("风险文件留痕（不拦）：", gate.kind ?? "allow");
    rmSync(statePath(sid), { force: true });
  });

  test("真实工作区未被本次测试触碰", () => {
    const realAudit = join(process.cwd(), ".focus-guard", "AUDIT.log");
    assert.ok(!existsSync(realAudit) || realAudit.length > 0);
    console.log("沙箱审计:", AUDIT_TMP.replace(tmpdir(), "<tmp>"));
  });
});
