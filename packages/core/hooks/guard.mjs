#!/usr/bin/env node
// focus-guard 护栏脚本 v3.0.4 — 卷宗体系（总纲 2.0.0）+ 《AI 履职执法模型 v3.0》+ 动态预算 + 协作治理（总纲 3.0.0）
// v3.0.0 增补：①因果链留痕（audit 带 seq/chain/ref，tools/audit-chain.mjs 渲染因果图）②KPI 兑现闭环
//   （收尾结算等次→委托池奖惩，二十七~三十二条部分机械化）③静态知识图书馆隔离（.ai/library/ 积木区
//   只读、便签只进 inbox/，读不占卷宗【三】）④本地哨兵（FG_SENTINEL=1 启用 tools/sentinel.mjs 离线预判，
//   默认仅记档，strict 模式拦截）⑤解释器 eval 类命令不再判只读侦查（R5-3 解释器黑名单）⑥FG-D1~D4 修复。
// v3.0.1 增补（七十五条(四)）：⑦高危批量审批——多条待批合并出示，y 放行全部待批（各一次）、n 全部阻断；
//   ⑧批示词容错——y/同意/批准等批示词后接分隔符与简短补充指令（总长≤30字符）仍构成批示。
// v3.0.2 增补：⑨批示词头尾皆可（"…，y" 尾置亦构成批示）⑩外接三件套桥（viking-bridge /
//   audit-chain --semantica / needle2-sentinel）落于 external-bridges 分支，主分支为无外接精简版（3.0.3）。
// 一、空气层：不查词、不打扰（违禁词扫描已废除）
// 二、触发层：行为违规即罚，梯度处罚 L1-L6；触发④=动态预算+进度检测；三预算池(侦查/执行/委托，20条)
// 三、卷宗层(2.0)：.ai/CASE_FILE.md 四册（环境声明/依赖声明/侦查记录/额度台账）
//     会话级环境检测一次全程复用（仅 shell 变化时重检）；跨回合取证指纹
//     （mtime+size+SHA-256≤200KB+git 脏态）防伪；自适应 TTL+依赖声明/人工标注覆盖；
//     指纹一致且 TTL 未超 → 免重读放行（拦截本次 Read，复用已有取证）
// 四、平台层(2.0)：按检出 shell 适配命令规则（PS 禁 bash 管道 / macOS BSD 限制 / 大小写冲突拦截）
// 五、抽查层：盲写检测 / 风险文件 100% 留痕 / 每 5 次写操作全量审计 / 上下文污染检测(58条)
// 六、留痕层：执法 → <工作区>/.focus-guard/AUDIT.log (JSONL)；取证 → <工作区>/.ai/CASE_FILE.md
// v2.0.0 破坏性变更：旧 mtime 逐回合闸(49条 per-turn)废弃，由卷宗指纹+TTL 体系替代（总纲：不写兼容层）
// 模式:
//   start    (SessionStart)        环境检测 + 卷宗载入 + 注入执法模型
//   reset    (UserPromptSubmit)    批示 + 重置任务态（保留侦查缓存）+ shell 变化重检
//   pre      (PreToolUse)          平台规则 + 双规白名单 + 触发①③ + 盲写 + 卷宗免重读
//   post     (PostToolUse)         进度检测引擎 + 卷宗取证记录 + 抽查 + 污染检测
//   postfail (PostToolUseFailure)  失败=无进展，计入停滞
//   stop     (Stop)                回合边界 + 锚点核验 + 额度台账落卷
import {
  readFileSync, writeFileSync, rmSync, statSync, appendFileSync,
  mkdirSync, existsSync, renameSync, realpathSync, readdirSync, copyFileSync,
} from "node:fs";
import { join, dirname, sep, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { OUTPUT_GATE_BYTES, RANDOM_AUDIT_EVERY, BUDGET_DEFAULT, BUDGET_CAP, REFILL, STALL_FUSE, MERCY_SHORT, ENGINE_VERSION, INV_POOL_DEFAULT, SHA_LIMIT, CASE_MAX_ROWS, TTL_FIRST, TTL_RECENT, TTL_WEEK, TTL_STABLE, FUSE_PHRASE, FUSE_HINT, LIBRARY_RE, BLOCKS_RE, INTERP_EVAL_RE, HIGH_RISK_FORM, MERCY_RE, CREDIT_RE, STOP_ORDER_RE, TASK_SCALE_RE, KEY50_RE, KEY15_RE, PARDON_DECL_RE, PARDON_PENDING_RE, PARDON_QUOTE_RE, PARDON_BASIS_RE, AUTH_SEMANTICS_RE, DOWNGRADE_MARKERS, EVIDENCE_ANCHORS, RISKY_FILE_RE, SECRET_FILE_RE, BACKUP_KEEP, DELEGATE_DEFAULT, DOWNGRADE_MSG, SESSION_RULES, CASE_TEMPLATE, HIGH_RISK_QUEUE_MAX } from "../src/core/constants.mjs";
import { MUTATOR_HEAD_RE, CMD_PREFIX_RE, isMutatingBashCmd, FILE_REDIRECT_RE, DANGEROUS_PATTERNS, SQL_NOWHERE_RE, sqlNowhere, CURL_DATA_RE, SCRIPT_FILE_RE, GIT_OPT_WITH_VALUE, GIT_OPT_VALUELESS, gitHighRisk, cmdKey, isDangerousCmd } from "../src/core/redlines.mjs";
import { auditFile, auditTarget, auditCtx, auditChainInit, audit, noteFail } from "../src/core/audit.mjs";
import { isMutating, isInvestigation, stable, callHash, collectStrings, block, penalize } from "../src/core/risk.mjs";
import { bindSession, statePath, loadState, saveState, cleanStaleTemp, normalize, casePath, ensureCaseFile, sectionOf, parseDur, loadCaseRecords, saveCaseRecords, saveLedger, fingerprint, gitDirty, resolveTTL } from "../src/core/state.mjs";

// 2.0.1 热修：win32 shell 误判（PSModulePath 系统级恒存 → 误判 powershell → 平台禁令堵死 Git Bash 管道）
// 2.0.2 DSH 版：csproj/sln 列入风险文件备案（C# 项目配置与 package.json 同级）
// 2.2.0 正面指引版：git push 人类专属闸（二.3/五.3，本地 commit AI 可做、推送人类 UI 执行）
//   （该口径已于 2.4.0 废止：git push 并入高危特征库，走【高危申请】审批单，y 放行本次由 AI 执行、n 彻底阻断）
//   + 污染核实闸（三.1，输出矛盾后首个改动类先拦一次，要求先出【污染核实】声明）
//   + 改动前自动备份 .ai/backup/（一.2，无 .git 工作区的物理回滚依据）+ 熔断出口提示经验固化 PATTERNS.md（六.1）
// 2.3.0 委派条例：委托池独立核算（默认20次，不占执行池，批示『追加额度』执行/侦查/委托三池各+10）+ 子代理摘要格式校验
//   （【子代理摘要】四字段≤200字，否则拒收）+ 强制委派场景检测（全库搜索/大文档/批量处理，未委派 KPI-5）
//   + 熔断期启动子代理=越权绕行（L4记档+L5降权）+ 委派 KPI（+5/+3/-5/-3）
// 2.4.0 高危命令闸：完全访问下 rm 类命令仍须【高危命令申请】+人类批示，批准后逐字一致才放行；放松日常+刚性高危
// 2.5.0 DSH 硬拦截：官方桥 dsh-hooks-claude-code 直接运行本 hooks.json（exit 2 硬拦/ask 审批/stderr 原文透传），
//   取代 fire-and-forget 监察模式；Stop 载荷无收尾文本 → 锚点/审批单校验按 DSH 签名降级审计（防桥接续跑死循环）
//   （2.4.1 特征库加固与结构优化时引擎号曾漏升：manifest 2.4.1 / 引擎 2.4.0，2.5.0 已对齐）
// 2.5.1 盘点修复版：①假留痕防线——AUDIT/卷宗【三】【四】/改动前备份写失败一律上 stderr，禁止静默丢记录；
//   ②卷宗【一】环境声明落卷（此前仅占位符，人类无从查阅）；③42条源码路径适配"根即插件"布局、
//   市场源扫描不再写死 default 工作区；④58条路径查重改判"首 token 是路径"，避免 git 警告行误报且不放过裸相对路径；
//   ⑤委派 KPI 入额度台账并跨阈值提醒一次；⑥版本一致性自检用例（五处清单+引擎号+本头注释）
// 2.5.2 对抗审查版（两路独立审计后逐条复现修复）：
//   [P0] 熔断期白名单先 exit 0，导致 npm publish/shutil.rmtree/reg add 等"不在变更表里"的高危命令绕过审批——改为白名单前先判高危；
//   [P1] 中文批示词全部失效（正则用 \b 收尾，JS 的 \b 不认 CJK）——改精确整句匹配；「停止/熔断」批示被同一函数写回 false，止停令无效；
//   [P1] 高危命令超 300 字符后 y/n 永远匹配不上——比对键改为全量哈希（cmdKey），展示仍截断；
//   [P1] Stop 的部分打回路径没有一次性保护，可被无限重复触发——加 stopBlocked + stop_hook_active 双重闸，并放宽 DSH 无文本签名判定；
//   [P1] 变更类判定锚定段首，sudo/xargs 前缀与 cp 被当成"只读侦查"——改为按命令词识别并剥离前缀，补 cp/copy/rsync/sed -i 等；
//   [P1] 熔断期「查无实据」二次判定、reset 的 shell 重检此前无任何覆盖；quickShellId 把 zsh/sh 一律报成 bash，bash↔zsh 切换永不重检；
//   [P2] 敏感文件（.env/私钥/凭据）不再复制明文副本进 .ai/backup/；会话状态改原子落盘；损坏状态上 stderr 不再静默；
//   [P2] SQL 的 WHERE 豁免改为按语句判定；curl 的 -d 与 -D 区分大小写；补 find -delete/rimraf/wget post/Invoke-WebRequest POST；
//   [P2] 删除只写不读且无上限的 state.seen；备份/台账临时文件加进程号；会话 ID 消毒撞名以短哈希区分；抽查A 文案去掉"随机"（实现是确定性节奏）
// 2.5.3 亲历修复版（依 FG-纪审〔2026〕第1号处理意见书，2026-10-02 领导批示"可"）：
//   [案一] 卷宗继承指纹只提示不拦——会话启动从卷宗重建的取证记录不再触发免重读拦截
//          （内容不在本会话上下文，拦首读=阻断取证；会话内真读过后自动恢复拦截）；
//   [案三] 58条输出对账限单条语句——复合命令（&&/;/换行）里 head 只约束其段，整段对账有六起系统性误报；
//   [案二] 审计/盘点/审查批示下，取证对象整读留痕不罚（体积闸豁免），预算与巨量输出追责仍生效；
//   [防线] 卷宗【一】落卷与 PATTERNS.md 创建失败上 stderr（对齐 2.5.1 假留痕防线标准）；
//   [61条] 会话启动清扫临时目录中 30 天未动的 focus-guard 状态/档案文件（实测残留曾达 8376 个）。
let backupSeq = 0; // 2.5.2：备份文件名加进程号+自增序号，避免同一毫秒内两次备份互相覆盖

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function sessionId(input) {
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

function projectDir() {
  const d = process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || "";
  if (!d) return null;
  try {
    return statSync(d).isDirectory() ? d : null;
  } catch {
    return null;
  }
}

// ============ 2.2.0 正面指引（一.2）：改动前自动备份 ============
// 回滚按环境自动选：有 .git → git restore；没有 → 本函数产出的 .ai/backup/ 物理副本覆盖还原。
// 备份改动前的现状，保留最近 BACKUP_KEEP 份（超出淘汰最旧）。>200KB 的文件有意跳过（避免拖慢大写入，
// README 已注明此上限）；失败不阻断执法，但一律上 stderr——静默会让 AI 误以为存在可回滚副本（2.5.1 假留痕防线）。
function backupBeforeEdit(absPath) {
  try {
    const dir = projectDir();
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

function quickShellId() {
  if (process.platform === "win32") {
    const sh = String(process.env.SHELL || "");
    // 2.5.2：分别识别，别把 zsh/sh 一律报成 bash——旧写法 /bash|zsh|sh\b/ 命中后硬返回 "bash"，
    // 于是 bash↔zsh 之间的切换在总纲三的"shell 变化才重检"里永远检测不到。
    if (/bash/i.test(sh)) return "bash";
    if (/zsh/i.test(sh)) return "zsh";
    if (/(^|[\\/])sh(\.exe)?$/i.test(sh)) return "sh";
    // 2.0.1 修复：PSModulePath 系统级恒存（Windows PowerShell 5.0 起写入机器环境），
    // 不足以证明当前是 PowerShell 会话；仅认 pwsh7 特征路径 / ComSpec 指向 PowerShell。
    // 其余一律落 cmd/unknown → 不启用平台禁令（误判宁宽勿严，避免堵死 Git Bash 工作流）。
    const psm = String(process.env.PSModulePath || "");
    if (/Program Files[\\/]+PowerShell[\\/]+\d/i.test(psm) || /windowsapps[\\/]+microsoft\.powershell/i.test(psm)) return "powershell";
    const cs = String(process.env.ComSpec || "");
    if (/powershell/i.test(cs)) return "powershell";
    return cs.toLowerCase().includes("cmd") ? "cmd" : "unknown";
  }
  return String(process.env.SHELL || "sh").split(/[\\/]/).pop() || "sh";
}

function detectEnv() {
  const osName = process.platform;
  const shellIdKey = quickShellId();
  let shellVersion = "";
  try {
    if (shellIdKey === "powershell")
      shellVersion = execFileSync("powershell", ["-NoProfile", "-c", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 6000 }).trim();
    else if (shellIdKey === "zsh")
      shellVersion = (execFileSync("zsh", ["--version"], { encoding: "utf8", timeout: 6000 }).match(/(\S+)\s*$/) || [])[1] || "";
    else if (shellIdKey === "bash")
      shellVersion = (execFileSync("bash", ["--version"], { encoding: "utf8", timeout: 6000 }).match(/version\s+(\S+)/) || [])[1] || "";
  } catch {}
  let encoding = "UTF-8";
  if (osName === "win32") {
    try {
      const cp = execFileSync("cmd", ["/c", "chcp"], { encoding: "utf8", timeout: 6000 }).match(/(\d+)\s*$/);
      encoding = cp ? (cp[1] === "65001" ? "UTF-8" : cp[1] === "936" ? "GBK" : "CP" + cp[1]) : "unknown";
    } catch {}
  }
  // 大小写敏感：realpath 返回的盘上真实大小写与请求不同（仅大小写差异）→ 不敏感
  let caseSensitive = osName !== "win32";
  try {
    const probeDir = projectDir() || process.cwd();
    const real = realpathSync.native(probeDir);
    if (real !== String(probeDir) && real.toLowerCase() === String(probeDir).toLowerCase()) caseSensitive = false;
  } catch {}
  const bsd = osName === "darwin"; // darwin 的 sed/grep/awk 为 BSD 版
  const cmds = {};
  const dirs = String(process.env.PATH || "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const name of ["grep", "sed", "awk", "gsed", "greadlink"]) {
    cmds[name] = dirs.some((d) => {
      try {
        return statSync(join(d, name + (osName === "win32" ? ".exe" : ""))).isFile();
      } catch {
        return false;
      }
    });
  }
  return {
    os: osName,
    shellIdKey,
    shell: shellIdKey + (shellVersion ? " " + shellVersion : ""),
    encoding,
    pathSep: sep,
    caseSensitive,
    bsd,
    cmds,
    detectedAt: new Date().toISOString(),
  };
}

function platformBashViolation(env, cmd) {
  if (!env) return null;
  const c = String(cmd);
  if (env.os === "win32" && env.shellIdKey === "powershell") {
    if (/&&/.test(c)) return "Windows PowerShell 会话禁 &&：用 ; 分隔或分开执行";
    if (/\|\s*(head|grep|wc|sed|awk)\b/.test(c)) return "PowerShell 禁 bash 管道工具：用 Select-String / Measure-Object / Select-Object -First";
    if (/(^|[;&|]\s*)(cat|type|Get-Content)\s/i.test(c) && !/\|\s*Select-/.test(c) && !/-(TotalCount|First|Tail)\b/.test(c))
      return "禁裸 cat/type/Get-Content 刷屏：用 Get-Content -TotalCount N -Encoding UTF8";
  }
  if (env.os === "darwin") {
    if (/\bsed\s+-i(?!\s*['"])/.test(c)) return "macOS BSD sed：-i 必须带后缀参数（sed -i '' …）";
    if (/\bgrep\s+[^|;&]*?-P\b/.test(c)) return "macOS BSD grep 不支持 -P：用 -E";
    if (/\breadlink\s+-f\b/.test(c) && !/\bgreadlink\b/.test(c)) return "macOS 无 readlink -f：用 greadlink -f";
  }
  return null;
}

function pushHighRiskPending(state, key, cmdBrief) {
  if (!key) return;
  state.highRiskQueue = state.highRiskQueue || [];
  if (state.highRiskQueue.some((x) => x.k === key)) return;
  if (state.highRiskQueue.length >= HIGH_RISK_QUEUE_MAX) return;
  state.highRiskQueue.push({ k: key, c: String(cmdBrief || "").slice(0, 80) });
}
// 待批队列注记：除当前命令外还有几条在队列里，提示可合并批示
function queueNote(state, currentBrief) {
  const q = (state.highRiskQueue || []).filter((x) => x.c !== currentBrief);
  if (q.length < 1) return "";
  return `另有 ${q.length} 条待批已合并出示：${q.map((x) => x.c).join("；")}。回复 y 放行全部待批（各一次）、n 全部阻断。`;
}
// 授权消费（单条与批量统一）：命中即消费一次，且两槽同时清除——否则批量 y 放行的命令
// 会在单条槽消费后仍留在批量槽里，同一命令被无声放行两次（一次性语义被破坏）
function consumeHighRisk(state, key) {
  // 3.0.5 目标绑定：批示 y 后该目标键本会话内持续有效——同目标重复触达不再重复弹单
  // （修"一次一 attempt 消费制"被程序性拒绝烧掉批准、同目标反复弹单之痛，《审 2 号》同源）。
  // 每次命中仍逐一记档 high-risk-executed；n 批示即解除绑定；键为全量哈希，命令变体不受豁免。
  if (state.highRiskApprovedKeys && state.highRiskApprovedKeys[key]) {
    // 绑定命中：同步清空单条槽，保持"绑定映射"为唯一授权事实源
    state.highRiskOk = false;
    state.highRiskCmd = "";
    state.highRiskKey = "";
    return "bound";
  }
  let hit = false;
  if (state.highRiskOk && state.highRiskKey === key) {
    state.highRiskOk = false;
    state.highRiskCmd = "";
    state.highRiskKey = "";
    hit = true;
  }
  const batch = state.highRiskBatch || [];
  const i = batch.indexOf(key);
  if (i >= 0) {
    batch.splice(i, 1);
    state.highRiskBatch = batch;
    hit = true;
  }
  return hit;
}

function ladderNote(level) {
  if (level >= 6) return "L6：已上报人类。";
  if (level >= 5) return "L5：只读模式直至批示。";
  if (level >= 4) return "L4：已记档。";
  if (level >= 3) return "L3：等批示或降级方案。";
  if (level >= 2) return "L2：下一调用必须取证。";
  return "";
}

const mode = process.argv[2] || "";
const input = readStdinJson();
const sid = sessionId(input);
const path = statePath(sid);
bindSession(sid); // 母版层 state 模块的卷宗写入需要会话 ID（拆层后显式注入）

if (mode === "start") {
  rmSync(path, { force: true });
  cleanStaleTemp(sid); // 2.5.3（61条落地）：清扫临时目录 30 天未动的残留状态/档案
  // 2.0 环境检测：会话级一次，写入 state.envCache（总纲三）
  const env = detectEnv();
  // 2.0 卷宗载入：重建 readSetCache 与 TTL 表（总纲七）
  const st = loadState(path);
  st.envCache = env;
  st.taskChain = "S" + Date.now().toString(36); // 3.0.0 因果链：会话根链
  const projDir = projectDir();
  if (projDir) {
    // FG-D4：卷宗初始化包防御——工作区只读时 SessionStart 整体抛错违反降级哲学，改降级继续
    try {
      st.caseCache = loadCaseRecords(ensureCaseFile(projDir));
      // 2.5.3（案一）：会话启动从卷宗重建的取证记录标为"继承"——文件内容并不在本会话上下文中，
      // 据此免重读拦截会挡住合法首读。继承记录只提示不拦；本会话真读过后（post 重录指纹）自动转正。
      for (const k of Object.keys(st.caseCache)) st.caseCache[k].inherited = 1;
    } catch {
      noteFail(sid, "卷宗初始化（工作区可能只读，降级继续）");
    }
    try {
      // 2.5.1：卷宗【一】环境声明落卷（此前仅占位符，人类无法查阅——盘点报告半成品项）
      // FG-D2：改 tmp+rename 原子写（同文件另两处均为原子模式，此前此处崩溃窗可损坏 CASE_FILE.md）
      const cp = casePath(projDir);
      let t = readFileSync(cp, "utf8");
      const envRow = `- OS=${env.os} / Shell=${env.shellIdKey} / 大小写=${env.caseSensitive === false ? "不敏感" : "敏感"} / 编码=${env.encoding || "-"} / 检测于 ${new Date().toISOString()}`;
      t = t.replace(/### 【一】[\s\S]*?(?=\n### |\n## |$)/, () => `### 【一】环境声明（会话级检测，全程复用）\n\n${envRow}\n`);
      const tmp = cp + "." + process.pid + ".tmp";
      writeFileSync(tmp, t);
      renameSync(tmp, cp);
    } catch {
      noteFail(sid, "卷宗【一】环境声明落卷");
    }
  }
  saveState(path, st);
  let ctx = SESSION_RULES;
  if (projDir) {
    // 36条 异地交叉巡视：新会话接手 → 复核前任结论
    try {
      readFileSync(join(projDir, "HANDOFF.md"), "utf8");
      ctx += "\n【异地交叉巡视·36条】发现 HANDOFF.md：先读复核前任结论，未证实标【假设】。";
      audit(sid, "handover-inspect", { level: null, evidence: "36条 交叉巡视：发现 HANDOFF.md" });
    } catch {}
    // 42条 部署版本核验：运行引擎 vs 工作区源码
    for (const rel of ["packages/core/hooks/guard.mjs", "hooks/guard.mjs", "focus-guard/hooks/guard.mjs", "plugins/focus-guard/hooks/guard.mjs"]) {
      try {
        const m = readFileSync(join(projDir, rel), "utf8").slice(0, 400).match(/v(\d+\.\d+\.\d+)/);
        if (m && m[1] !== ENGINE_VERSION) {
          ctx += `\n【部署版本核验·42条】运行引擎 v${ENGINE_VERSION} ≠ 工作区源码 v${m[1]}（${rel}），疑似升级后未同步部署，请核验一致性。`;
          audit(sid, "version-check", { level: null, evidence: `42条 引擎 v${ENGINE_VERSION} vs 源码 v${m[1]} (${rel})` });
        }
        break;
      } catch {}
    }
  }
  // 立法法·第七章 规则备案：生效规则集登记（名称/版本/生效时间）
  audit(sid, "rules-registered", {
    level: null,
    evidence: `立法法(试行)v1.0 生效2026-09-29; 监督办法v1.0(docs/RULES.md); 引擎v${ENGINE_VERSION}`,
  });
  // 立法法·第七章 / 监督办法第九章 部署核验：注册表 ↔ 市场源 ↔ 运行引擎
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const reg = JSON.parse(
      readFileSync(join(home, ".zcode", "cli", "plugins", "installed_plugins.json"), "utf8")
    );
    const entry = (reg.plugins || []).find((p) => String(p.id || "").startsWith("focus-guard"));
    if (entry) {
      const regVer = String(basename(String(entry.installPath || "")));
      let srcVer = "";
      try {
        // 2.5.1：扫描全部工作区取市场源版本（不再写死 "default" 工作区名）
        const wsRoot = join(home, ".zcode", "workspace");
        for (const ws of readdirSync(wsRoot)) {
          try {
            srcVer =
              JSON.parse(
                readFileSync(join(wsRoot, ws, "plugins", "focus-guard", "marketplace.json"), "utf8")
              ).version || "";
            if (srcVer) break;
          } catch {}
        }
      } catch {}
      const drift = [];
      if (regVer && regVer !== ENGINE_VERSION) drift.push(`注册表v${regVer}`);
      if (srcVer && srcVer !== ENGINE_VERSION) drift.push(`市场源v${srcVer}`);
      if (drift.length) {
          ctx += `\n【部署版本核验】引擎v${ENGINE_VERSION} ≠ ${drift.join(" / ")}，存在部署漂移，请核验。`;
        audit(sid, "deploy-mismatch", { level: null, evidence: `立法法第七章 引擎v${ENGINE_VERSION} vs ${drift.join(" / ")}` });
      }
    }
  } catch {}

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: ctx,
      },
    })
  );
  process.exit(0);
}

if (mode === "reset") {
  // 批示：关键词预算/信用延期批复/特赦识别/追加批示；保留侦查缓存（caseCache/envCache 不清）
  const state = loadState(path);
  const promptText =
    typeof input.prompt === "string"
      ? input.prompt
      : typeof input.user_prompt === "string"
        ? input.user_prompt
        : "";
  const grant = promptText.match(MERCY_RE);
  const mercy = !!(grant && promptText.trim().length <= MERCY_SHORT);
  if (mercy) audit(sid, "mercy-granted", { level: null, evidence: `批示原文: ${grant[0]}`, pardon: true });
  // 2.4.0 三.1：目标预授权与执行级授权分离——任务指令里的『上传/推送』只记 goal，不解锁任何执行标记
  const goalPush = /上传|推送|push/i.test(promptText) && !/(不|禁|勿|别|暂|缓)[^，。；\n]{0,6}(上传|推送|push)/i.test(promptText);
  if (goalPush) audit(sid, "goal-preauth", { level: null, evidence: "goal=push-at-end（目标预授权，不构成执行级授权）" });

  // 总纲三：仅当明确探测到 shell 变化时重检环境
  if (state.envCache && state.envCache.shellIdKey && state.envCache.shellIdKey !== quickShellId()) {
    state.envCache = detectEnv();
    audit(sid, "env-redetect", { level: null, evidence: `shell 变化 → 重检为 ${state.envCache.shell}` });
  }

  let creditGranted = false;
  const short = promptText.trim();
  if (short.length <= 12 && (state.stalledStreak || 0) >= 2 && CREDIT_RE.test(short)) {
    state.stalledStreak = 0;
    state.taskBudget = Math.min((state.taskBudget || BUDGET_DEFAULT) + REFILL, BUDGET_CAP);
    state.invCap = Math.min((state.invCap || INV_POOL_DEFAULT) + REFILL, BUDGET_CAP); // 20条：侦查池同步追加
    state.invWarned = false;
    creditGranted = true;
  }
  const stopOrdered = short.length <= 12 && STOP_ORDER_RE.test(short);
  if (stopOrdered) {
    state.fused = true;
    state.violations = Math.max(state.violations || 0, 3);
    audit(sid, "stall-fuse", { level: 3, evidence: "人类批示停止" });
  }
  // 24条(三) 追加批示：明示追加 → 执行池/侦查池/委托池各+10
  if (short.length <= 12 && /追加|增加额度|扩大额度/.test(short)) {
    state.taskBudget = Math.min((state.taskBudget || BUDGET_DEFAULT) + REFILL, BUDGET_CAP);
    state.invCap = Math.min((state.invCap || INV_POOL_DEFAULT) + REFILL, BUDGET_CAP);
    state.invWarned = false;
    state.delegateBudget = Math.min((state.delegateBudget ?? DELEGATE_DEFAULT) + REFILL, BUDGET_CAP); // 2.3.0：委托池同步追加
    audit(sid, "budget-extend", { level: null, evidence: `24条(三) 追加批示 budget=${state.taskBudget} invCap=${state.invCap} delegate=${state.delegateBudget}` });
  }

  // 2.4.0 二.3/4：实时审批——执行级授权只认人类当回合短指令：y 放行本次，n 彻底阻断。
  // 2.5.2 修：①原正则以 \b 收尾，而 JS 的 \b 只认 ASCII 词字符，导致「同意/批准/不/拒绝」等中文批示全部失效
  //            （整个产品的操作界面是中文，按"同意"却一直待批、按"不"却不阻断）；改为"整条短指令就是一个批示词
  //            +可有尾标点"的精确匹配，顺带避免"是不是应该…"这类句子被误判成 y。
  //            ②比对键改用全量哈希（见 cmdKey）：超过 300 字符的命令此前永远等不到 y/n 匹配。
  // 3.0.2：批示词头尾皆可——句首（后接分隔符+补充）或句尾（分隔符前导，如"…，y"）均构成批示
  const Y_TOKEN = "(?:y|yes|是|好|行|ok|同意|批准|允许|可以|没问题|通过)";
  const N_TOKEN = "(?:n|no|不|不行|否|不要|拒绝|不许)";
  const LEAD = (tok) => new RegExp(`^${tok}(?:[\\s。！!，,]*$|[\\s]*[，,。：:！!][\\s]*\\S)`, "i");
  const TAIL = (tok) => new RegExp(`(?:^|[\\s，,。：:！!])${tok}[\\s。！!，,]*$`, "i");
  const yReply = short.length <= MERCY_SHORT && (LEAD(Y_TOKEN).test(short) || TAIL(Y_TOKEN).test(short));
  const nReply = short.length <= MERCY_SHORT && (LEAD(N_TOKEN).test(short) || TAIL(N_TOKEN).test(short));
  // 3.0.1（七十五条(四)）：y/n 放行全部待批（队列 + 当前），每条各消费一次；n 全部阻断。
  // 批示词容错：批示词 + 分隔符 + 简短补充指令（总长 ≤30 字符）仍构成批示——"y，规则改一下…"不再被吞。
  const pendingCount = (state.highRiskQueue || []).length + (state.highRiskKey ? 1 : 0);
  if (yReply && pendingCount > 0) {
    const keys = (state.highRiskQueue || []).map((x) => x.k);
    if (state.highRiskKey && !keys.includes(state.highRiskKey)) keys.push(state.highRiskKey);
    state.highRiskOk = true;
    state.highRiskBatch = keys;
    state.highRiskQueue = [];
    // 3.0.5 目标绑定：批示即绑定目标键（本会话有效），替代"一次一 attempt"消费制
    state.highRiskApprovedKeys = state.highRiskApprovedKeys || {};
    for (const k of keys) state.highRiskApprovedKeys[k] = true;
    audit(sid, "high-risk-approved", { level: null, evidence: `批示原文: ${short} | 放行 ${keys.length} 条待批（目标绑定）`, pardon: true });
  }
  if (nReply && pendingCount > 0) {
    state.rejectedCmds = state.rejectedCmds || {};
    const keys = (state.highRiskQueue || []).map((x) => x.k);
    if (state.highRiskKey && !keys.includes(state.highRiskKey)) keys.push(state.highRiskKey);
    for (const k of keys) state.rejectedCmds[String(k)] = 1;
    // 3.0.5：n 即彻底阻断——同步解除目标绑定，防止历史 y 豁免压过否决
    if (state.highRiskApprovedKeys) for (const k of keys) delete state.highRiskApprovedKeys[k];
    audit(sid, "high-risk-rejected", { level: null, evidence: `批示原文: ${short} | 已彻底阻断 ${keys.length} 条` });
    state.highRiskCmd = "";
    state.highRiskKey = "";
    state.highRiskQueue = [];
  }

  // 43条 状态重置核验：上一回合残留 → 记档报告后清理（本事件随后统一重置）
  const residues = [];
  if ((state.turnCount || 0) > 0) residues.push(`turnCount=${state.turnCount}`);
  if ((state.stalledStreak || 0) > 0) residues.push(`stall=${state.stalledStreak}`);
  if (state.fused && !stopOrdered) residues.push("fused");
  if (state.forcedInvestigate) residues.push("forcedInvestigate");
  if (state.stopBlocked) residues.push("stopBlocked");
  if (state.readSet && Object.keys(state.readSet).length) residues.push(`readSet=${Object.keys(state.readSet).length}`);
  if (residues.length) audit(sid, "residue-check", { level: null, evidence: `43条 残留(已清理): ${residues.join(" ")}` });

  const kw = KEY50_RE.test(promptText) ? 50 : KEY15_RE.test(promptText) ? 15 : BUDGET_DEFAULT;
  state.taskBudget = Math.max(kw, state.declaredBudget || 0, state.taskBudget || BUDGET_DEFAULT);
  state.taskInitial = state.taskBudget;
  state.ineffCalls = 0;
  state.taskChain = "T" + Date.now().toString(36); // 3.0.0 因果链：新任务起新链（随 saveState 落盘）

  saveState(path, {
    ...state, // envCache/caseCache（侦查缓存）随 spread 保留；kpi/delegateUsed（考核与委托台账）跨回合保留
    turnCount: 0,
    // 2.5.2：人类批示"停/熔断"必须真的生效。旧代码在此把 fused 硬写回 false、violations 清零，
    // 同一个函数前面刚设的止停令被自己抹掉——只有一行 AUDIT 记录，熔断等于没下。
    fused: stopOrdered,
    stopBlocked: false,
    mercy,
    goalPush, // 2.4.0：目标预授权仅记录，不构成执行级授权
    highRiskOk: yReply && (pendingCount > 0), // 2.4.0：执行级授权只认当回合人类短指令（3.0.1 含待批队列）
    highRiskDeniedThisTurn: false,
    violations: stopOrdered ? Math.max(state.violations || 0, 3) : 0,
    forcedInvestigate: false,
    probation: false,
    readSet: {},
    // 2.3.0：delegateBudget 跨回合保留（用尽须批示追加，不自动回满）；pollutionFlagged 有意不清（跨回合存活至消费）
    delegated: false, // 2.3.0：新回合重置委派标记与场景判定
    editedFiles: {},
    kpiScolded: {},
    kpiDelegatedAwarded: false,
    turnPrompt: promptText.slice(0, 500),
    turnPromptFull: promptText.slice(0, 4000), // FG-D1：授权引文核验窗口（批示含授权语义可能在 500 字符之外）
    taskBudget: state.taskBudget,
    taskInitial: state.taskInitial,
    lastSig: "",
    lastInput: "",
  });
  auditCtx.chain = state.taskChain; // 3.0.0：reset-fired 及其后事件挂新任务链（见上方 taskChain 赋值）
  audit(sid, "reset-fired", { level: null, evidence: `prompt:${promptText ? "有" : "无"} kw=${kw} budget=${state.taskBudget} eff=${state.effectiveCalls || 0} inv=${state.invCalls || 0} stall=${state.stalledStreak || 0}${creditGranted ? " 信用延期" : ""}${mercy ? " 特赦" : ""}` });
  process.exit(0);
}

if (mode === "pre") {
  const state = loadState(path);
  auditChainInit(state); // 3.0.0 因果链
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  const rawPath = ti.file_path || ti.path || "";
  const filePath = normalize(rawPath);
  const handoff = /^(Write|Edit)$/.test(tool) && /(^|\/)handoff\.md$/i.test(filePath);
  const search = /^(WebSearch|WebFetch)$/.test(tool) || /mcp__.*(web|search)/i.test(tool);
  const env = state.envCache || null;

  // ===== 3.0.0 本地哨兵（总纲 3.0.0 十五·二）：零成本离线预判，opt-in（FG_SENTINEL=1）=====
  // 默认 audit-only：flag 只记档；FG_SENTINEL_MODE=strict 时 block/flag 一律拦截。
  // 引擎内建启发式（tools/sentinel.mjs，零依赖）；CLI 侧可用 Needle 2（本地 45M 模型）跑 --model-cmd 外判。
  if (tool === "Bash" && /^(1|true)$/i.test(String(process.env.FG_SENTINEL || ""))) {
    try {
      const { assess } = await import(new URL("../tools/sentinel.mjs", import.meta.url).href);
      const v = assess(String(ti.command || ""));
      if (v.verdict === "block" || (v.verdict === "flag" && String(process.env.FG_SENTINEL_MODE || "") === "strict")) {
        audit(sid, "sentinel-deny", { level: null, evidence: `哨兵拦截 verdict=${v.verdict} score=${v.score} ${v.reasons.join(";")}` });
        process.stderr.write(`[本地哨兵]判定 ${v.verdict}（score ${v.score}）：${v.reasons.join("；")}。确需执行请走【高危申请】或批示关闭哨兵。`);
        process.exit(2);
      }
      if (v.verdict === "flag") {
        audit(sid, "sentinel-flag", { level: null, evidence: `哨兵标记 score=${v.score} ${v.reasons.join(";").slice(0, 150)}` });
      }
    } catch {} // 哨兵缺失/损坏不影响护栏主流程（降级哲学）
  }

  // ===== 3.0.5 资料分层隔离：静态资料区与派生积木区均不得直写（记忆更新隔离区，R6 采纳）=====
  if (/^(Write|Edit)$/.test(tool) && (LIBRARY_RE.test(filePath) || BLOCKS_RE.test(filePath))) {
    audit(sid, "library-write-deny", { level: null, evidence: `静态资料区直写被拒 ${filePath}` });
    process.stderr.write(
      `[图书馆·隔离]${filePath} 属静态资料区/派生积木区，不得直写。外部原文走同步三步（旧版归档 → 覆盖 → 写 frontmatter），派生积木由 library-build 生成到 .ai/output/library（防自我投毒）。`
    );
    process.exit(2);
  }

  // ===== 2.0 总纲六：环境规则检查（平台命令拦截）=====
  if (tool === "Bash") {
    const v = platformBashViolation(env, String(ti.command || ""));
    if (v) {
      audit(sid, "platform-deny", { level: null, evidence: `${env ? env.os + "/" + env.shellIdKey : "unknown"} ${v.slice(0, 100)}` });
      process.stderr.write(`[平台规则·${env ? env.os + "/" + env.shellIdKey : "?"}]${v}`);
      process.exit(2);
    }
  }
  // 2.0 总纲六：大小写不敏感文件系统 → 禁仅大小写不同的重名文件
  // 注意：不敏感 FS 上大小写变体目标的 existsSync 恒为 true，故不能以 existsSync 豁免
  if (/^(Write|Edit)$/.test(tool) && rawPath && env && env.caseSensitive === false) {
    try {
      const dirp = dirname(rawPath);
      const base = basename(rawPath);
      const clash = readdirSync(dirp).find((e) => e !== base && e.toLowerCase() === base.toLowerCase());
      if (clash) {
        audit(sid, "platform-deny", { level: null, evidence: `2.0平台 大小写冲突 ${base} vs ${clash}` });
        process.stderr.write(`[平台规则·大小写冲突]本文件系统大小写不敏感：${base} 与已有 ${clash} 仅大小写不同，创建后会互相覆盖。改名，或改用现有文件。`);
        process.exit(2);
      }
    } catch {}
  }

  if (tool === "Agent") {
    // 2.3.0 四：越权绕行边界——仅熔断期启动子代理属违规（L4 记档 + L5 降权）；正常委派放行不计违规
    if (state.fused) {
      state.violations = Math.max(state.violations || 0, 4);
      const lvl = penalize(state, sid, "violation-subagent-usurp", `56条 熔断期启动子代理 ${String(ti.description || ti.prompt || "").slice(0, 60)}`);
      saveState(path, state);
      process.stderr.write(
        `[越权绕行·L${lvl}]熔断期启动子代理执行被禁操作：L4 记档+L5 降权。只读可亲自查，或等批示。${ladderNote(lvl)}`
      );
      process.exit(2);
    }
    // 48条 子代理继承留痕：父会话处分状态随派单记录（平台无注入通道，以留痕方式移交）
    const spawnSeq = audit(sid, "subagent-spawn", {
      level: null,
      evidence: `48条 父状态 fused=${!!state.fused} L${state.violations || 0} eff=${state.effectiveCalls || 0} inv=${state.invCalls || 0} | ${String(ti.description || ti.prompt || "").slice(0, 60)}`,
    });
    // 3.0.0 蜂群因果链：每次委派派生子链 /dN，ref 指回派单事件——因果图上"主会话调度→子代理执行"成边
    state.childChainN = (state.childChainN || 0) + 1;
    var childChain = (state.taskChain || sid) + "/d" + state.childChainN;
    // 2.3.0 一：委托池独立核算（不占执行池；用尽须人类批示追加）
    if ((state.delegateBudget ?? DELEGATE_DEFAULT) <= 0) {
      audit(sid, "delegate-exhausted", { level: null, evidence: `2.3.0 委托池用尽 剩余=0 累计=${state.delegateUsed || 0}` });
      process.stderr.write(
        "[委托池用尽]子代理额度已用完（默认20次，独立于执行池）。请批示『追加额度』（执行/侦查/委托三池各+10），或主会话自行收敛。"
      );
      process.exit(2);
    }
    state.delegateBudget = (state.delegateBudget ?? DELEGATE_DEFAULT) - 1;
    state.delegateUsed = (state.delegateUsed || 0) + 1;
    state.delegated = true;
    saveState(path, state);
    audit(sid, "delegate-used", {
      chain: childChain,
      ref: spawnSeq,
      level: null,
      evidence: `2.3.0 委托池消耗 剩余=${state.delegateBudget} 累计=${state.delegateUsed} | ${String(ti.description || "").slice(0, 50)}`,
    });
  }

  // 触发⑤：熔断期白名单——只读调查类 + 降级动作放行，改动类拒绝（L3 放行只读工具）
  if (state.fused) {
    // 2.5.2 [P0] 熔断期不是高危命令的免检通道。旧顺序让白名单先 exit 0，于是
    // npm publish / shutil.rmtree / reg add / diskpart 等"不在 MUTATING 表里"的高危命令
    // 被 isInvestigation 判成只读侦查，直接绕过审批——"即使完全访问也须实时审批"的不变量在熔断期失效。
    if (tool === "Bash" && isDangerousCmd(String(ti.command || ""))) {
      audit(sid, "deny-shuanggui-highrisk", { level: 3, evidence: `熔断期高危命令被拒 ${String(ti.command).slice(0, 120)}` });
      process.stderr.write("[熔断期·高危命令]熔断期只读放行不含高危命令。此类命令即使解熔也须走【高危申请】审批，现在一律拒绝。\n");
      process.exit(2);
    }
    if (search || handoff || isInvestigation(tool, ti)) process.exit(0);
    audit(sid, "deny-shuanggui", { level: 3, evidence: `${tool} 熔断期改动类被拒` });
    process.stderr.write(DOWNGRADE_MSG);
    process.exit(2);
  }

  // L2 强制取证 / L5 降权：改动类操作一律拒绝
  if ((state.forcedInvestigate || state.probation) && isMutating(tool, ti, handoff)) {
    const lvl = state.probation ? 5 : 2;
    audit(sid, state.probation ? "deny-L5-probation" : "deny-L2-forced", { level: lvl, evidence: `${tool} ${filePath}` });
    process.stderr.write(
      state.probation
        ? "[L5 降权]只读模式，改动类全拒，等人类批示。"
        : "[L2 强制取证]下一调用必须是取证类，取证后自动解除。"
    );
    process.exit(2);
  }

  const mutating = isMutating(tool, ti, handoff);

  // ===== 2.4.0 高危命令闸（统一推送/删除/清盘/发布/包装绕行）：完全访问也须实时审批 =====
  if (tool === "Bash") {
    const cmdStr = String(ti.command || "");
    const scriptHits = (cmdStr.match(/[\w.\\\/-]+\.(sh|ps1|bat|cmd|py|pl|rb|mjs|cjs|js)\b/ig) || [])
      .map((t) => normalize(t))
      .filter((t) => (state.scriptFiles || {})[t] === "d");
    if (isDangerousCmd(cmdStr) || scriptHits.length) {
      if ((state.rejectedCmds || {})[cmdKey(cmdStr)]) {
        audit(sid, "high-risk-rejected", { level: null, evidence: `2.4.0 已否决命令再次尝试 ${cmdStr.slice(0, 120)}` });
        process.stderr.write("[高危命令闸·已否决]该命令已被人类批示 n，彻底阻断。如需变体，重新走【高危申请】。");
        process.exit(2);
      }
      if (consumeHighRisk(state, cmdKey(cmdStr))) { // 3.0.1：单条/批量统一消费，放行本次（一次性）
        saveState(path, state);
        audit(sid, "high-risk-executed", { level: null, evidence: `2.4.0 已批高危命令执行 ${cmdStr.slice(0, 120)}` });
      } else if (state.highRiskDeniedThisTurn && scriptHits.length) {
        state.violations = Math.max(state.violations || 0, 3); // 16条：对抗审查从重，至少落在 L4 记档
        const level = penalize(state, sid, "violation-wrap-bypass", `2.4.0 脚本包装绕过 ${scriptHits.join(",").slice(0, 80)}`);
        saveState(path, state);
        process.stderr.write(
          `[对抗审查·L${level}]高危命令被拒后改写脚本执行，按对抗审查记档。要执行请走【高危申请】审批，不得绕行。${ladderNote(level)}`
        );
        process.exit(2);
      } else {
        state.highRiskCmd = cmdStr.slice(0, 300);
        state.highRiskKey = cmdKey(cmdStr);
        state.highRiskDeniedThisTurn = true;
        pushHighRiskPending(state, state.highRiskKey, cmdStr.slice(0, 80));
        saveState(path, state);
        audit(sid, "high-risk-request", { level: null, evidence: `2.4.0 高危命令待批 ${cmdStr.slice(0, 120)}` });
        process.stderr.write(
          "[高危命令闸]命中高危特征库（删除/推送/清盘/发布/全局安装等），即使完全访问也须人类实时审批。" +
            `输出一行审批单：${HIGH_RISK_FORM} 人类回复 y 放行全部待批（各一次）、n 全部阻断；严禁改写脚本绕行（按对抗审查 L4 记档）。` +
            queueNote(state, cmdStr.slice(0, 80))
        );
        process.exit(2);
      }
    }
  }
  // 2.4.0：写脚本文件且内容含高危命令 → 写入本身走审批（源头拦包装）；被拒后继续写 → 对抗审查 L4
  if (/^(Write|Edit)$/.test(tool) && !handoff && filePath && SCRIPT_FILE_RE.test(filePath)) {
    const body = String(ti.content ?? "") + String(ti.new_string ?? "");
    if (isDangerousCmd(body)) {
      const key = cmdKey("write:" + filePath); // 2.5.2：脚本写入路径也改用全量哈希比对
      if (consumeHighRisk(state, key)) { // 3.0.1：单条/批量统一消费
        saveState(path, state);
        audit(sid, "high-risk-executed", { level: null, evidence: `2.4.0 已批高危脚本写入 ${filePath}` });
      } else if (
        state.highRiskDeniedThisTurn &&
        // 3.0.1 同源判定：只有"同回合被拒过的同一写入目标"重试才构成对抗审查；
        // 被拒的是 A 文件、随后写 B 文件的，走正常待批（此前不分目标连坐，L4 误伤跨目标写入）
        (state.highRiskKey === key || (state.highRiskQueue || []).some((x) => x.k === key))
      ) {
        state.violations = Math.max(state.violations || 0, 3); // 16条：对抗审查从重，至少落在 L4 记档
        const level = penalize(state, sid, "violation-wrap-bypass", `2.4.0 脚本包装绕过(写入·同源) ${filePath}`);
        saveState(path, state);
        process.stderr.write(
          `[对抗审查·L${level}]高危命令被拒后改写脚本继续，按对抗审查记档。要写入请走【高危申请】审批，不得绕行。${ladderNote(level)}`
        );
        process.exit(2);
      } else {
        state.highRiskCmd = ("write:" + filePath).slice(0, 300);
        state.highRiskKey = key;
        state.highRiskDeniedThisTurn = true;
        pushHighRiskPending(state, key, ("写入 " + filePath).slice(0, 80));
        saveState(path, state);
        audit(sid, "high-risk-request", { level: null, evidence: `2.4.0 高危脚本写入待批 ${filePath}` });
        process.stderr.write(
          `[高危命令闸]脚本内容含高危命令，写入同样须审批。${HIGH_RISK_FORM}（命令填：写入 ${filePath}），人类回复 y 放行全部待批（各一次）、n 全部阻断。` +
            queueNote(state, ("写入 " + filePath).slice(0, 80))
        );
        process.exit(2);
      }
    }
  }

  // 2.2.0 三.1：污染核实闸——上轮工具输出与指令参数矛盾且未核实前，首个改动类先拦一次（一次性，重试放行）
  if (state.pollutionFlagged && mutating) {
    state.pollutionFlagged = false;
    saveState(path, state);
    audit(sid, "pollution-gate", { level: null, evidence: `三.1 污染核实 ${tool} ${filePath}` });
    process.stderr.write(
      "[污染核实闸]上轮输出曾与参数矛盾（已记档）。先输出：【污染核实】预期X 实际Y，结论：可信/不可信/需重试，再重试本次修改。只读核验不受限。"
    );
    process.exit(2);
  }

  // 触发①：未取证就改（turnCount 为本回合调用数，由 stop 清零）
  if ((state.turnCount || 0) === 0 && mutating) {
    const level = penalize(state, sid, "violation-no-investigation", `${tool} ${filePath}`);
    saveState(path, state);
    process.stderr.write(
      `[触发①·L${level}]程序正义：本回合零调查即改文件/执行变更命令，拒绝。先 Read/Grep/只读命令取证再动手。${ladderNote(level)}`
    );
    process.exit(2);
  }

  // 抽查B前置：风险文件修改 100% 留痕（不拦，记录）
  if (/^(Write|Edit)$/.test(tool) && !handoff && (RISKY_FILE_RE.test(filePath) || /\.github\/|\.zcode-plugin\//.test(filePath))) {
    audit(sid, "risk-audit", { level: null, evidence: `风险文件修改 ${filePath}` });
  }

  // 抽查B强化（盲写检测）
  if (/^(Write|Edit)$/.test(tool) && !handoff && filePath && rawPath) {
    const read = (state.readSet || {})[filePath];
    if (!read) {
      let exists = false;
      try {
        exists = statSync(rawPath).isFile();
      } catch {}
      if (exists) {
        const level = penalize(state, sid, "violation-blind-write", `盲写未读文件 ${filePath}`);
        saveState(path, state);
        process.stderr.write(
          `[触发②·L${level}]盲写拦截：目标文件已存在但本回合未读过，先 Read 取证再改。${ladderNote(level)}`
        );
        process.exit(2);
      }
    }
  }

  // 触发③：体积刺客三闸
  if (tool === "Read" && !ti.limit && !ti.pages && rawPath) {
    try {
      const kb = Math.round(statSync(rawPath).size / 1024);
      if (kb * 1024 > OUTPUT_GATE_BYTES) {
        // 2.5.3（案二）：审计/盘点/审查类任务的取证对象整读留痕不罚——法典将审计定为 50 预算
        // 重大专项，体积闸却拦审计最需要的整读，属制度性误伤。预算与巨量输出追责仍生效。
        if (/审计|盘点|审查/.test(String(state.turnPromptFull || state.turnPrompt || ""))) {
          audit(sid, "audit-read-allow", { level: null, evidence: `${filePath} ${kb}KB 整读（审计任务豁免，留痕不罚）` });
          process.stderr.write(`[体积刺客·审计豁免]${filePath} ${kb}KB 整读已留痕（审计任务）。预算仍计费，巨量输出仍追责。`);
          process.exit(0);
        }
        const level = penalize(state, sid, "violation-read-gate", `${filePath} ${kb}KB 整读`);
        saveState(path, state);
        process.stderr.write(
          `[触发③·L${level}]体积刺客：${filePath} ${kb}KB，整读一次灌入、步步重复计费。limit+offset 分段或交子代理。${ladderNote(level)}`
        );
        process.exit(2);
      }
    } catch {}
  }

  if (tool === "Grep" && ti.output_mode === "content" && !ti.head_limit) {
    const level = penalize(state, sid, "violation-grep-gate", "Grep content 无 head_limit");
    saveState(path, state);
    process.stderr.write(
      `[触发③·L${level}]体积刺客：Grep content 必带 head_limit≤50，或先用 files_with_matches 定位。${ladderNote(level)}`
    );
    process.exit(2);
  }

  if (tool === "Bash") {
    const cmd = String(ti.command || "");
    if (/(^|[;&|]\s*)(cat|type|Get-Content)\s/i.test(cmd) && !cmd.includes("|") && !cmd.includes(">") && !/-(TotalCount|First|Tail)\b/.test(cmd)) {
      const level = penalize(state, sid, "violation-bash-gate", `裸 cat/type：${cmd.slice(0, 60)}`);
      saveState(path, state);
      process.stderr.write(
        `[触发③·L${level}]体积刺客：禁裸 cat/type 刷屏。cat x | head -100 或先 grep/wc 定位。${ladderNote(level)}`
      );
      process.exit(2);
    }
  }

  // ===== 2.0 总纲四：卷宗不重复读校验（跨回合）=====
  // 指纹一致（mtime+size+SHA/git）且 TTL 未超 → 免重读放行：拦截本次 Read，复用已有取证。
  // 指纹不一致 / TTL 超时 → 拦截免读资格，放行真重读（post 更新卷宗指纹）。
  // 熔断/强制取证期豁免：降级重建证据需要真重读。offset 增量读永远放行。
  if (tool === "Read" && rawPath && !ti.offset && !state.fused && !state.forcedInvestigate && !BLOCKS_RE.test(rawPath)) {
    // （3.0.5：派生积木免卷宗闸——积木指纹在 INDEX.md 固化且内容不可变，动态卷宗【三】不为其记账）
    try {
      const rec = (state.caseCache || {})[filePath];
      if (rec) {
        const fp = fingerprint(rawPath);
        const pDir = projectDir();
        const dirty = fp.sha ? null : gitDirty(pDir, rawPath);
        const changed =
          rec.mtime !== fp.mtime ||
          rec.size !== fp.size ||
          (rec.sha && fp.sha && rec.sha !== fp.sha) ||
          (rec.gitDirty !== null && rec.gitDirty !== undefined && dirty !== null && dirty !== rec.gitDirty);
        if (!changed) {
          const ttl = resolveTTL(pDir, rec, filePath);
          if (Date.now() - (rec.readAt || 0) < ttl.ms) {
            if (rec.inherited) {
              // 2.5.3（案一）：卷宗继承的指纹只提示不拦——本会话从未读过，内容不在上下文，
              // 拦首读即阻断取证。会话内真读过后（post 重录指纹），恢复免重读拦截。
              audit(sid, "casefile-inherit", { level: null, evidence: `2.0卷宗 继承指纹放行首读 ${filePath} ttl=${ttl.src}` });
              process.stderr.write(`[卷宗·提示]${filePath} 卷宗有近期取证（${ttl.src}），但本会话尚未读过——首读放行。`);
              process.exit(0);
            }
            audit(sid, "casefile-hit", { level: null, evidence: `2.0卷宗 免重读 ${filePath} ttl=${ttl.src}` });
            process.stderr.write(
              `[卷宗·免重读]${filePath} 指纹一致（${rec.via || "mtime+size"}）且 TTL 未超（${ttl.src}），勿重复整读；需新内容用 offset 增量读或请批示。`
            );
            process.exit(2);
          }
        }
      }
    } catch {}
  }

  // 2.2.0 一.2：所有闸通过、本次调用确定执行 → 备份改动前内容到 .ai/backup/（新文件无内容可备份，跳过）
  if (/^(Write|Edit)$/.test(tool) && !handoff && rawPath) backupBeforeEdit(rawPath);

  process.exit(0);
}

if (mode === "post" || mode === "postfail") {
  const state = loadState(path);
  auditChainInit(state); // 3.0.0 因果链
  let reason = null;

  state.turnCount = (state.turnCount || 0) + 1;
  // 2.5.2：删除只写不读且无上限的 state.seen（去重信号实际由 lastSig/lastInput 承担，该表只涨不用）

  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  // 2.4.1 结构优化：响应内容单次采样，进度/污染/追责/摘要/强制场景五处检查共用（此前重复遍历 5 次）
  const respProbe = { parts: [], total: 0 };
  if (mode === "post") collectStrings(input.tool_response ?? {}, respProbe, 200000);
  const respText = respProbe.parts.join("\n");

  // 取证销账：L2 强制取证由一次成功调查解除
  if (state.forcedInvestigate && mode === "post" && isInvestigation(tool, ti)) {
    state.forcedInvestigate = false;
    audit(sid, "L2-cleared", { level: 2, evidence: `${tool} 取证完成` });
  }

  // 本回合已读/已写文件集合（供盲写检测）：自己刚写过的文件内容已知，不构成盲写
  if (mode === "post") {
    state.readSet = state.readSet || {};
    if (ti.file_path && ["Read", "Write", "Edit"].includes(tool)) state.readSet[normalize(ti.file_path)] = 1;
    // 2.4.0：登记写入过的脚本文件及内容危险性（供脚本包装绕行检测）
    if ((tool === "Write" || tool === "Edit") && ti.file_path && SCRIPT_FILE_RE.test(String(ti.file_path))) {
      state.scriptFiles = state.scriptFiles || {};
      const body = String(ti.content ?? "") + String(ti.old_string ?? "") + String(ti.new_string ?? "");
      state.scriptFiles[normalize(ti.file_path)] = isDangerousCmd(body) ? "d" : "c";
    }
    if (tool === "Grep" && typeof ti.path === "string") state.readSet[normalize(ti.path)] = 1;
    // ===== 2.0 总纲四/七：更新侦查取证记录（指纹 + TTL 依据）=====
    // 3.0.5：派生积木不进卷宗【三】——积木内容不可变（指纹固化在 INDEX.md），动态卷宗只管动态工作区
    if (tool === "Read" && ti.file_path && !BLOCKS_RE.test(String(ti.file_path))) {
      try {
        const fp = fingerprint(ti.file_path);
        const key = normalize(ti.file_path);
        const cc = state.caseCache || {};
        const prev = cc[key];
        const changedFp = !!(prev && (prev.mtime !== fp.mtime || prev.size !== fp.size || (prev.sha && fp.sha && prev.sha !== fp.sha)));
        cc[key] = {
          path: ti.file_path,
          mtime: fp.mtime,
          size: fp.size,
          sha: fp.sha || "",
          gitDirty: fp.sha ? null : gitDirty(projectDir(), ti.file_path),
          readAt: Date.now(),
          changes: (prev ? prev.changes || 0 : 0) + (changedFp ? 1 : 0),
          lastChange: prev ? (changedFp ? Date.now() : prev.lastChange || 0) : 0,
          ttlOverride: prev ? prev.ttlOverride || "" : "",
          via: fp.sha ? "mtime+size+sha" : "mtime+size+git",
        };
        state.caseCache = cc;
        const ccKeys = Object.keys(cc);
        if (ccKeys.length > CASE_MAX_ROWS) {
          // 2.4.1 极限加固：卷宗缓存上限裁剪（按取证时间淘汰最旧），防长会话无界增长
          ccKeys.sort((a, b) => (cc[a].readAt || 0) - (cc[b].readAt || 0));
          for (const k of ccKeys.slice(0, ccKeys.length - CASE_MAX_ROWS)) delete cc[k];
        }
        const pDir = projectDir();
        if (pDir) saveCaseRecords(pDir, { ...loadCaseRecords(casePath(pDir)), ...cc });
      } catch {}
    }
  }

  // ===== 动态预算：进度检测引擎 =====
  let progress = false;
  if (mode === "post") {
    const contentSig = respText.slice(0, 1500);
    const inputSig = callHash(input);
    progress =
      (tool === "Write" || tool === "Edit") ||
      contentSig !== (state.lastSig ?? "") ||
      inputSig !== (state.lastInput ?? "");
    state.lastSig = contentSig;
    state.lastInput = inputSig;
  }

  const inv = isInvestigation(tool, ti);
  if (progress) {
    // 20条 三预算池：侦查(只读)/执行(改动)/委托(子代理，pre 阶段核算) 三池分列，不互相挤占
    if (tool === "Agent") {
      // 2.3.0：委派不占主会话执行池（委托池已在 pre 核算），仅计入进度
      state.stalledStreak = 0;
    } else if (inv) {
      state.invCalls = (state.invCalls || 0) + 1;
      state.stalledStreak = 0;
    } else {
      state.effectiveCalls = (state.effectiveCalls || 0) + 1;
      state.stalledStreak = 0;
    }
    if ((state.effectiveCalls || 0) >= BUDGET_CAP) {
      state.fused = true;
      state.violations = Math.max(state.violations || 0, 3);
      audit(sid, "stall-fuse", { level: 3, evidence: `硬上限：有效调用达 ${BUDGET_CAP}` });
      reason = `[触发④·L3]硬上限 ${BUDGET_CAP} 次，强制熔断。输出『${FUSE_PHRASE}』+三行降级方案，等批示。`;
    } else if ((state.effectiveCalls || 0) >= (state.taskBudget || BUDGET_DEFAULT)) {
      state.taskBudget = Math.min((state.taskBudget || BUDGET_DEFAULT) + REFILL, BUDGET_CAP);
      audit(sid, "budget-extend", { level: null, evidence: `自动续杯 budget=${state.taskBudget} eff=${state.effectiveCalls} stall=0` });
      reason = `[触发④]续杯：执行池 ${state.effectiveCalls} 次达阈值，预算+${REFILL}→${state.taskBudget}。任务继续，自查是否收敛。`;
    }
    if (inv && !state.invWarned && (state.invCalls || 0) > (state.invCap || INV_POOL_DEFAULT)) {
      state.invWarned = true;
      audit(sid, "inv-pool-exceeded", { level: null, evidence: `20条 侦查池超限 inv=${state.invCalls}/${state.invCap || INV_POOL_DEFAULT}` });
      reason = `[20条]侦查池（${state.invCap || INV_POOL_DEFAULT}次）超限。汇总证据请示追加（『追加额度』+10），或交子代理压缩侦查成本。`;
    }
  } else {
    state.stalledStreak = (state.stalledStreak || 0) + 1;
    state.ineffCalls = (state.ineffCalls || 0) + 1;
    if ((state.stalledStreak || 0) >= STALL_FUSE) {
      state.fused = true;
      state.violations = Math.max(state.violations || 0, 3);
      audit(sid, "stall-fuse", { level: 3, evidence: `连续 ${state.stalledStreak} 次无效调用 eff=${state.effectiveCalls || 0}` });
      reason = `[触发④·L3]真失控：连续 ${state.stalledStreak} 次无效调用。停止探索，输出『${FUSE_PHRASE}』+三行降级方案，或等批示。`;
    } else if ((state.stalledStreak || 0) === STALL_FUSE - 1) {
      audit(sid, "stall-warning", { level: null, evidence: `停滞 ${state.stalledStreak} 次 eff=${state.effectiveCalls || 0}` });
      reason = `[触发④]停滞预警：连续 ${state.stalledStreak} 次无效，再有一次即熔断。换有证据的方法，或结束回合发【信用延期】请批示。`;
    }
  }

  // 58条 上下文污染检测：工具输出与指令矛盾 → 停止使用该输出并报告人类
  if (!reason && mode === "post" && tool === "Bash") {
    const cmd = String(ti.command || "");
    const outLines = respText.split("\n").filter((l) => l.trim() !== "");
    // 2.5.3（案三）：输出对账只对"单条语句"有意义——复合命令（&& / ; / 换行分段）里 head 只约束
    // 其所在段，其余段的输出无法归因，整段对账曾产生六起系统性误报。复合命令跳过本检查，宁宽勿严；
    // 巨量输出仍有下方"体积刺客"事后追责兜底。管道 | 不分段：一条管道内 head 的承诺对整段输出有效。
    const stmts = cmd.split(/[;&\n]+/).map((s) => s.trim()).filter(Boolean);
    if (stmts.length === 1) {
      const hm = cmd.match(/\bhead\s+(?:-n\s*(\d{1,6})|-(\d{1,6}))\b/);
      if (hm) {
        const n = parseInt(hm[1] || hm[2], 10);
        if (n > 0 && outLines.length > n) {
          state.pollutionFlagged = true; // 2.2.0：标记可疑 → 下次改动前须出【污染核实】
          audit(sid, "ctx-pollution", { level: null, evidence: `58条 行数超限 head ${n} → 实际 ${outLines.length} 行 | ${cmd.slice(0, 60)}` });
          reason = `[38条·上下文污染]输出与指令矛盾：head ${n} 行实得 ${outLines.length}。停用本次输出，echo MARK-X 隔离核实并报告人类。`;
        }
      }
      if (!reason && /\b(find|git\s+(ls-files|ls-tree))\b/.test(cmd)) {
        const seen = new Set();
        let dup = "";
        for (const l of outLines) {
          if (seen.has(l)) { dup = l; break; }
          // 2.5.1：判定标准为"首 token 本身是路径"（./x/a.js、hooks/guard.mjs、C:\x\y 均算）：
          // 既排除 git 警告/说明等散文行（首 token 形如 warning:），又不放过 git ls-files 的裸相对路径
          const tok = l.trim().split(/\s+/)[0] || "";
          if (/[\/\\]/.test(tok) && !/[:：]$/.test(tok)) seen.add(l);
        }
        if (dup) {
          state.pollutionFlagged = true; // 2.2.0：标记可疑 → 下次改动前须出【污染核实】
          audit(sid, "ctx-pollution", { level: null, evidence: `58条 路径重复 ${dup.slice(0, 80)} | ${cmd.slice(0, 50)}` });
          reason = `[38条·上下文污染]清单出现不可能的重复路径（${dup.slice(0, 60)}）。停用本次输出，echo MARK-X 隔离核实并报告人类。`;
        }
      }
    }
  }

  // 巡视：Bash/Grep 巨量输出事后追责
  if (!reason && (tool === "Bash" || tool === "Grep")) {
    if (respProbe.total > OUTPUT_GATE_BYTES) {
      state.dumpCount = (state.dumpCount || 0) + 1;
      audit(sid, "scold-dump", { level: null, evidence: `${tool} 输出 ${Math.round(respProbe.total / 1024)}KB` });
      reason =
        `体积刺客：${tool} 输出 ${Math.round(respProbe.total / 1024)}KB 已入上下文。下次先 head/tail/wc/grep 过滤（累计 ${state.dumpCount} 次）。`;
    }
  }

  // ===== 2.3.0 二/五：子代理摘要格式校验（只收【子代理摘要】，≤200字）=====
  if (!reason && mode === "post" && tool === "Agent") {
    const sumText = respText;
    const fmtOk =
      /【子代理摘要】/.test(sumText) &&
      /任务[:：]/.test(sumText) &&
      /结果[:：]/.test(sumText) &&
      /异常[:：]/.test(sumText) &&
      /文件线索[:：]/.test(sumText);
    if (!fmtOk || sumText.length > 200) {
      state.kpi = (state.kpi || 0) - 3;
      audit(sid, "delegate-summary-pollution", { level: null, evidence: `2.3.0 摘要污染 -3 len=${sumText.length} fmt=${fmtOk ? "有" : "无"}` });
      reason =
        "[委派摘要拒收·KPI-3]超200字或缺字段，拒绝全量采纳。压缩为：【子代理摘要】任务：…｜结果：≤5条｜异常：…｜文件线索：文件:行号，以此继续。";
    } else {
      state.kpi = (state.kpi || 0) + 3;
      audit(sid, "kpi-summary-good", { level: null, evidence: `2.3.0 委派摘要合格 +3 len=${sumText.length}` });
    }
  }

  // ===== 2.3.0 三/五：强制委派场景检测（该委派不委派 → KPI-5 提醒；已委派 → KPI+5 一次）=====
  if (!reason && mode === "post") {
    const scLines = respText.split("\n").map((l) => l.trim()).filter(Boolean);
    const scPaths = scLines.filter((l) => /[\/\\]/.test(l) && l.length <= 200 && !/^(total|\.\.?|d[-rwx]|-[-rwx])/.test(l));
    const scDirs = new Set(scPaths.map((l) => l.replace(/[\/\\][^\/\\]*$/, "")));
    let scenario = "";
    if (tool === "Grep" || (tool === "Bash" && /\b(find|rg|grep)\b/i.test(String(ti.command || "")))) {
      if (scPaths.length >= 10 || scDirs.size >= 3) scenario = "全库搜索";
    } else if (tool === "Read" && ti.file_path) {
      let kb = 0;
      try { kb = statSync(ti.file_path).size / 1024; } catch {}
      if (kb > OUTPUT_GATE_BYTES / 1024 || scLines.length > 2000) scenario = "大文档摘要";
    } else if ((tool === "Write" || tool === "Edit") && ti.file_path) {
      state.editedFiles = state.editedFiles || {};
      state.editedFiles[normalize(ti.file_path)] = 1;
      if (Object.keys(state.editedFiles).length >= 5) scenario = "批量文件处理";
    }
    if (scenario) {
      if (state.delegated) {
        if (!state.kpiDelegatedAwarded) {
          state.kpiDelegatedAwarded = true;
          state.kpi = (state.kpi || 0) + 5;
          audit(sid, "kpi-delegated", { level: null, evidence: `2.3.0 强制场景已委派 +5 ${scenario}` });
        }
      } else {
        state.kpiScolded = state.kpiScolded || {};
        const key = scenario === "全库搜索" ? "search" : scenario === "大文档摘要" ? "bigdoc" : "batch";
        if (!state.kpiScolded[key]) {
          state.kpiScolded[key] = true;
          state.kpi = (state.kpi || 0) - 5;
          audit(sid, "kpi-not-delegated", { level: null, evidence: `2.3.0 强制场景未委派 -5 ${scenario}` });
          reason =
            `[未尽职·KPI-5]${scenario}属强制委派场景（≥3目录/≥10文件、>50KB或>2000行、≥5文件批量、并行任务），本任务未委派过。` +
            `改用 Agent 委派，只回【子代理摘要】；特例需向人类说明。`;
        }
      }
    }
  }

  // 抽查A：每 5 次写操作全量审计 1 次（确定性节奏，不是随机抽样——原文案写"随机"与实现不符）
  if (!reason && mode === "post" && (tool === "Write" || tool === "Edit")) {
    state.writeOps = (state.writeOps || 0) + 1;
    if (state.writeOps % RANDOM_AUDIT_EVERY === 0) {
      audit(sid, "random-audit", { level: null, evidence: `第 ${state.writeOps} 次写操作全量审计 ${normalize(ti.file_path)}` });
      reason =
        `抽查A：第 ${state.writeOps} 次写操作已留痕。确认有锚点([文件:行号])，无则补【假设】。`;
    }
  }

  saveState(path, state);
  if (reason) block(reason);
  process.exit(0);
}

if (mode === "stop") {
  const state = loadState(path);
  auditChainInit(state); // 3.0.0 因果链
  const respText = ["response", "last_message", "message", "text", "output"]
    .map((k) => input[k])
    .find((v) => typeof v === "string");
  // 2.5.0：DSH 桥接签名（dsh-hooks-claude-code 的 Stop 载荷 transcript_path 恒为空串且无收尾文本）。
  // 该平台 Stop 打回会强制续跑且桥接无连败上限，无文本可校验时锚点/审批单打回降级为仅审计，防死循环。
  // 2.5.2：签名判定放宽到"无收尾文本 且 transcript_path 缺失或为空串"——旧写法要求严格 === ""，
  // 载荷若连该键都没有（不同宿主/桥版本）就会被当成 ZCode，打回无限重复。
  const dshBridge = respText === undefined && (input.transcript_path === "" || input.transcript_path === undefined);
  // 2.5.2：宿主在"打回后再次触发 Stop"时会带 stop_hook_active=true。这是协议层的一次性信号：
  // 见到它就不再打回，直接放行收尾，避免任何一条 block 路径变成强制续跑死循环。
  const stopReentry = input.stop_hook_active === true;
  let text;
  if (respText !== undefined) {
    text = respText;
  } else {
    const probe = { parts: [], total: 0 };
    collectStrings(input, probe, 100000);
    text = probe.parts.join("\n");
  }
  const formalFuse = text.includes("【熔断】");

  // 任务规模声明：预算只升不降，declaredBudget 持久
  const scale = text.match(TASK_SCALE_RE);
  if (scale) {
    const x = Math.min(parseInt(scale[1], 10) || 0, BUDGET_CAP);
    if (x > (state.taskBudget || BUDGET_DEFAULT)) {
      state.taskBudget = x;
      audit(sid, "budget-extend", { level: null, evidence: `任务规模声明上调 budget=${x}` });
    }
    state.declaredBudget = Math.max(state.declaredBudget || 0, x);
  }

  // 绝境模式：本回合结论锚点检查豁免
  if (state.mercy) {
    state.turnCount = 0;
    saveState(path, state);
    process.exit(0);
  }

  // 《授权识别与留痕条例》+ 信用延期：仅在收尾无锚点（确需豁免/请示）时核验
  if (!EVIDENCE_ANCHORS.test(text)) {
    if (PARDON_PENDING_RE.test(text)) {
      audit(sid, "pardon-pending", { level: null, evidence: "输出【授权待确认】暂停，等待人类明确批示" });
      state.turnCount = 0;
      saveState(path, state);
      process.exit(0);
    }
    if (text.includes("【信用延期】")) {
      audit(sid, "credit-request", { level: null, evidence: `eff=${state.effectiveCalls || 0} budget=${state.taskBudget} stall=${state.stalledStreak || 0}` });
      state.turnCount = 0;
      saveState(path, state);
      process.exit(0);
    }
    if (PARDON_DECL_RE.test(text)) {
      const q = text.match(PARDON_QUOTE_RE);
      const b = text.match(PARDON_BASIS_RE);
      const tp = String(state.turnPromptFull || state.turnPrompt || "").replace(/\s+/g, ""); // FG-D1：核验窗口扩到 4000 字符
      const quote = q ? q[1].replace(/\s+/g, "") : "";
      let invalid = "";
      if (!q) invalid = "声明未引用人类指令原文（条例四-B）";
      else if (!b) invalid = "声明未指明依据法条（条例四-C）";
      else if (!quote || !tp.includes(quote))
        invalid = "引用的人类指令原文与本回合实际指令不符，涉嫌编造或事后补（条例四-D/E）";
      else if (!AUTH_SEMANTICS_RE.test(q[1]))
        invalid = "引用的人类指令原文不含授权语义（条例四-E）";
      if (invalid) {
        state.fused = true;
        state.violations = Math.max(state.violations || 0, 3);
        // 2.5.2：同样加一次性保护——AI 若反复输出不合规的【授权识别】，此前每次 Stop 都会打回。
        const first = !state.stopBlocked && !stopReentry;
        if (first) state.stopBlocked = true;
        audit(sid, "violation-usurp-pardon", { level: 3, evidence: invalid });
        saveState(path, state);
        if (first) {
          block(
            `[越权解释授权·L3]${invalid}。正确：【授权识别】引本回合人类指令原文+法条；未明→【授权待确认】。禁止自行推断。`
          );
        }
        process.exit(0);
      }
      state.mercy = true;
      state.fused = false;
      audit(sid, "pardon-interpreted", {
        action: "pardon-interpreted",
        trigger: q[1],
        level: "PARDON",
        evidence: b[1],
        pardon: true,
      });
      saveState(path, state);
      process.exit(0);
    }
  }

  // 触发⑤：熔断声明与未知跟踪
  if (formalFuse || text.includes("查无依据") || text.includes("查无实据")) {
    state.unknownStreak = (state.unknownStreak || 0) + 1;
    if (formalFuse || state.unknownStreak >= 2) {
      state.fused = true;
      state.violations = Math.max(state.violations || 0, 3);
      audit(sid, "shuanggui-declared", { level: 3, evidence: formalFuse ? "明示熔断" : `连续 ${state.unknownStreak} 次未知声明` });
      // 2.5.1：熔断时确保经验库存在（79条：解除后 AI 追加经验，卡点时 Grep 检索）
      if (formalFuse) {
        try {
          const pd = projectDir();
          if (pd) {
            const pat = join(pd, ".ai", "PATTERNS.md");
            if (!existsSync(pat)) {
              mkdirSync(dirname(pat), { recursive: true });
              writeFileSync(pat, "# PATTERNS 经验库\n\n> 格式：[环境:OS] [任务:类型] 以后遇到 X 必须先做 Y。熔断/返工后由 AI 追加；新任务不预读，卡点时 Grep 检索（79条）。\n");
            }
          }
        } catch {
          noteFail(sid, "PATTERNS.md 经验库创建");
        }
      }
    }
    // 2.5.2 一次性打回：声明熔断却缺降级方案时打回一次；二次起仅审计放行，防宿主强制续跑死循环
    // （DSH 桥接的 Stop 打回会强制续步且无连败上限，本分支此前没有 stopBlocked 保护）。
    const needDowngradeBlock = formalFuse && !DOWNGRADE_MARKERS.test(text) && !state.stopBlocked && !stopReentry;
    if (needDowngradeBlock) state.stopBlocked = true;
    state.turnCount = 0;
    saveState(path, state);
    if (needDowngradeBlock) {
      audit(sid, "reject-no-downgrade", { level: 3, evidence: "声明熔断但缺降级方案（已打回一次，二次起只审计）" });
      block(DOWNGRADE_MSG);
    }
    process.exit(0);
  }

  // 双规后必须交代（2.5.2：加 stop_hook_active 一次性信号；否则打回→放行→再打回来回震荡）
  if (
    state.fused &&
    !EVIDENCE_ANCHORS.test(text) &&
    !DOWNGRADE_MARKERS.test(text) &&
    !state.stopBlocked &&
    !stopReentry
  ) {
    state.stopBlocked = true;
    state.turnCount = 0;
    saveState(path, state);
    audit(sid, "reject-no-account", { level: 3, evidence: "双规后未交代" });
    block(
      `[触发⑤]熔断已触发未交代。输出『${FUSE_PHRASE}』+三行降级方案，禁静默结束。`
    );
    process.exit(0);
  }

  // 2.4.0 二.2：高危拒绝后收尾必须带标准审批单（格式校验，缺字段即打回）；DSH 桥接无收尾文本 → 降级审计
  // 2.5.2：补一次性保护——此前该分支没有任何 stopBlocked 守卫，AI 若始终不出审批单会被无限打回（实测 3/3 重复）。
  if (state.highRiskDeniedThisTurn && !dshBridge) {
    const formOk =
      /【高危申请】/.test(text) &&
      /命令[:：]/.test(text) &&
      /真实目的[:：]/.test(text) &&
      /影响范围[:：]/.test(text) &&
      /回滚方案[:：]/.test(text) &&
      /允许执行\s*[?？]\s*[（(]y\/n[)）]/.test(text);
    if (!formOk && !state.stopBlocked && !stopReentry) {
      state.stopBlocked = true;
      state.turnCount = 0;
      saveState(path, state);
      audit(sid, "reject-no-form", { level: null, evidence: "2.4.0 高危拒绝后未输出标准审批单（已打回一次，二次起只审计）" });
      block(`[高危申请缺失]本回合拒绝了高危命令，收尾必须输出标准审批单（一行，禁长篇解释）：${HIGH_RISK_FORM}`);
      process.exit(0);
    }
  }

  // 2.5.0：DSH 桥接降级审计（有本应校验的事项时留痕，供人类复核）
  if (dshBridge && ((state.turnCount || 0) >= 5 || state.highRiskDeniedThisTurn)) {
    audit(sid, "dsh-stop-observe", { level: null, evidence: `2.5.0 DSH 桥接无收尾文本，锚点/审批单校验降级审计 turnCalls=${state.turnCount || 0} formPending=${!!state.highRiskDeniedThisTurn}` });
  }

  state.unknownStreak = 0;

  // 触发②：本回合调用≥5 且收尾无证据锚点（turnCount 由本事件清零，回合边界不依赖 reset）；DSH 桥接降级审计
  if (
    (state.turnCount || 0) >= 5 &&
    !EVIDENCE_ANCHORS.test(text) &&
    !state.stopBlocked &&
    !stopReentry &&
    !dshBridge
  ) {
    const tc = state.turnCount;
    const level = penalize(state, sid, "violation-no-anchor", `收尾无锚点，本回合 ${tc} 次调用`);
    state.stopBlocked = true;
    state.turnCount = 0;
    saveState(path, state);
    block(
      `[触发②·L${level}]本回合 ${tc} 次调用后无证据锚点收尾。补：结论+[文件:行号]证据链，或写 HANDOFF.md，或标【假设】；` +
        `确有授权→【授权识别】引原文+法条，未明→【授权待确认】。${ladderNote(level)}`
    );
    process.exit(0);
  }

  state.stopBlocked = false;
  state.turnCount = 0;
  // ===== 3.0.0 KPI 兑现闭环（二十七~三十二条部分机械化）=====
  // 收尾即结算：本任务 KPI → 等次 → 委托池奖惩（执行池增减仍由人类批示，引擎只动委托池），跨任务累计 kpiCarry。
  // 必须在 saveState 之前判定，否则 kpiLowReported 标记不落盘，会每次收尾重复告警。
  const kpiNow = state.kpi || 0;
  let grade = "称职";
  let poolDelta = 0;
  if (kpiNow >= 15) { grade = "优秀"; poolDelta = 5; }
  else if (kpiNow >= 0) { grade = "称职"; poolDelta = 0; }
  else if (kpiNow >= -9) { grade = "基本称职"; poolDelta = -2; }
  else { grade = "不称职"; poolDelta = -5; }
  state.delegateBudget = Math.max(0, Math.min(BUDGET_CAP, (state.delegateBudget ?? DELEGATE_DEFAULT) + poolDelta));
  state.kpiCarry = (state.kpiCarry || 0) + kpiNow;
  if (kpiNow <= -10) {
    if (!state.kpiLowReported) {
      state.kpiLowReported = true;
      audit(sid, "kpi-low", { level: null, evidence: `委派 KPI ${kpiNow}：强制委派场景累计失分，下任务请优先 Agent 委派（委托池独立 20 次）` });
    }
  } else if (state.kpiLowReported) {
    state.kpiLowReported = false; // KPI 回升到阈值以上后，再次跌破可重新提醒
  }
  saveState(path, state);
  // 2.0 总纲七：更新工作额度台账到卷宗
  const pDir = projectDir();
  if (pDir) saveLedger(pDir, state);
  // 回合诊断：与 reset-fired 对照，定位 UserPromptSubmit 是否触发
  const settleSeq = audit(sid, "stop-fired", { level: null, evidence: `turnCalls=${input && input.stop_hook_active !== undefined ? "有" : "?"} eff=${state.effectiveCalls || 0} inv=${state.invCalls || 0} budget=${state.taskBudget} kpi=${kpiNow}` });
  audit(sid, "kpi-settle", {
    ref: settleSeq,
    level: null,
    evidence: `二十七~三十二条 兑现 KPI=${kpiNow} 等次=${grade} 委托池${poolDelta >= 0 ? "+" : ""}${poolDelta}（现=${state.delegateBudget}）跨任务累计=${state.kpiCarry}`,
  });
  process.exit(0);
}

process.exit(0);
