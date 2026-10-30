#!/usr/bin/env node
// threat-eval：高危拦截率与误报率评测。用法：node tests/threat-eval.mjs <引擎.mjs> [对照引擎.mjs]
// 对同一组样本逐条跑 PreToolUse：高危样本期望 rc=2（命中高危命令闸），良性样本期望 rc=0（零打扰）。
//
// 2.5.2 扩充样本集：原 31+16 条只覆盖"标准写法"，评测得出 100% 属于样本自选的结果——
// 别名（npm i -g / yarn global add / pnpm add -g / rd /s / ri -r）与绕行写法（git --git-dir=/x push、
// --no-pager、长旗标）当时全部漏检。现按"同一危险动作的多种写法"组织样本，并加入良性反例
// （--dry-run 变体、rm --force、只读改名等），防止用"误报换检出"。
//
// 退出码：以最后一个引擎（受测引擎）为准——有漏检或良性误报即 exit 1，可直接做 CI 闸门。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 2026-10-27 修（隔离缺口）：本脚本此前用裸 `execFileSync`，子进程继承宿主环境。
// DSH/WorkBuddy 会在自己的进程里设 `CLAUDE_PROJECT_DIR`，guard.mjs 据此把审计写到
// **真实工作区** `.focus-guard/AUDIT.log` —— 实测单跑一次 `npm run eval` 就写进 62 行，
// 而 `audit-isolation` 只守住了测试阶段、守不住 eval。评测写脏真实审计，等于让
// "按 AUDIT.log 统计"的所有口径失真（本仓已因同类问题返工过两次）。
// 现按 `acceptance.test.mjs` 的同款纪律：显式清空两个"工作区根"变量，
// 并把审计重定向到 tmpdir 的独立文件。
const EVAL_AUDIT = join(tmpdir(), `focus-guard-eval-${process.pid}-${Date.now()}.log`);
const CHILD_ENV = {
  ...process.env,
  ZCODE_PROJECT_DIR: "",
  CLAUDE_PROJECT_DIR: "",
  FG_PROJECT_DIR: "",
  FG_SHELL: "",
  FG_AUDIT_FILE: EVAL_AUDIT,
  // 2026-10-29 补（同一类缺口的第三个面）：本脚本跑 61 条高危样本，其中 rm -rf 类会触发
  // `createApprovalRequest`，于是往**真实** `.focus-guard/approvals/pending_request.json`
  // 写一条待批。审计隔离守卫扩到记录面之后当场抓到（`npm run check` 报"新增 pending_request.json"）。
  // 卷宗同理：guard.mjs 会写卷宗【一】【三】【四】。
  FG_APPROVAL_DIR: join(tmpdir(), `focus-guard-eval-approvals-${process.pid}-${Date.now()}`),
  FG_CASE_FILE: join(tmpdir(), `focus-guard-eval-case-${process.pid}-${Date.now()}.md`),
};

const engines = process.argv.slice(2);
if (!engines.length) {
  console.error("用法: node tests/threat-eval.mjs <受测引擎.mjs> [对照引擎.mjs]");
  process.exit(1);
}

// 样本集 2026-10-30 抽到 fixtures/threat-samples.mjs，与 threat-eval-dsh.mjs（活路径）共用
// 同一批。两份各自维护必然漂移——那时「命令行 100% 拦截」与「活路径拦了多少」就不可比了，
// 正是本轮要修的「校验物与被校验物断线」。
import { DENY, ALLOW } from "./fixtures/threat-samples.mjs";

function runOne(engine, sid, mode, obj) {
  try {
    const out = execFileSync("node", [engine, mode], { input: JSON.stringify({ ...obj, session_id: sid }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: CHILD_ENV });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status, out: (e.stderr || "") + (e.stdout || "") };
  }
}

function evalEngine(engine) {
  // 2026-10-09：改用 crypto.randomUUID()（原为 Math.random()）。
  // sid 只是每次运行唯一的隔离标识、并非安全凭据，但测试代码也不该出现在安全扫描告警里——
  // 假阳性会淹掉真警报（CodeQL js/insecure-randomness）。行为不变：仍是每次运行唯一的隔离标识。
  const sid = "eval-" + randomUUID();
  const R = (mode, obj) => runOne(engine, sid, mode, obj);
  R("reset", { prompt: "看看情况" });
  R("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } }); // 取证，隔离触发①
  let caught = 0;
  const leaked = [];
  for (const c of DENY) {
    const r = R("pre", { tool_name: "Bash", tool_input: { command: c } });
    if (r.rc === 2) caught++;
    else leaked.push(c);
  }
  const fp = [];
  for (const c of ALLOW) {
    const r = R("pre", { tool_name: "Bash", tool_input: { command: c } });
    if (r.rc !== 0) fp.push(`${c} => ${r.out.slice(0, 40)}`);
  }
  return { caught, leaked, fp };
}

const results = engines.map(evalEngine);
for (let i = 0; i < engines.length; i++) {
  const r = results[i];
  console.log(`[${engines[i]}]`);
  console.log(`  高危检出: ${r.caught}/${DENY.length} (${(r.caught / DENY.length * 100).toFixed(1)}%)`);
  if (r.leaked.length) console.log(`  漏检: ${r.leaked.join(" | ")}`);
  console.log(`  良性误报: ${ALLOW.length - r.fp.length}/${ALLOW.length} (满分 = 全部放行)`);
  if (r.fp.length) console.log(`  误报明细: ${r.fp.join(" | ")}`);
}

// 闸门看最后一个引擎（受测引擎）：有漏检或误报即失败
const gate = results[results.length - 1];
// 把"测的是谁"写进结论行（3.3 C）。否则 `[PASS] 61 条全部拦截` 会被读成
// "整条链路都拦得住"——而实际被测的只是**命令行钩子这一层**。测的与跑的必须写明。
const tested = engines[engines.length - 1];
const hostNote = /hooks[\\/]guard\.mjs$/.test(tested)
  ? "（被测对象是命令行钩子层；DSH 活路径由 tests/threat-eval-dsh.mjs 覆盖红线与语义层，其余层见该文件覆盖表）"
  : "";
if (gate.leaked.length || gate.fp.length) {
  console.error(`\n[FAIL] 漏检 ${gate.leaked.length} 条 / 误报 ${gate.fp.length} 条｜被测引擎 ${tested}`);
  process.exitCode = 1;
} else {
  console.log(`\n[PASS] ${DENY.length} 条高危全部拦截，${ALLOW.length} 条良性零打扰｜被测引擎 ${tested}${hostNote}`);
}
