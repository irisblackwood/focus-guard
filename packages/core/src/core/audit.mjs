// FocusGuard 母版层 · 审计与因果链（v3.0.5；《资料与代码分层总规范》二·1）
// AUDIT.log 写入、seq/chain/ref 因果链上下文、假留痕防线（写失败一律上 stderr）。
import {
  readFileSync, writeFileSync, rmSync, statSync, appendFileSync,
  mkdirSync, existsSync, renameSync, realpathSync, readdirSync, copyFileSync,
} from "node:fs";
import { join, dirname, sep, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export let auditFile = null;
export function auditTarget(sid) {
  if (auditFile !== null) return auditFile;
  const dir = process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || "";
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

