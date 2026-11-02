// FocusGuard 母版层 · 状态与卷宗（v3.0.5；《资料与代码分层自规范》二·1）
// 会话状态读写与陈旧清扫；卷宗【三】取证记录与 TTL 自适应；文件指纹与 git 脏检。
// 2026-10-27：删掉从 guard.mjs 拆分时复制过来的未使用 import（6 个符号）。ESLint no-unused-vars 全量扫描发现。
import {
  readFileSync, writeFileSync, rmSync, statSync, mkdirSync,
  existsSync, renameSync, openSync, writeSync, closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { stateDir } from "./tempPath.mjs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { BUDGET_DEFAULT, INV_POOL_DEFAULT, SHA_LIMIT, CASE_MAX_ROWS, TTL_FIRST, TTL_FLOOR, TTL_CEIL, TTL_GAIN, DELEGATE_DEFAULT, CASE_TEMPLATE } from "./constants.mjs";
import { noteFail, audit } from "./audit.mjs";
import { sid } from "./session.mjs";

export function statePath(id) {
  // 2026-11-01（P0-1）：改落独立子目录。原先是 tmpdir() 根下平铺——730 个测试每个写一份且不删，
  // 实测 11,856 个条目堆在 %TEMP% 根目录，资源管理器打开即卡死。详见 tempPath.mjs 头注释。
  return join(stateDir(), `focus-guard-${id}.json`);
}

/**
 * 状态字段的最小类型收敛（2026-11-01 红队 R5）。
 *
 * 状态文件是**熔断决定的输入**：`fused` / `probation` / `taskBudget` 直接被闸门读。
 * 原实现 `JSON.parse` 后原样返回，于是 `{"fused":"false"}`（字符串）为真、
 * `{"taskBudget":-1}` 让预算判定恒负——一个写坏的状态文件就能让闸门反向工作。
 *
 * 不做签名（那是服务端的解法，插件不该背）。只做**类型收敛**：
 * 布尔字段非 `true` 一律为 `false`，计数字段非有限数一律为 0、负数归 0。
 * 代价是"合法但奇形怪状"的状态会被改写——可接受，状态由本程序自己写。
 */
function sanitizeState(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  for (const k of ["fused", "stopBlocked", "mercy", "forcedInvestigate", "probation", "delegated"]) {
    if (k in s) s[k] = s[k] === true;
  }
  for (const k of [
    "turnCount", "dumpCount", "violations", "writeOps", "taskBudget", "effectiveCalls",
    "ineffCalls", "invCalls", "invCap", "delegateBudget", "delegateUsed",
  ]) {
    if (k in s) {
      const n = Number(s[k]);
      s[k] = Number.isFinite(n) ? Math.max(0, n) : 0;
    }
  }
  if ("kpi" in s) {
    const n = Number(s.kpi);
    s.kpi = Number.isFinite(n) ? n : 0; // kpi 可负，只做有限性收敛
  }
  return s;
}

export function loadState(path) {
  try {
    const clean = sanitizeState(JSON.parse(readFileSync(path, "utf8")));
    if (!clean) throw new Error("state 不是对象");
    return clean;
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
  //
  // 2026-11-01（P0-1 补②）：临时文件名由 `path.<pid>.tmp` 改为**随机名 + 独占创建**。
  // 原写法有两个洞：
  //   ① pid 可预测。同机攻击者预先在该路径放符号链接，`writeFileSync` 会跟随链接改写目标文件
  //      （CWE-377 Insecure Temporary File / CWE-59 Link Following）。
  //   ② 固定名意味着同一路径上的并发保存互相踩中间态。
  // 改法：`openSync(tmp, 'wx', 0o600)` —— 'wx' = O_CREAT|O_EXCL，**已存在即失败且不跟随链接**；
  // 名字取 6 字节随机数，路径无法被预置。两条合起来，"预测到文件名"不再是攻击前提。
  // 权限 0o600：状态里有 fused / rejectedCmds，即熔断决定的输入，不该给组和其他人读。
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  let fd = -1;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); // P0-1：状态文件迁入子目录后，目录需按需创建
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, JSON.stringify(state));
    closeSync(fd);
    fd = -1;
    renameSync(tmp, path);
  } catch {
    if (fd >= 0) { try { closeSync(fd); } catch {} }
    try {
      rmSync(tmp, { force: true });
    } catch {}
    noteFail(sid, "会话状态落盘（本次状态未保存，熔断/预算计数可能回退）");
  }
}

// 陈旧状态清理已抽到 `staleCleanup.mjs`（2026-11-01）：本文件因红队补丁跨过 400 行门槛，
// 而清理逻辑与状态读写没有共享状态，独立成文件即可（切法同 `tempPath.mjs`）。
export { cleanStaleTemp } from "./staleCleanup.mjs";

export function normalize(p) {
  return String(p || "").replace(/\\/g, "/");
}

// ============ 2.0 环境检测（总纲三：会话级一次，全程复用） ============

/**
 * 卷宗路径。
 *
 * 2026-10-29：补上 `FG_CASE_FILE` 覆盖。此前只有成本台账那一节（`dsh/audit.mjs`）认这个变量，
 * 而【一】环境声明 /【三】侦查记录 /【四】额度台账全走本函数 → **测试想重定向也重定向不了**。
 * 实测：`npm run test:all` 会把一行额度台账写进真实 `.ai/CASE_FILE.md`
 *（审计隔离守卫只看 AUDIT.log，所以它一直报零增长 PASS）。
 * 与 `auditFilePath()` / `approvalDir()` 同一口径：默认落工作区，环境变量可重定向。
 */
