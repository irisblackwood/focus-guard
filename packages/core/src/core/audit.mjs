// FocusGuard 母版层 · 审计与因果链（v3.0.5；《资料与代码分层总规范》二·1）
// AUDIT.log 写入、seq/chain/ref 因果链上下文、假留痕防线（写失败一律上 stderr）。
// 2026-10-27：删掉从 guard.mjs 拆分时复制过来的未使用 import（13 个符号）。ESLint no-unused-vars 全量扫描发现。
import { statSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

export let auditFile = null;

/**
 * 项目目录来源由**宿主适配层注入**（2026-10-22 分层泄漏修复）。
 * 母版不再直接读 `ZCODE_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` —— 那是替宿主代言，
 * 换宿主要改母版。ZCode 钩子在 `hooks/guard.mjs` 里注入，DSH 在 `src/dsh/index.js` 注入。
 */
let projectDirProvider = null;
export function setProjectDirProvider(fn) {
  projectDirProvider = typeof fn === "function" ? fn : null;
}

export function auditTarget(sid) {
  if (auditFile !== null) return auditFile;
  // 2026-10-18 修（REPORT-2026-10-12 P1「审计单一入口未收敛」）：
  // 显式 FG_AUDIT_FILE 优先级最高。此前这里只认 ZCODE/CLAUDE 项目目录，于是
  // 测试把 FG_AUDIT_FILE 指向 tmpdir 时，走核心 audit() 的那条路（risk.mjs penalize()）
  // 仍然写真实 AUDIT.log —— 隔离形同虚设，CHANGELOG 的"零增长"实测不成立。
  const explicit = process.env.FG_AUDIT_FILE;
  if (explicit) {
    auditFile = explicit;
    return auditFile;
  }
  let dir = "";
  try {
    dir = (projectDirProvider && projectDirProvider()) || "";
  } catch {
    dir = "";
  }
  if (dir) {
    try {
      if (statSync(dir).isDirectory()) auditFile = join(dir, ".focus-guard", "AUDIT.log");
    } catch {}
  }
  if (!auditFile) auditFile = join(tmpdir(), `focus-guard-${sid}-AUDIT.log`);
  return auditFile;
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
  for (const p of [auditTarget(sid), join(tmpdir(), `focus-guard-${sid}-AUDIT.log`)]) {
    try {
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, record);
      return seq;
    } catch {}
  }
  noteFail(sid, "AUDIT.log（工作区与临时目录均写入失败）");
  return seq;
}

export function noteFail(sid, what) {
  try {
    process.stderr.write(`[留痕告急]${what}，会话 ${sid} 的本次记录未落盘。\n`);
  } catch {}
}

