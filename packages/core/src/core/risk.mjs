// FocusGuard 母版层 · risk 启发式（v3.0.5；《资料与代码分层总规范》二·1）
// 变更/侦查判定、稳定序列化与调用哈希、打回与记罚（独立于 harness 的判定接口）。
import {
  readFileSync, writeFileSync, rmSync, statSync, appendFileSync,
  mkdirSync, existsSync, renameSync, realpathSync, readdirSync, copyFileSync,
} from "node:fs";
import { join, dirname, sep, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { INTERP_EVAL_RE } from "./constants.mjs";
import { isMutatingBashCmd, FILE_REDIRECT_RE } from "./redlines.mjs";
import { audit } from "./audit.mjs";

export function isMutating(tool, ti, handoff) {
  if (tool === "Write" || tool === "Edit") return !handoff;
  if (tool === "Bash") {
    const cmd = String(ti.command || "");
    return isMutatingBashCmd(cmd) || FILE_REDIRECT_RE.test(cmd);
  }
  return false;
}

export function isInvestigation(tool, ti) {
  if (["Read", "Grep", "Glob", "WebSearch", "WebFetch"].includes(tool)) return true;
  if (/mcp__.*(web|search)/i.test(tool)) return true;
  if (tool === "Bash") {
    const cmd = String(ti.command || "");
    // 3.0.0 解释器黑名单（R5-3）：`python -c`/`node -e` 等等价任意代码执行，不得因"非变异"混入只读侦查
    // （否则熔断期白名单放行解释器=熔断失效，侦查池也被 eval 类命令挤占）
    return !isMutatingBashCmd(cmd) && !FILE_REDIRECT_RE.test(cmd) && !INTERP_EVAL_RE.test(cmd);
  }
  return false;
}

export function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map((k) => k + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v) ?? String(v);
}

export function callHash(input) {
  const sig = (input.tool_name || "?") + "|" + stable(input.tool_input ?? {});
  return sig.slice(0, 500);
}

export function collectStrings(v, out, budget) {
  if (typeof v === "string") {
    if (out.total < budget) {
      out.parts.push(v);
      out.total += v.length;
    }
  } else if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out, budget);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) collectStrings(x, out, budget);
  }
}

export function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

export function penalize(state, sid, trigger, evidence) {
  state.violations = (state.violations || 0) + 1;
  const level = Math.min(state.violations, 6);
  if (level >= 2) state.forcedInvestigate = true;
  if (level >= 3) state.fused = true;
  if (level >= 5) state.probation = true;
  audit(sid, trigger, { level, evidence });
  return level;
}

// ===== 3.0.1（七十五条(四)）批量审批：多条待批合并出示、一次批示；批示词容错后缀 =====
