// FocusGuard 母版层 · 改动前备份（v3.0.5；《资料与代码分层总规范》二·1）
// .ai/backup/ 物理回滚副本，保留最近 BACKUP_KEEP 份。
// 2026-11-01 红队 A1：覆盖面由**黑名单**改为**白名单**——只备份源码/文档/配置模板
//（`BACKUP_ALLOW_RE` / `BACKUP_ALLOW_NAME_RE`），其余一律跳过并留痕。理由见 constants.mjs。
// 项目根由参数传入。
// 2026-10-27：删掉从 guard.mjs 拆分时复制过来的未使用 import（11 个符号）。ESLint no-unused-vars 全量扫描发现。
import { rmSync, statSync, mkdirSync, readdirSync, copyFileSync, lstatSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import { SHA_LIMIT, BACKUP_KEEP, SECRET_FILE_RE, BACKUP_ALLOW_RE, BACKUP_ALLOW_NAME_RE } from "./constants.mjs";
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
    // A1（2026-11-01 红队）：原用 `statSync`，**跟随符号链接**。项目里放一个 `deploy/config.json`
    // 指向 `~/.ssh/id_rsa`，下面的 SECRET_FILE_RE 只看**链接名**（config.json 不匹配），
    // 而 `copyFileSync` 会把链接目标的私钥明文复制进 `.ai/backup/`。改 `lstat` 并对链接单独留痕。
    const st = lstatSync(absPath);
    if (st.isSymbolicLink()) {
      audit(sid, "backup-skip-link", { level: null, evidence: `符号链接不复制内容 ${absPath}（可能指向项目外）` });
      return;
    }
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
    // 2026-11-01 红队 A1 第二轮：判据反过来——**白名单**，只备份明确安全的类型。
    // 原先是黑名单：列出所有危险的东西，而危险的东西每天在长新格式，必然漏（实测漏 9/21）。
    // 现在改成"列出所有安全的东西"（源码/文档/配置模板），其余一律不备份并留痕。
    // 逃生口：`FG_BACKUP_ALLOW_ALL=1` 恢复旧行为（用户自己判断这份文件能不能落副本）。
    const allowed =
      process.env.FG_BACKUP_ALLOW_ALL === "1" ||
      BACKUP_ALLOW_RE.test(rel) ||
      BACKUP_ALLOW_NAME_RE.test(basename(rel));
    if (!allowed) {
      audit(sid, "backup-skip-unlisted", { level: null, evidence: `不在备份白名单（非源码/文档/配置模板），未复制 ${rel}` });
      return;
    }
    const root = join(dir, ".ai", "backup");
    const dest = join(root, rel + "." + Date.now().toString(36) + process.pid.toString(36) + (backupSeq++).toString(36) + ".bak");
    mkdirSync(dirname(dest), { recursive: true });
    // A1 补（2026-11-01 红队）：首次落盘时在 `.ai/` 下写一个**只忽略 backup/** 的 .gitignore。
    // 本仓把 `.ai/` 的排除写在自己的 `.git/info/exclude` 里——那是本机配置，**不随插件分发**；
    // 而 FG 写的是**用户的项目**，用户 `git add .` 就会把含明文凭据的副本收进版本库。
    // 只忽略 backup/ 而不是整个 .ai/：用户可能想提交 CASE_FILE.md 分享卷宗。
    // 顺序：必须在 mkdir 之后——`.ai/` 不存在时先写会 ENOENT 被 catch 吞掉。
    try {
      const gi = join(dir, ".ai", ".gitignore");
      if (!existsSync(gi)) writeFileSync(gi, "# focus-guard：改动前明文副本，不入库\nbackup/\n");
    } catch {}
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
