// FocusGuard 母版层 · 平台环境（v3.0.5；《资料与代码分层总规范》二·1）
// shell/编码/大小写检测与平台命令规则；项目根由适配层以参数传入（母版不认 harness）。
import {
  readFileSync, writeFileSync, rmSync, statSync, appendFileSync,
  mkdirSync, existsSync, renameSync, realpathSync, readdirSync, copyFileSync,
} from "node:fs";
import { join, dirname, sep, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export function quickShellId() {
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

export function detectEnv(projDir) {
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
    const probeDir = projDir || process.cwd();
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

export function platformBashViolation(env, cmd) {
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

