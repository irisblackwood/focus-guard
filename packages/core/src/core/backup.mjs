// FocusGuard 母版层 · 改动前备份（v3.0.5；《资料与代码分层总规范》二·1）
// .ai/backup/ 物理回滚副本，保留最近 BACKUP_KEEP 份；敏感文件不落明文。项目根由参数传入。
import {
  readFileSync, writeFileSync, rmSync, statSync, appendFileSync,
  mkdirSync, existsSync, renameSync, realpathSync, readdirSync, copyFileSync,
} from "node:fs";
import { join, dirname, sep, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SHA_LIMIT, BACKUP_KEEP, SECRET_FILE_RE } from "./constants.mjs";
import { normalize } from "./state.mjs";
import { audit, noteFail } from "./audit.mjs";
import { sid } from "./session.mjs";

export let backupSeq = 0; // 2.5.2：备份文件名加进程号+自增序号，避免同一毫秒内两次备份互相覆盖
// ============ 2.2.0 正面指引（一.2）：改动前自动备份 ============
// 回滚按环境自动选：有 .git → git restore；没有 → 本函数产出的 .ai/backup/ 物理副本覆盖还原。
// 备份改动前的现状，保留最近 BACKUP_KEEP 份（超出淘汰最旧）。>200KB 的文件有意跳过（避免拖慢大写入，
// README 已注明此上限）；失败不阻断执法，但一律上 stderr——静默会让 AI 误以为存在可回滚副本（2.5.1 假留痕防线）。
export function backupBeforeEdit(absPath, projDir) {
  try {
    const dir = projDir;
    if (!dir) return;
    const st = statSync(absPath);
    if (!st.isFile() || st.size > SHA_LIMIT) return;
    const rel = relative(dir, absPath);
    if (!rel || rel.startsWith("..")) return;
    // 2.5.2 敏感文件不落明文副本：.env/私钥/凭据一旦复制进 .ai/backup/，等于在工作区里多留若干份明文密钥。
    // 跳过备份并留痕 + 明确告知，避免 AI 误以为存在可回滚副本。
    if (SECRET_FILE_RE.test(normalize(absPath))) {
      audit(sid, "backup-skip-secret", { level: null, evidence: `敏感文件不落明文副本 ${rel}（回滚请用版本控制）` });
      process.stderr.write(`[备份跳过]${rel} 属敏感文件，不复制明文副本；回滚请用版本控制。\n`);
      return;
    }
    const root = join(dir, ".ai", "backup");
    const dest = join(root, rel + "." + Date.now().toString(36) + process.pid.toString(36) + (backupSeq++).toString(36) + ".bak");
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(absPath, dest);
    const all = [];
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else all.push([p, statSync(p).mtimeMs]);
      }
    })(root);
    if (all.length > BACKUP_KEEP) {
      all.sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < all.length - BACKUP_KEEP; i++) rmSync(all[i][0], { force: true });
    }
  } catch {
    noteFail(sid, `改动前备份 ${absPath}（无副本可回滚，改动仍会放行）`);
  }
}
