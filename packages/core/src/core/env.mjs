// FocusGuard 母版层 · 平台环境（v3.0.5；《资料与代码分层总规范》二·1）
// shell/编码/大小写检测与平台命令规则；项目根由适配层以参数传入（母版不认 harness）。
// 2026-10-27：删掉从 guard.mjs 拆分时复制过来的未使用 import（14 个符号）。ESLint no-unused-vars 全量扫描发现。
import { statSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { execFileSync } from "node:child_process";

export function quickShellId() {
  // 2026-10-18 修（REPORT-2026-10-12 P2「三处 shell 判定互相矛盾」）：
  // 原实现只看**宿主 Node 进程自身**的 SHELL/ComSpec，于是 DSH 下报成 cmd，
  // 而 DSH 的 shell 工具实际执行体是 pwsh（cordis.patch.yml 的 pwshPath）——
  // 卷宗【一】、env-fingerprint、实际执行三方长期不一致，替代规则与实际 shell 脱节。
  // 修法：① 显式 FG_SHELL 最高优先（可测、可覆盖）；② 适配层通过 opts.shell 传入真实执行体
  //       （见下方 detectEnv，母版不猜 harness）。
  // 2026-10-22 更正：本行注释原写「DSH 宿主直接判 powershell」，但实现里从未有过这个判断——
  // 那是被废弃的旧方案，代码一直走的是参数传递。注释落后于实现，已按实际改写。
  const forced = String(process.env.FG_SHELL || "").trim().toLowerCase();
  if (forced) return forced;
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

/**
 * @param {string} [projDir]
 * @param {{ shell?: string, probeVersion?: boolean }} [opts] 显式执行体（适配层传入，母版不猜 harness）。
 *   2026-10-18：DSH 适配层此前靠写 process.env.FG_SHELL 传递，结果宿主设的变量
 *   被子进程（含 npm test）继承，直接污染了 4 条环境检测用例。改为参数传递。
 *   2026-10-29：`probeVersion` 新增且**默认关闭**——见下方版本探测处的注释。
 */
export function detectEnv(projDir, opts = {}) {
  const osName = process.platform;
  const forced = String((opts && opts.shell) || "").trim().toLowerCase();
  const shellIdKey = forced || quickShellId();
  // 2026-10-29：版本探测改为显式索取（opts.probeVersion），默认不跑。
  // 它是无条件 spawn 一个 powershell / pwsh 子进程，实测 **202.6ms/次**，
  // 占 detectEnv 总耗时（228.2ms）的 89%——而它唯一的产出是 env.shell 里的版本串，
  // 全仓 **0 处消费**：卷宗【一】环境声明行写的是 `shellIdKey`，preGuard 的平台规则
  // 用的是 `os + shellIdKey`。会话启动（冷启敏感）不该为一行没人读的版本号付两百毫秒。
  // 需要版本的调用方显式传 { probeVersion: true }。
  let shellVersion = "";
  if (opts && opts.probeVersion) {
    try {
      if (shellIdKey === "powershell")
        shellVersion = execFileSync("powershell", ["-NoProfile", "-c", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 6000 }).trim();
      else if (shellIdKey === "zsh")
        shellVersion = (execFileSync("zsh", ["--version"], { encoding: "utf8", timeout: 6000 }).match(/(\S+)\s*$/) || [])[1] || "";
      else if (shellIdKey === "bash")
        shellVersion = (execFileSync("bash", ["--version"], { encoding: "utf8", timeout: 6000 }).match(/version\s+(\S+)/) || [])[1] || "";
    } catch {}
  }
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

