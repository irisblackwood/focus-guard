// FocusGuard 环境指纹生成器（一次性；仅在人类明确要求刷新时重跑）
//
// 探测平台、shell、工具可用性，产出 <项目根>/.ai/env-fingerprint.json。
// 该文件是「命令硬校验」的规则来源（map 表）：key = 本机不鼓励直接用的命令，value = 替代命令。
// 指纹缺失时硬校验 fail-open（跳过 + warn），不会阻断任何命令。
//
// 用法：node packages/core/tools/env-fingerprint.mjs [--out <路径>]

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

// map 表：规则来源（与 pipeline.mjs 的硬校验一一对应）
const MAP = { grep: "rg", find: "fd", ls: "eza", cat: "bat", sed: "sd" };
// 探测范围：map 的 key 与 value，外加常用运行时
const PROBE = ["rg", "fd", "eza", "bat", "sd", "grep", "sed", "node", "python", "git"];

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

function detectShell() {
  if (process.platform !== "win32") return String(process.env.SHELL || "sh").split(/[\\/]/).pop() || "sh";
  const sh = String(process.env.SHELL || "");
  if (/bash/i.test(sh)) return "bash";
  if (/zsh/i.test(sh)) return "zsh";
  const cs = String(process.env.ComSpec || "");
  if (/powershell/i.test(cs)) return "powershell";
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
