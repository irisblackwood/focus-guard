// FocusGuard 环境指纹生成器（一次性；仅在人类明确要求刷新时重跑）
//
// 探测平台、shell、工具可用性，产出 <项目根>/.ai/env-fingerprint.json。
// 该文件是「命令硬校验」的规则来源（map 表）：key = 本机不鼓励直接用的命令，value = 替代命令。
// 指纹缺失时硬校验 fail-open（跳过 + warn），不会阻断任何命令。
//
// 用法：node packages/core/tools/env-fingerprint.mjs [--out <路径>]

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { execFileSync } from "node:child_process";

// PATH 补全：宿主进程的 PATH 可能是启动时的旧快照，补上常见安装位置后再探测（只影响本脚本）。
const EXTRA_PATH_DIRS = [
  join(process.env.USERPROFILE || "", "scoop", "shims"),
  join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links"),
];
process.env.PATH = [process.env.PATH || "", ...EXTRA_PATH_DIRS.filter((d) => d && existsSync(d))].join(delimiter);

// map 表：规则来源（与 pipeline.mjs 的硬校验一一对应）
const MAP = { grep: "rg", find: "fd", ls: "eza", cat: "bat", sed: "sd" };
// 探测范围：map 的 key 与 value，外加常用运行时与增强工具
const PROBE = ["rg", "fd", "eza", "bat", "sd", "grep", "sed", "less", "jq", "yq", "fzf", "zoxide", "node", "python", "git"];

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

function shellVersion(exe) {
  try {
    return execFileSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 6000 }).trim();
  } catch {
    return "";
  }
}

function detectShell() {
  if (process.platform !== "win32") return String(process.env.SHELL || "sh").split(/[\\/]/).pop() || "sh";
  // Windows：ComSpec 恒指向 cmd.exe，会误判；以实际可用的现代 shell 为准，并带版本号。
  const pwsh = shellVersion("pwsh");
  if (pwsh) return `pwsh ${pwsh}`;
  const ps = shellVersion("powershell");
  if (ps) return `powershell ${ps}`;
  const cs = String(process.env.ComSpec || "");
  return cs.toLowerCase().includes("cmd") ? "cmd" : "unknown";
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

const available = [];
const unavailable = [];
for (const t of PROBE) (probe(t) ? available : unavailable).push(t);

const fingerprint = {
  generated_at: new Date().toISOString(),
  platform: { os: process.platform, shell: detectShell(), encoding: detectEncoding() },
  tools: { available, unavailable },
  map: { ...MAP },
};

const outIdx = process.argv.indexOf("--out");
const out = outIdx >= 0 ? process.argv[outIdx + 1] : join(process.cwd(), ".ai", "env-fingerprint.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fingerprint, null, 2) + "\n", "utf8");

const missingAlt = Object.entries(MAP).filter(([, v]) => !available.includes(v)).map(([k, v]) => `${k}→${v}`);
console.log(`env-fingerprint：${out}`);
console.log(`  平台 ${fingerprint.platform.os} / shell ${fingerprint.platform.shell} / 编码 ${fingerprint.platform.encoding}`);
console.log(`  可用 ${available.join(" ") || "-"}`);
console.log(`  不可用 ${unavailable.join(" ") || "-"}`);
console.log(`  map ${Object.entries(MAP).map(([k, v]) => `${k}→${v}`).join(" ")}`);
if (missingAlt.length) console.log(`  [警示] 替代工具未安装：${missingAlt.join(" ")}——硬校验生效后这些 key 会被拒且无本机替代`);
