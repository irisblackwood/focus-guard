// FocusGuard 母版层 · risk 启发式（v3.0.5；《资料与代码分层总规范》二·1）
// 变更/侦查判定、稳定序列化与调用哈希、打回与记罚（独立于 harness 的判定接口）。
// 2026-10-27：删掉从 guard.mjs 拆分时复制过来的一批未使用 import（fs/path/os/crypto/child_process 共 19 个符号）。
// 本模块是纯判定，不读文件、不 spawn 子进程——那些能力留在宿主缝。ESLint no-unused-vars 全量扫描发现。
import { INTERP_EVAL_RE } from "./constants.mjs";
import { isMutatingBashCmd, FILE_REDIRECT_RE } from "./redlines.mjs";
import { audit } from "./audit.mjs";

/**
 * 工具语义注册表（2026-10-22 分层泄漏修复）
 *
 * 母版不该知道任何宿主的工具名（`Write` / `pwsh` / `mcp__…` 都是宿主方言）。
 * 适配层把自己宿主的名字注册成**语义类别**，母版只认语义：
 *   mutation（写盘/改配置/装包/构建）· shell（执行命令）· read（只读侦查）· other
 */
const KIND_BY_NAME = new Map()

/** @param {'mutation'|'shell'|'read'|'other'} kind @param {string[]} names */
export function registerToolKind(kind, names) {
  for (const n of names || []) {
    const key = String(n || "").toLowerCase();
    if (key) KIND_BY_NAME.set(key, kind);
  }
}

/**
 * 只读动作注册（2026-10-27）
 *
 * 有些工具同一个名字既可读也可写（`plugin_manager` 的 `list_plugins` 与 `install_bundle`）。
 * 名字级分类只能判「这个工具能不能写」，判不出「这一次是读还是写」；
 * 于是只读列举被当成"改动类且无路径"直接挡死，而真正的写动作（带 `target`）反而被
 * `pathOfTool` 把包名当文件路径放过去——拦反了。
 * 适配层把只读动作登记进来，取证闸按 (tool, action) 而不是只看工具名。
 */
const READ_ONLY_ACTIONS = new Map()

/** @param {string} tool @param {string[]} actions */
export function registerReadOnlyActions(tool, actions) {
  const key = String(tool || "").toLowerCase();
  if (!key) return;
  const set = READ_ONLY_ACTIONS.get(key) || new Set();
  for (const a of actions || []) set.add(String(a || "").toLowerCase());
  READ_ONLY_ACTIONS.set(key, set);
}

/** 本次调用是否是已登记的只读动作；未登记/无 action 一律按"非只读"（安全默认）。 */
export function isReadOnlyCall(tool, args) {
  const set = READ_ONLY_ACTIONS.get(String(tool || "").toLowerCase());
  if (!set) return false;
  const action = String((args && args.action) || "").toLowerCase();
  return Boolean(action) && set.has(action);
}

/**
 * MCP 工具名的动词兜底（2026-10-29 补口）
 *
 * 原正则要求动词**后面紧跟下划线**（`__write_`）。于是「工具名前缀 + 动词结尾」的命名
 * （`mcp__hindsight__hindsight_write`、`mcp__memory__memory_save`）全部落成 `other`
 * ——真正写库的工具绕过了取证闸（实测见 `tests/tool-kind-coverage.test.mjs`）。
 *
 * 放宽为 `_{1,2}` 分隔 + `(?:_|$)` 收尾：动词前一个或两个下划线、动词后是下划线或结尾，都算。
 * 代价是 `mcp__fs__pending_delete` 这类"动词当名词用"的查询工具会被判成 mutation。
 * 这是**故意的方向**：误判为改动类只多要一次取证（可被 `registerReadOnlyActions` 豁免），
 * 漏判会让写工具天生免检——两害相权。
 */
const MCP_MUTATION_RE =
  /^mcp__[\s\S]+?_{1,2}(?:write|create|update|delete|remove|move|copy|patch|apply|edit|save|install|uninstall|build|package|scaffold|deploy|upload|publish)(?:_|$)/;
/** MCP 只读兜底：名字里带 web/search 的（mutation 先判，故 `x_write_search` 仍算写）。 */
const MCP_READ_RE = /^mcp__.*(?:web|search)/;

/** 名字 → 语义类别；未注册返回 'other'（安全默认：既不算只读也不算改动）。 */
function semanticOf(tool) {
  const key = String(tool || "").toLowerCase();
  if (!key) return "other";
  const direct = KIND_BY_NAME.get(key);
  if (direct) return direct;
  // MCP 写盘/构建类工具统一按动词归为 mutation（适配层也会显式注册，这里是兜底）。
  if (MCP_MUTATION_RE.test(key)) return "mutation";
  if (MCP_READ_RE.test(key)) return "read";
  return "other";
}

/**
 * 工具名 → 语义类别（`other` = 未登记）。供启动自检发现"装了但没登记"的工具。
 *
 * 为什么需要这个出口：`other` 不是"不管"，而是两件具体的事——熔断期落 deny 分支
 * （`dsh/preGuard.mjs` 的 `gateFused`）、调用计入执行池而非侦查池（`core/progressPolicy.mjs`）。
 */
export function toolKindOf(tool) {
  return semanticOf(tool);
}

export function isMutating(tool, ti, handoff) {
  const kind = semanticOf(tool);
  if (kind === "mutation") return !handoff;
  if (kind === "shell") {
    const cmd = String((ti && ti.command) || "");
    return isMutatingBashCmd(cmd) || FILE_REDIRECT_RE.test(cmd);
  }
  return false;
}

export function isInvestigation(tool, ti) {
  const kind = semanticOf(tool);
  if (kind === "read") return true;
  if (kind === "shell") {
    const cmd = String((ti && ti.command) || "");
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
