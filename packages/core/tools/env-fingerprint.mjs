// FocusGuard 环境档案生成器（v2，2026-11-09）
//
// 探测平台、可用执行体、工具可用性，产出 <项目根>/.ai/env-fingerprint.json。
// 该文件同时是两件事的来源：
//   ① 「命令硬校验」的规则表（map）：key = 本机不鼓励直接用的命令，value = 替代命令；
//   ② 环境档案（machine / shells / probe）：给模型看「这台机器有什么、哪个是自带的」。
// 指纹缺失时硬校验 fail-open（跳过 + warn），不会阻断任何命令。
//
// 用法：node packages/core/tools/env-fingerprint.mjs [--out <路径>] [--shell <id>]
//   --shell  本会话实际执行体（由适配层传入）。不传则记探测到的首选，并标 source=probe。
//
// TTL 不固定：连续探测结果不变则间隔翻倍（6h → 12h → 24h … 上限 30 天），一变立刻回到 6h。
// 判据：环境是低频变化的东西，天天重探是浪费；但一旦变了（装了新终端），必须马上看见。

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { buildEnvMap, droppedAlternatives } from "./lib/envMap.mjs";
import { osLabel, probeShellDetails } from "../src/core/env.mjs";

// PATH 补全：宿主进程的 PATH 可能是启动时的旧快照，补上常见安装位置后再探测（只影响本脚本）。
// 注意：这不是"假设装在 C 盘"——只是把 scoop/winget 的 shim 目录补进 PATH，探不到就当没有。
const EXTRA_PATH_DIRS = [
  join(process.env.USERPROFILE || "", "scoop", "shims"),
  join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links"),
];
process.env.PATH = [process.env.PATH || "", ...EXTRA_PATH_DIRS.filter((d) => d && existsSync(d))].join(delimiter);

// map 表：规则来源（与 pipeline.mjs 的硬校验一一对应）
const MAP = { grep: "rg", find: "fd", ls: "eza", cat: "bat", sed: "sd" };
// 探测范围：map 的 key 与 value，外加常用运行时与增强工具
const PROBE = ["rg", "fd", "eza", "bat", "sd", "grep", "sed", "less", "jq", "yq", "fzf", "zoxide", "node", "python", "git"];

/** TTL 自适应：首次 6 小时，连续未变逐次翻倍，上限 30 天。 */
const TTL_FIRST = 6 * 3600e3;
const TTL_CEIL = 30 * 86400e3;

function probe(tool) {
  for (const args of [["--version"], ["-v"], ["--help"]]) {
    try {
      execFileSync(tool, args, { stdio: "ignore", timeout: 4000 });
      return true;
    } catch {
      /* 继续试下一个探测参数 */
    }
  }
  return false;
}

