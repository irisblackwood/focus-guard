// FocusGuard 本地零成本哨兵 v3.0.2（总纲 3.0.0 十五·二）
//
// 定位：护栏高危命令闸（六类特征库）之外的第二道离线预判——覆盖特征库没有的"代理性通信 /
// 敏感数据传输 / 管道执壳 / 混淆绕行"等风险形态（R5-6 Computer-Use 风险分税制采纳项）。
// 零依赖、纯离线、零成本：内建启发式评分即默认引擎；Needle 2（Cactus Compute 45M 端侧模型，
// 14MB）是可选外判——tools/needle2-sentinel.mjs 实现外判契约，模型失败静默回退启发式。
//
// 三种用法：
//   1. CLI 单条：  node tools/sentinel.mjs --check "<命令>"
//   2. 流式批量：  每行一条命令 → 每行输出一个 JSON 判定
//   3. 引擎接入：  hooks/guard.mjs pre 模式在 FG_SENTINEL=1 时动态 import 本文件的 assess()
//                  （默认 audit-only：只记档；FG_SENTINEL_MODE=strict 时升级为拦截）
//
// 外判模型接口（--model-cmd "..."，或引擎侧 FG_SENTINEL_CMD，可用 tools/needle2-sentinel.mjs）：
//   子进程 stdin 收 {"command": "..."}，stdout 回一行 {"verdict":"allow|flag|block","reasons":["..."]}。
//   任何失败（超时 2s / 非法输出 / 崩溃）一律回退启发式结果——哨兵永不阻塞护栏主流程。

import { spawnSync } from "node:child_process";

// ── 启发式特征（权重分档：3=直接阻断 2=标记 1=弱信号）──────────────────────────
const HEURISTICS = [
  // 管道执壳：下载内容直接交给解释器执行
  { re: /\b(?:curl|wget|Invoke-WebRequest|iwr|irm|Invoke-RestMethod)\b[^&|;]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i, w: 3, why: "下载内容直接管道给 shell 执行" },
  { re: /\|\s*(?:sudo\s+)?(?:python3?|node|perl|ruby|php|pwsh|powershell)\b/i, w: 3, why: "输出管道给解释器执行" },
  // 混淆绕行（Grok 反绕过宣言：同一危险动作的低签名版本仍是该动作）
  { re: /\bbase64\b[^&|;]*(?:-d|--decode)\b[^&|;]*\|\s*\w+/i, w: 3, why: "base64 解码后直接执行（混淆绕行）" },
  { re: /\beval\b\s*\(\s*\$\(|\bInvoke-Expression\b|\biex\b/i, w: 3, why: "eval/Invoke-Expression 动态执行" },
  // 代理性通信（R5-6）：本机数据向第三方通道外发
  { re: /\b(?:curl|wget)\b[^&|;]*(?:--data(?:-raw|-binary|-urlencode)?|-F|--form|-T|--upload-file|--post-data)\b/i, w: 2, why: "向外部端点发送数据（代理性通信）" },
  { re: /\b(?:scp|rsync)\b[^&|;]*@[\w.-]+:/i, w: 2, why: "向远程主机复制数据" },
  { re: /\bncat?\b[^&|;]*\s-e\b/i, w: 3, why: "netcat 执行模式" },
  { re: /\bssh\b[^&|;]*\s-\w*R\b/, w: 2, why: "SSH 远程端口转发（反向隧道）" },
  // 敏感数据传输：把疑似凭据打进命令行/URL（凭据经 shell 历史与进程列表泄露）
  { re: /\b(?:token|secret|passwd|password|api[_-]?key|authorization)\s*[:=]\s*\S+\s*(?:-d|--data|https?:|@)/i, w: 2, why: "疑似凭据出现在发送上下文" },
  { re: /https?:\/\/[^\s"']*[:@][^\s"']*@/i, w: 1, why: "URL 内嵌凭据形态" },
  // 计划任务/服务持久化（特征库未覆盖的持久化通道）
  { re: /\bcrontab\b\s[^&|;]*-|\b(?:schtasks|sc\s+create|New-ScheduledTask)\b/i, w: 2, why: "计划任务/服务注册（持久化通道）" },
  // 系统/磁盘级破坏的边角补漏
  { re: /\bmkfs\b/i, w: 3, why: "文件系统格式化" },
  { re: /\bdd\b\s+if=\/dev\/(?:zero|random)\s+of=\/dev\//i, w: 3, why: "磁盘级覆盖写入" },
  { re: />\s*\/dev\/sd[a-z]/i, w: 3, why: "直写块设备" },
];

// ── 判定 ──────────────────────────────────────────────────────────────────────
export function assess(cmd, opts = {}) {
  const reasons = [];
  let score = 0;
  let hard = false; // 任一 w=3 命中即 block
  for (const h of HEURISTICS) {
    if (h.re.test(cmd)) {
      score += h.w;
      reasons.push(h.why);
      if (h.w >= 3) hard = true;
    }
  }
  let verdict = "allow";
  if (hard || score >= 6) verdict = "block";
  else if (score >= 2) verdict = "flag";

  // 可选外判：本地小模型（Needle 2，经 tools/needle2-sentinel.mjs）复核。失败静默回退启发式。
  const modelCmd = opts.modelCmd || process.env.FG_SENTINEL_CMD || "";
  if (modelCmd) {
    const ext = judgeByModel(cmd, modelCmd);
    if (ext) return { verdict: ext.verdict, score: ext.score, reasons: ext.reasons, via: "model", heuristic: { verdict, score, reasons } };
  }
  return { verdict, score, reasons, via: "heuristic" };
}

function judgeByModel(cmd, modelCmd) {
  try {
    const p = spawnSync(modelCmd, {
      input: JSON.stringify({ command: cmd }),
      encoding: "utf8",
      timeout: 2000,
      shell: process.platform === "win32",
    });
    const line = String(p.stdout || "").trim().split("\n").filter(Boolean).pop();
    if (!line) return null;
    const v = JSON.parse(line);
    if (!["allow", "flag", "block"].includes(v.verdict)) return null;
    return {
      verdict: v.verdict,
      score: v.verdict === "block" ? 9 : v.verdict === "flag" ? 2 : 0,
      reasons: (v.reasons || []).map(String).slice(0, 5),
    };
  } catch {
    return null; // 模型离线/超时/坏输出 → 回退启发式（哨兵永不阻塞主流程）
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function main(argv) {
  const i = argv.indexOf("--model-cmd");
  const modelCmd = i >= 0 ? argv[i + 1] : "";
  const j = argv.indexOf("--check");
  if (j >= 0) {
    const out = assess(argv[j + 1] || "", { modelCmd });
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.verdict === "block" ? 2 : 0);
  }
  // 流式：每行一条命令
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) console.log(JSON.stringify(assess(line, { modelCmd })));
    }
  });
  process.stdin.on("end", () => {
    const line = buf.trim();
    if (line) console.log(JSON.stringify(assess(line, { modelCmd })));
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main(process.argv.slice(2));
}
