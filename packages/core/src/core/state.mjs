// FocusGuard 母版层 · 状态与卷宗（v3.0.5；《资料与代码分层自规范》二·1）
// 会话状态读写与陈旧清扫；卷宗【三】取证记录与 TTL 自适应；文件指纹与 git 脏检。
import {
  readFileSync, writeFileSync, rmSync, statSync, appendFileSync,
  mkdirSync, existsSync, renameSync, realpathSync, readdirSync, copyFileSync,
} from "node:fs";
import { join, dirname, sep, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { BUDGET_DEFAULT, INV_POOL_DEFAULT, SHA_LIMIT, CASE_MAX_ROWS, TTL_FIRST, TTL_RECENT, TTL_WEEK, TTL_STABLE, DELEGATE_DEFAULT, CASE_TEMPLATE } from "./constants.mjs";
import { noteFail, audit } from "./audit.mjs";
import { sid } from "./session.mjs";

export function statePath(id) {
  return join(tmpdir(), `focus-guard-${id}.json`);
}

export function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // 2.5.2：文件在但解析失败 = 熔断/已否决命令/审批标记全部清零，属"状态层面的假留痕"，
    // 必须让人类看见（与 2.5.1 的留痕防线同源）。首次运行无文件属正常，不告警。
    if (existsSync(path)) noteFail(sid, "会话状态损坏（已按默认值继续：熔断、已否决命令、审批标记全部丢失）");
    return {
      turnCount: 0,
      fused: false,
      stopBlocked: false,
      dumpCount: 0,
      mercy: false,
      violations: 0,
      forcedInvestigate: false,
      probation: false,
      writeOps: 0,
      readSet: {},
      turnPrompt: "",
      taskBudget: BUDGET_DEFAULT,
      declaredBudget: 0,
      effectiveCalls: 0,
      ineffCalls: 0,
      stalledStreak: 0,
      lastSig: "",
      lastInput: "",
      invCalls: 0,
      invCap: INV_POOL_DEFAULT,
      invWarned: false,
      envCache: null, // 环境检测结果即"已检测"的单一事实源（原 envChecked 布尔只写不读且可能与缓存不一致，2.5.1 删除）
      caseCache: {},
      taskInitial: BUDGET_DEFAULT,
      pollutionFlagged: false,
      goalPush: false, // 2.4.0：目标预授权（仅记录，不解锁执行）
      highRiskOk: false, // 2.4.0：执行级授权（仅当回合人类短指令 y/同意 可设置）
      highRiskCmd: "", // 2.4.0：待批/已批的高危命令原文（显示与审计用，>300 字符截断展示）
      highRiskKey: "", // 2.5.2：待批/已批命令的全量哈希（比对与"已否决"登记用，不受截断影响）
      highRiskDeniedThisTurn: false, // 2.4.0：本回合发生过高危拒绝（收尾须带审批单）
      rejectedCmds: {}, // 2.4.0：被人类 n 否决的命令（彻底阻断）
      scriptFiles: {}, // 2.4.0：写入过的脚本文件 → 内容是否含高危命令（绕行检测）
      delegateBudget: DELEGATE_DEFAULT, // 2.3.0：委托池 granted 上限（只升不降）
      delegateUsed: 0, // 2.3.0：委托池累计消耗
      delegated: false, // 2.3.0：本任务是否已委派过
      kpi: 0, // 2.3.0：委派 KPI 累计分
      kpiLowReported: false, // 2.5.1：KPI 跌破 -10 只提醒一次（回升后再跌破可再次提醒）
      kpiScolded: {}, // 2.3.0：每场景每任务只提醒一次
      kpiDelegatedAwarded: false, // 2.3.0：+5 每任务一次
      editedFiles: {}, // 2.3.0：本任务改过的文件集合（批量场景判定）
    };
  }
}

export function saveState(path, state) {
  // 2.5.2 原子落盘：先写同目录临时文件再 rename 覆盖。原直接 writeFileSync 在进程被中断时
  // 会留下半截 JSON（loadState 只能静默降级为默认值，等于整个会话状态凭空消失）。
  const tmp = path + "." + process.pid + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, path);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    noteFail(sid, "会话状态落盘（本次状态未保存，熔断/预算计数可能回退）");
  }
}