function detectEncoding() {
  if (process.platform !== "win32") return "UTF-8";
  try {
    const cp = execFileSync("cmd", ["/c", "chcp"], { encoding: "utf8", timeout: 4000 }).match(/(\d+)\s*$/);
    return cp ? (cp[1] === "65001" ? "UTF-8" : cp[1] === "936" ? "GBK" : "CP" + cp[1]) : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 命令工具的**语法实现**探测（2026-11-09）。
 *
 * 为什么需要：同一条命令在不同实现上行为不同，而且差别是**静默**的——
 *   · BSD sed 的 `-i` 必须带后缀（`sed -i '' …`），GNU sed 带了反而把后缀当文件名；
 *   · BSD grep 没有 `-P`（Perl 正则）；
 *   · GNU find 有 `-printf`，BSD find 没有。
 * 原来这套判断靠 `os === 'darwin'` 硬推——macOS 上 `brew install gnu-sed` 之后就全错了。
 * 现在改成探**实际实现**：跑一次 `--version` 看它自报什么（BSD 工具不认这个参数，
 * 会往 stderr 吐 "illegal option"，那就判 bsd）。
 *
 * 只在生成器里跑（后台 spawn），会话启动只读档案——探测本身要花几百毫秒。
 */
function probeCommand(name) {
  const run = (args) => {
    try {
      return String(execFileSync(name, args, { encoding: "utf8", timeout: 2500, stdio: ["ignore", "pipe", "pipe"] }) || "");
    } catch (e) {
      // BSD 工具把 --version 当非法参数，信息在 stderr；有输出就用它判型。
      return String((e && (e.stdout || e.stderr)) || "");
    }
  };
  const v = run(["--version"]);
  if (!v.trim()) return null;
  let impl = "unknown";
  if (/GNU/i.test(v)) impl = "gnu";
  else if (/BSD/i.test(v)) impl = "bsd";
  else if (/busybox/i.test(v)) impl = "busybox";
  else if (/illegal option|invalid option/i.test(v)) impl = "bsd";
  else if (/ripgrep/i.test(v)) impl = "ripgrep";
  const ver = (v.match(/\b(\d+\.\d+(?:\.\d+)?)\b/) || [])[1] || "";
  return { impl, version: ver };
}

/** 只探这几个有"同工具不同语法"问题的；其余工具没有跨实现的行为差异。 */
const SYNTAX_PROBES = ["grep", "sed", "find", "awk", "xargs", "tar"];

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const out = argOf("--out") || join(process.cwd(), ".ai", "env-fingerprint.json");

/** 读旧档案：机器编号、首次见到的时刻、已有反馈都要继承，不能每次重探就重发一个新编号。 */
let prev = null;
try {
  prev = JSON.parse(readFileSync(out, "utf8"));
} catch {
  /* 首次生成，或文件损坏 —— 按新建处理 */
}

const now = Date.now();
const shells = probeShellDetails();
// 命令语法实现（GNU / BSD / busybox + 版本）。只探有跨实现差异的那几个。
const commands = {};
for (const name of SYNTAX_PROBES) {
  const p = probeCommand(name);
  if (p) commands[name] = p;
}
const available = [];
const unavailable = [];
for (const t of PROBE) (probe(t) ? available : unavailable).push(t);

// 机器编号：首次分配 A；已有则沿用；FG_MACHINE_ID 可覆盖（多台机器时手动指定 B/C…）。
const machine = {
  id: String(process.env.FG_MACHINE_ID || prev?.machine?.id || "A").trim() || "A",
  host: hostname(),
  arch: process.arch,
  firstSeen: prev?.machine?.firstSeen || new Date(now).toISOString(),
};

// 「变了没有」只看平台与执行体集合——工具装了新版本不该把 TTL 重置。
const shellKey = shells.map((s) => s.id).join(",");
const changed = Boolean(prev) && (prev?.platform?.os !== process.platform || prev?.shells?.map?.((s) => s.id).join(",") !== shellKey);
const streak = changed ? 0 : Math.min((prev?.probe?.streak || 0) + 1, 12);
const ttlMs = Math.min(TTL_FIRST * 2 ** streak, TTL_CEIL);

const sessionShell = String(argOf("--shell") || "").trim();
const fingerprint = {
  schema: 2,
  machine,
  platform: {
    os: process.platform,
    // win32 是 Node 的 API 名，不是"32 位系统"——对外一律给 Windows/x64。
    osLabel: osLabel(process.platform, process.arch),
    shell: sessionShell || shells[0]?.id || "unknown",
    shellSource: sessionShell ? "session" : "probe",
    encoding: detectEncoding(),
  },
  shells,
  // 同一条命令在不同实现上的语法差异（BSD sed 的 -i 要后缀、BSD grep 无 -P、GNU find 有 -printf）。
  // 报告给模型，让它写命令前就知道该用哪套写法——这比事后拦一条更省事。
  commands,
  tools: { available, unavailable },
  map: buildEnvMap(MAP, available),
  probe: {
    at: new Date(now).toISOString(),
    ttlMs,
    streak,
    changed,
    nextAt: new Date(now + ttlMs).toISOString(),
  },
  // 模型/人类回填的补充说明（fg_env 工具写入）。探测只看得到 PATH，看不到"这个 pwsh 是谁装的"。
  notes: Array.isArray(prev?.notes) ? prev.notes : [],
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fingerprint, null, 2) + "\n", "utf8");

const missingAlt = droppedAlternatives(MAP, available);
const shellText = shells.map((s) => `${s.id}(${s.origin === "builtin" ? "自带" : "额外"})`).join(" ");
console.log(`env-fingerprint：${out}`);
console.log(`  机器 ${machine.id} · ${machine.host} · ${fingerprint.platform.osLabel}`);
console.log(`  执行体 ${fingerprint.platform.shell}（来源 ${fingerprint.platform.shellSource}）/ 可用 ${shellText}`);
console.log(`  编码 ${fingerprint.platform.encoding} / 下次重探 ${fingerprint.probe.nextAt}（${Math.round(ttlMs / 3600e3)}h，连续未变 ${streak} 次）`);
console.log(`  命令语法 ${Object.entries(commands).map(([k, v]) => `${k}=${v.impl}${v.version ? " " + v.version : ""}`).join(" ") || "-"}`);
console.log(`  可用工具 ${available.join(" ") || "-"}`);
console.log(`  不可用 ${unavailable.join(" ") || "-"}`);
console.log(`  map ${Object.entries(MAP).map(([k, v]) => `${k}→${v}`).join(" ")}`);
if (missingAlt.length) console.log(`  [已剔除] 替代工具未安装：${missingAlt.join(" ")}——这些 key 不进 map，硬校验不会拒它们（否则会建议一个不存在的命令）`);