export function casePath(projDir) {
  if (process.env.FG_CASE_FILE) return process.env.FG_CASE_FILE;
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

/** 卷宗表格单元格转义：`|` 会撑破列数（A3，2026-11-01 红队实测 8 列被撑成 11 段）。 */
function cell(v) {
  // 先转义反斜杠、再转义竖线：顺序反了会留下 `\|`（CodeQL incomplete-sanitization）
  return String(v ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function saveCaseRecords(projDir, records) {
  let tmp = null;
  try {
    const p = ensureCaseFile(projDir);
    // 此处仍是 `.<pid>.tmp` 可预测名——与 saveState 同一形态，但**不按同一缺陷处理**：
    // 落点是项目自己的 `.ai/`，不是世界可写的临时目录；能往那里放符号链接的人已经能直接改卷宗，
    // 加随机名只是零收益的复杂度。判据：临时目录共享才需要防预置。
    tmp = p + "." + process.pid + ".tmp";
    let t = readFileSync(p, "utf8");
    const rows = Object.values(records)
      .sort((a, b) => (b.readAt || 0) - (a.readAt || 0))
      .slice(0, CASE_MAX_ROWS);
    const table = ["| 文件名 | 读取时间 | mtime | size | SHA-256 | 变更历史 | TTL | 验证方式 |", "|---|---|---|---|---|---|---|---|"]
      .concat(
        rows.map(
          (r) =>
            `| ${cell(r.path)} | ${new Date(r.readAt || Date.now()).toISOString()} | ${r.mtime} | ${r.size} | ${r.sha || "-"} | n=${r.changes || 0}; last=${r.lastChange ? new Date(r.lastChange).toISOString() : "-"} | ${cell(r.ttlOverride || "")} | ${cell(r.via || "mtime+size")} |`
        )
      )
      .join("\n");
    // A3（2026-11-01 红队）：原正则 `\| 文件名 \|[\s\S]*?(?=\n### |\n## |$)` 从表头一路吃到
    // 下一个标题，把用户在【三】与【四】之间手写的内容**整段删掉**（实测：写在【三】后面的备注消失）。
    // 改为只替换**连续的表格行**——表头 + 所有以 `|` 开头的行，遇到第一个非表格行即停。
    // 判据：引擎只拥有它自己写的那些行，表格以外的字是用户的。
    t = t.replace(/(### 【三】[\s\S]*?\n)\| 文件名 \|[^\n]*(?:\n\|[^\n]*)*/, (_m, head) => head + table);
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
    // A3（2026-11-01 红队）：原正则 `### 【四】[\s\S]*?(?=\n### |\n## |$)` 在【四】是最后一节时
    // 一路吃到文件末尾，把用户写在其后的内容整段删掉（实测：手写备注消失）。
    // 改为只替换「标题行 + 空行 + 表格块」，表格以外的字留给用户。
    t = t.replace(/### 【四】[^\n]*(?:\n[ \t]*)*(?:\| 任务 \|[^\n]*(?:\n\|[^\n]*)*)?/, () => "### 【四】工作额度台账\n\n" + table);
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
  return adaptiveHalfLife(rec);
}

/**
 * 半衰期 S（3.4.0，判据变更经用户批示）
 *
 * 原先是四档阶梯：首次 4h / 7天内有变 2h / 7-30天 24h / 30天未变 7天。
 * 阶梯的问题不是数值，是**边界上跳变**——age 从 6.99 天跨到 7.01 天，
 * 重读期限从 2h 跳到 24h，12 倍。而且四档都是拍出来的常数，跟"这个文件到底稳不稳"无关。
 *
 * 半衰期把 S 定义成**可观测的量**：该文件最近多久没变过。
 * 语义是「已观察到多久没变，就假设还能保持多久」——不是估的，是量的。
 * 两端夹住：刚变过的（S→0）按 2h 兜底，长期不动的按 7 天封顶。
 * 变更次数 n 给温和增益（每次 +10%，n 封顶 5）：n=5 的文件是长期稳定样本，
 * 比 n=1 的单点观测可信，半衰期可放宽到 1.5 倍。
 */
export function halfLifeOf(rec, now = Date.now()) {
  if (!rec || !rec.lastChange) return TTL_FIRST;
  const quiet = Math.max(0, now - rec.lastChange);
  const gain = 1 + Math.min(rec.changes || 0, 5) * TTL_GAIN;
  return Math.min(TTL_CEIL, Math.max(TTL_FLOOR, quiet * gain));
}

/**
 * 保持度 R = 0.5^(已读时长 / S)，值域 (0,1]。
 * R < 0.5 即半衰期已过——这条记录还在卷宗里，但已不该被当作有效结论复用。
 * 体检命令（`npm run case:audit`）用的就是这条判据。
 */
export function retention(rec, now = Date.now()) {
  const s = halfLifeOf(rec, now);
  const age = Math.max(0, now - (rec?.readAt || 0));
  return Math.pow(0.5, age / s);
}

function adaptiveHalfLife(rec) {
  const ms = halfLifeOf(rec);
  if (!rec || !rec.lastChange) return { ms, src: "半衰期:首次4h" };
  const n = rec.changes || 0;
  return { ms, src: `半衰期:S=${(ms / 3600e3).toFixed(1)}h(n=${n})` };
}

// ============ 2.0 平台命令规则（总纲六：按检出 shell 适配） ============