// 2.5.3（61条落地）：清理系统临时目录中 30 天未动的 focus-guard 状态/回退档案。
// 实测残留曾达 8376 个（测试与运行残留无限累积）；30 天未触碰即视为陈旧，会话启动时清扫。
export function cleanStaleTemp(sid) {
  try {
    const cutoff = Date.now() - 30 * 86400e3;
    let cleaned = 0;
    for (const f of readdirSync(tmpdir())) {
      if (!/^focus-guard-.*(\.json|-AUDIT\.log)$/.test(f)) continue;
      const fp = join(tmpdir(), f);
      try {
        if (statSync(fp).mtimeMs < cutoff) {
          rmSync(fp, { force: true });
          cleaned++;
        }
      } catch {}
    }
    if (cleaned) audit(sid, "stale-cleaned", { level: null, evidence: `61条 清理 ${cleaned} 个 30 天未动的临时状态/档案文件` });
  } catch {}
}

export function normalize(p) {
  return String(p || "").replace(/\\/g, "/");
}

// ============ 2.0 环境检测（总纲三：会话级一次，全程复用） ============

export function casePath(projDir) {
  return join(projDir, ".ai", "CASE_FILE.md");
}

export function ensureCaseFile(projDir) {
  const p = casePath(projDir);
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, CASE_TEMPLATE);
  }
  return p;
}

export function sectionOf(text, marker) {
  const re = new RegExp("### " + marker + "[\\s\\S]*?(?=\\n### |\\n## |$)");
  return (text.match(re) || [""])[0];
}

export function parseDur(s) {
  const m = String(s || "").trim().match(/^(\d+(?:\.\d+)?)\s*(分钟|小时|天|h|d|H|D)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2] || "小时";
  if (u === "分钟") return n * 60e3;
  if (u === "天" || u === "d" || u === "D") return n * 86400e3;
  return n * 3600e3;
}

export function loadCaseRecords(p) {
  const out = {};
  try {
    const t = readFileSync(p, "utf8");
    for (const line of sectionOf(t, "【三】").split("\n")) {
      if (!line.startsWith("|")) continue;
      const c = line.split("|").map((x) => x.trim());
      if (c.length < 9) continue;
      const [, f, readAt, mtime, size, sha, hist, ttl, via] = c;
      if (!f || f === "文件名" || /^-+$/.test(f)) continue;
      const hm = String(hist || "").match(/n=(\d+);?\s*last=(\S+)/);
      out[normalize(f)] = {
        path: f,
        readAt: Date.parse(readAt) || 0,
        mtime: parseFloat(mtime) || 0,
        size: parseInt(size, 10) || 0,
        sha: sha && sha !== "-" ? sha : "",
        changes: hm ? parseInt(hm[1], 10) || 0 : 0,
        lastChange: hm && hm[2] && hm[2] !== "-" ? Date.parse(hm[2]) || 0 : 0,
        ttlOverride: ttl || "",
        via: via || "mtime+size",
      };
    }
  } catch {}
  return out;
}

