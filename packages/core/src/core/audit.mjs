// FocusGuard 母版层 · 审计与因果链（v3.0.5；《资料与代码分层总规范》二·1）
// AUDIT.log 写入、seq/chain/ref 因果链上下文、假留痕防线（写失败一律上 stderr）。
// 2026-10-27：删掉从 guard.mjs 拆分时复制过来的未使用 import（13 个符号）。ESLint no-unused-vars 全量扫描发现。
import { statSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { rotateAuditIfNeeded, setAuditProjectDirProvider, resolveProjectDir } from "./audit-writer.mjs";
import { stateDir } from "./tempPath.mjs";

/** 最近一次解析出的审计路径（只供观测，**不要拿它当判据**——真正的缓存见 `auditFiles`）。 */
export let auditFile = null;

/**
 * 会话 → 审计路径。2026-11-15 由「进程级单值缓存」改为按会话缓存。
 *
 * 原来是 `if (auditFile !== null) return auditFile`：整个进程只认第一个解析结果。
 * 一个进程只服务一个工作区时看不出问题，但两个前提同时成立时就错了：
 *   ① 宿主进程并发服务多个会话（DSH 就是这样）；
 *   ② 兜底路径里带 sid（`focus-guard-<sid>-AUDIT.log`）——缓存后**第二个会话会写进第一个的文件**。
 * 现在 provider 能按 sid 给出各自的工作区，缓存必须跟着 key 走，否则登记得再准也没用。
 */
const auditFiles = new Map();
const AUDIT_CACHE_MAX = 128;

/**
 * 项目目录来源由**宿主适配层注入**（2026-10-22 分层泄漏修复）。
 * 母版不再直接读 `ZCODE_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` —— 那是替宿主代言，
 * 换宿主要改母版。ZCode 钩子在 `hooks/guard.mjs` 里注入，DSH 在 `src/dsh/index.js` 注入。
 *
 * 2026-11-16：定义点下沉到 `audit-writer.mjs`（DSH 侧 `appendAudit` 也要用同一个 provider），
 * 这里只做转发——对外 API `setProjectDirProvider` 不变，调用方无需改。
 */
export function setProjectDirProvider(fn) {
  setAuditProjectDirProvider(fn);
}

export function auditTarget(sid) {
  // S4（2026-11-01 红队）：`FG_AUDIT_FILE` 原本也走下面的 `auditFile` 缓存，于是**首次调用后
  // 再改这个环境变量就无效**（实测：设了新路径，auditTarget 仍返回旧路径）。长驻进程里是运维
  // 困扰，测试里是假绿来源——以为重定向了，其实还在写真实日志。显式路径不进缓存。
  const explicit = process.env.FG_AUDIT_FILE;
  if (explicit) return explicit;
  const key = String(sid ?? "");
  const hit = auditFiles.get(key);
  if (hit) return hit;
  // 2026-10-18 修（REPORT-2026-10-12 P1「审计单一入口未收敛」）：
  // 显式 FG_AUDIT_FILE 优先级最高。此前这里只认 ZCODE/CLAUDE 项目目录，于是
  // 测试把 FG_AUDIT_FILE 指向 tmpdir 时，走核心 audit() 的那条路（risk.mjs penalize()）
  // 仍然写真实 AUDIT.log —— 隔离形同虚设，CHANGELOG 的"零增长"实测不成立。
  let dir = "";
  // 2026-11-15：把 sid 交给 provider。宿主侧的工作区是按会话登记的（同一进程可能服务
  // 多个工作区），provider 不给参数就只能全局猜一个。旧 provider 忽略参数，行为不变。
  // 2026-11-16：provider 本体下沉到 audit-writer.mjs，这里取同一个实现（不另存一份变量）。
  dir = resolveProjectDir(sid);
  let resolved = "";
  if (dir) {
    try {
      if (statSync(dir).isDirectory()) resolved = join(dir, ".focus-guard", "AUDIT.log");
    } catch {}
  }
  if (!resolved) resolved = join(stateDir(), `focus-guard-${sid}-AUDIT.log`);
  if (auditFiles.size >= AUDIT_CACHE_MAX && !auditFiles.has(key)) {
    auditFiles.delete(auditFiles.keys().next().value);
  }
  auditFiles.set(key, resolved);
  auditFile = resolved;
  return resolved;
}

// 3.0.0 因果链：auditCtx 随每次钩子调用初始化；seq=时间戳36进制.调用内序号（全局唯一），
// chain=任务链（reset 起算，子代理委派派生 /dN 子链），ref=父事件 seq——流水账由此可渲染为因果图。
export let auditCtx = { chain: null, base: 0 };
export function auditChainInit(state) {
  auditCtx = { chain: (state && state.taskChain) || null, base: 0 };
}
export function audit(sid, trigger, opts = {}) {
  const seq = Date.now().toString(36) + "." + ++auditCtx.base;
  const record = JSON.stringify({
    ts: new Date().toISOString(),
    session: sid,
    // 2026-10-27：运行批次标识。审计隔离守卫靠它区分"测试链写的"与"宿主并发写的"——
    // 两者都落同一文件，只比行数时守卫分不开，会把宿主写入误报成隔离失效（实测 Δ 3 假阳性）。
    // 宿主进程没有这个环境变量 → 值为 null。
    run: process.env.FG_RUN_ID || null,
    seq,
    chain: opts.chain !== undefined ? opts.chain : auditCtx.chain,
    ref: opts.ref || null,
    action: opts.action || trigger,
    trigger: opts.trigger ?? trigger,
    level: opts.level ?? null,
    evidence: String(opts.evidence || "").slice(0, 200),
    pardon: !!opts.pardon,
  }) + "\n";
  // 2.5.1 假留痕防线：工作区写失败 → 回退系统临时目录；仍失败 → stderr 一行可见，绝不无声丢执法记录
  // 2026-10-29：补上体积轮转。此前只有 DSH 侧（audit-writer.appendAudit）轮转，母版这条路径不轮转——
  // 两条路写同一个文件，等于"谁先到 5MB 谁说了算"，只有 DSH 在跑时母版日志才会无界增长。
  const primary = auditTarget(sid);
  for (const p of [primary, join(stateDir(), `focus-guard-${sid}-AUDIT.log`)]) {
    try {
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 }); // P0-1 补②：审计日志同属取证数据，不给组/其他读
      if (p === primary) rotateAuditIfNeeded(p);
      appendFileSync(p, record);
      return seq;
    } catch {}
  }
  noteFail(sid, "AUDIT.log（工作区与临时目录均写入失败）");
  return seq;
}

/**
 * 留痕告急：只走 stderr，不抛错、不阻断。
 *
 * **「不阻断」和「看不见」是两件事。** 静默的代价是配错了也看不出来——所以这里
 * 宁可多一行 stderr 噪声，也不把失败吞掉；但反过来，也绝不因为留痕失败去阻断主流程
 * （审计是旁路，旁路故障不该升级成主路故障）。
 * （2026-11-01 取自外部参照 `memory-brain` 里 `think(verbose=)` 的那段权衡表述：
 * 「静默的代价是配错了也看不出来」。）
 */
export function noteFail(sid, what) {
  try {
    process.stderr.write(`[留痕告急]${what}，会话 ${sid} 的本次记录未落盘。\n`);
  } catch {}
}

