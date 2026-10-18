// FocusGuard 适配层 · DSH hook 协议（v3.0.5；《资料与代码分层总规范》二·2）
// stdin 载荷解析、会话 ID 提取、项目根定位。harness 专有环境变量只出现在本层。
import {
  readFileSync, writeFileSync, rmSync, statSync, appendFileSync,
  mkdirSync, existsSync, renameSync, realpathSync, readdirSync, copyFileSync,
} from "node:fs";
import { join, dirname, sep, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function sessionId(input) {
  const id =
    input.session_id ||
    process.env.CLAUDE_SESSION_ID ||
    process.env.ZCODE_SESSION_ID ||
    "default";
  const raw = String(id);
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  // 2.5.2：消毒会撞名（proj/a 与 proj_a → 同一状态文件，熔断/审批/预算跨会话串味）。
  // 仅当发生替换时追加短哈希；正常 id 保持原样，不影响既有状态文件。
  return safe === raw ? safe : safe + "-" + createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

export function projectDir() {
  const d = process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || "";
  if (!d) return null;
  try {
    return statSync(d).isDirectory() ? d : null;
  } catch {
    return null;
  }
}