export function saveCaseRecords(projDir, records) {
  let tmp = null;
  try {
    const p = ensureCaseFile(projDir);
    tmp = p + "." + process.pid + ".tmp";
    let t = readFileSync(p, "utf8");
    const rows = Object.values(records)
      .sort((a, b) => (b.readAt || 0) - (a.readAt || 0))
      .slice(0, CASE_MAX_ROWS);
    const table = ["| 文件名 | 读取时间 | mtime | size | SHA-256 | 变更历史 | TTL | 验证方式 |", "|---|---|---|---|---|---|---|---|"]
      .concat(
        rows.map(
          (r) =>
            `| ${r.path} | ${new Date(r.readAt || Date.now()).toISOString()} | ${r.mtime} | ${r.size} | ${r.sha || "-"} | n=${r.changes || 0}; last=${r.lastChange ? new Date(r.lastChange).toISOString() : "-"} | ${r.ttlOverride || ""} | ${r.via || "mtime+size"} |`
        )
      )
      .join("\n");
    t = t.replace(/(### 【三】[\s\S]*?\n)\| 文件名 \|[\s\S]*?(?=\n### |\n## |$)/, (_m, head) => head + table + "\n");
    writeFileSync(tmp, t);
    renameSync(tmp, p);
  } catch {
    // FG-D3：rename 失败清理 .tmp 残片（对齐 saveState 防线，防 .ai/ 积累孤片）
    try { if (tmp) rmSync(tmp, { force: true }); } catch {}
    noteFail(sid, "卷宗【三】侦查记录");
  }
}

export function saveLedger(projDir, state) {
  let tmp = null;
  try {
    const p = ensureCaseFile(projDir);
    tmp = p + "." + process.pid + ".tmp";
    let t = readFileSync(p, "utf8");
    const eff = state.effectiveCalls || 0;
    const inv = state.invCalls || 0;
    const used = eff + inv;
    const row = `| ${new Date().toISOString().slice(0, 16)} | ${state.taskInitial ?? state.taskBudget ?? BUDGET_DEFAULT} | ${used} | ${Math.max(0, (state.taskBudget || BUDGET_DEFAULT) - used)} | ${eff} | ${state.ineffCalls || 0} | ${new Date().toISOString()} | KPI ${state.kpi || 0} |`;
    const table = ["| 任务 | 初始额度 | 已用额度 | 剩余额度 | 有效调用 | 无效调用 | 更新时间 | KPI |", "|---|---|---|---|---|---|---|---|", row].join("\n");
    t = t.replace(/### 【四】[\s\S]*?(?=\n### |\n## |$)/, () => "### 【四】工作额度台账\n\n" + table + "\n");
    writeFileSync(tmp, t);
    renameSync(tmp, p);
  } catch {
    // FG-D3：同上
    try { if (tmp) rmSync(tmp, { force: true }); } catch {}
    noteFail(sid, "卷宗【四】额度台账");
  }
}

export function fingerprint(absPath) {
  const st = statSync(absPath);
  const fp = { mtime: st.mtimeMs, size: st.size, sha: "" };
  if (st.size <= SHA_LIMIT) fp.sha = createHash("sha256").update(readFileSync(absPath)).digest("hex").slice(0, 16);
  return fp;
}

export function gitDirty(projDir, absPath) {
  try {
    if (!projDir) return null;
    const rel = normalize(absPath).replace(normalize(projDir) + "/", "");
    const out = execFileSync("git", ["-C", projDir, "status", "--porcelain", "--", rel], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() ? 1 : 0;
  } catch {
    return null;
  }
}

// 总纲五：优先级 依赖声明 > 人工标注 > 自适应
export function resolveTTL(projDir, rec, filePath) {
  if (projDir) {
    try {
      const t = readFileSync(casePath(projDir), "utf8");
      for (const line of sectionOf(t, "【二】").split("\n")) {
        if (!line.startsWith("|")) continue;
        const c = line.split("|").map((x) => x.trim());
        if (c.length < 7) continue;
        const [, name, , ipath, , ttl] = c;
        const d = parseDur(ttl);
        if (!d || !ipath || ipath === "安装路径") continue;
        if (filePath.startsWith(normalize(ipath))) return { ms: d, src: `依赖声明:${name}` };
      }
    } catch {}
  }
  if (rec && rec.ttlOverride) {
    const d = parseDur(rec.ttlOverride);
    if (d) return { ms: d, src: "人工标注" };
  }
  if (!rec || !rec.lastChange) return { ms: TTL_FIRST, src: "自适应:首次4h" };
  const age = Date.now() - rec.lastChange;
  if (age >= 30 * 86400e3) return { ms: TTL_STABLE, src: "自适应:30天未变" };
  if (age >= 7 * 86400e3) return { ms: TTL_WEEK, src: "自适应:7-30天未变" };
  return { ms: TTL_RECENT, src: "自适应:7天内有变" };
}

// ============ 2.0 平台命令规则（总纲六：按检出 shell 适配） ============

