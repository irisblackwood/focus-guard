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

/**
 * 项目根。两处候选，按「谁更权威」排：
 *   ① 宿主显式声明的环境变量（Claude Code / ZCode 会设）；
 *   ② **hook 载荷里的 `cwd`**——协议本来就带，且宿主一定会填（桥的 `base()` 兜底是 process.cwd()）。
 *
 * 2026-11-15 修：此前只认 ①，取不到就返回 null。而 `guard.mjs start` 的**整个卷宗初始化**
 * 都包在 `if (projDir)` 里——① 缺失时 `.ai/CASE_FILE.md` 静默不生成，连一句提示都没有。
 * 别人的机器上就是这样：工具拦截照常工作（那几条缝不依赖 projDir），唯独卷宗不长。
 * 本机看不到，是因为作者机的宿主一直在环境里设 `CLAUDE_PROJECT_DIR`；测试套件又把它显式置空、
 * 改用 `ZCODE_PROJECT_DIR` 注入，于是「两个都没设」这条路径**从未被跑过**。
 *
 * **不拿 `process.cwd()` 兜底**，虽然看起来顺手：宿主起 hook 子进程时的 cwd 可能是安装目录，
 * 而测试正是靠"两个变量都置空"来隔离工作区——一旦兜底到 cwd，`npm test` 会往仓库根写卷宗
 * 与审计（实测 275 行漏进真实 AUDIT.log）。不确定写哪儿时，宁可不写。
 *
 * 判据不改成「猜一个目录」：每个候选都要 `statSync().isDirectory()` 过一遍，全不成立才返回 null。
 */
export function projectDir(input = {}) {
  const candidates = [process.env.ZCODE_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR, input && input.cwd];
  for (const d of candidates) {
    if (!d) continue;
    try {
      if (statSync(d).isDirectory()) return d;
    } catch {
      /* 该候选不可用，试下一个 */
    }
  }
  return null;
}
