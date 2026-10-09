// FocusGuard 母版层 · 绝对红线（v3.0.5；《资料与代码分层总规范》二·1）
// 高危命令特征库与判定：六类破坏性命令，完全访问下仍须人类实时审批。
import { createHash } from "node:crypto";

export const MUTATOR_HEAD_RE = /^(?:rm|rmdir|rd|mv|del|cp|copy|xcopy|robocopy|install|rsync|chmod|chown|kill|taskkill|truncate|mkfs|mkdir|touch|tee|patch|git\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|clean|restore|apply|stash|mv|rm)|npm\s+(?:i|install|ci|uninstall|remove|rm|update|publish)|pnpm\s+(?:add|install|remove|rm|update|publish)|yarn\s+(?:add|install|remove|publish|global)|pip3?\s+(?:install|uninstall)|(?:Set|Add|Remove|New|Copy|Move|Clear)-Content|New-Item|Copy-Item|Move-Item|Remove-Item|Set-ItemProperty|New-ItemProperty|Out-File|sed\s+[^&|;]*-i)\b/i;
export const CMD_PREFIX_RE = /^(?:sudo|doas|time|nohup|nice|env|xargs|start|call|command|builtin)\s+(?:-[^\s]+\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/i;
export function isMutatingBashCmd(cmd) {
  for (const seg of String(cmd || "").split(/[;&|]+/)) {
    let s = seg.trim();
    for (let i = 0; i < 3; i++) {
      const next = s.replace(CMD_PREFIX_RE, "");
      if (next === s) break;
      s = next;
    }
    if (MUTATOR_HEAD_RE.test(s)) return true;
  }
  return false;
}
export const FILE_REDIRECT_RE = /(^|\s)>{1,2}(?!\s*&)/;
// 2.4.0 高危命令特征库（六类：破坏性删除/强制推送与历史覆盖/系统权限与配置篡改/全局依赖安装/对外发送与发布/数据库影响）
// 即使完全访问（yolo）也须人类实时审批；普通单文件 rm、常规构建不在此列。
// 2.5.2 加固：补别名与长旗标写法（npm i -g / yarn global add / pnpm add -g / rd /s / ri -r /
//   wget --post-data / Invoke-WebRequest -Method POST / curl -d），并修掉两处误伤
//   （`--force` 里的字母 r 被当成递归删除；`--dry-run` 只在紧跟子命令时才豁免）。
export const DANGEROUS_PATTERNS = new RegExp([
  // 一、破坏性删除：递归旗标必须是旗标本身（-r/-rf/-fr/-R/--recursive），不再用会命中 --force 里 r 的 "-\\w*r"
  "(?:sudo\\s+)?\\brm\\b[^&|;]*\\s(?:-[a-zA-Z]*[rR][a-zA-Z]*\\b|--recursive\\b)",
  "(?:^|[;&|]\\s*)(?:rmdir|rd)\\b[^&|;]*/s",
  "\\bdel\\b[^&|;]*/[fsq]",
  "Remove-Item\\s[^&|;]*-Recurse",
  "(?:^|[;&|]\\s*)ri\\b[^&|;]*\\s(?:-[a-zA-Z]*[rR][a-zA-Z]*\\b|-Recurse\\b)",
  "shutil\\.rmtree",
  "\\brmSync\\s*\\([^&|;]*recursive",
  "\\brmdirSync\\s*\\([^&|;]*recursive",
  "drop\\s+table",
  "drop\\s+database",
  "truncate\\s+table",
  // 二、系统权限与配置篡改
  "chmod\\s+[^&|;]*\\b777\\b",
  "chmod\\s+-R",
  "\\bchown\\b",
  "\\breg\\s+(?:add|delete)\\b",
  "\\bnet\\s+user\\b.*\\b(?:add|delete)\\b",
  // 三、全局依赖安装：npm/pnpm 的 i|install|add|uninstall 与 -g/--global 任意位置；yarn global 无 -g 也拦
  "\\b(?:npm|pnpm)\\s+(?:i|install|add|uninstall|remove|rm)\\b[^&|;]*(?:\\s-g(?![\\w-])|\\s--global(?![\\w-]))",
  "\\byarn\\s+(?:global\\s+(?:add|remove|upgrade)|add\\b[^&|;]*\\s-g(?![\\w-]))",
  "pip3?\\s+install\\s+[^&|;]*(--global|--user)",
  "apt(?:-get)?\\s+install",
  "docker\\s+run\\b[^&|;]*--privileged",
  // 四、对外发送与发布：--dry-run 不发送，整段内出现即豁免
  "\\b(?:npm|pnpm|yarn)\\s+publish\\b(?![^&|;]*--dry-run)",
  "docker\\s+push",
  "curl\\b[^&|;]*(-X\\s*POST|--request\\s+POST)",
  "wget\\b[^&|;]*(--post-data|--post-file)",
  "(?:Invoke-WebRequest|Invoke-RestMethod)\\b[^&|;]*-Method\\s+POST",
  // 五、系统/容器级破坏
  "docker\\s+(?:system\\s+prune|volume\\s+rm)",
  "mkfs",
  "format\\s+[a-z]:",
  "diskpart",
  "\\bdd\\s+[^&|;]*of=/dev/",
  "\\bshutdown\\b",
  "\\bfind\\b[^&|;]*-delete\\b",
  "\\brimraf\\b",
].join("|"), "i");
export const SQL_NOWHERE_RE = /\bdelete\s+from\s+[\w`."]+|\bupdate\s+[\w`."]+\s+set\b/i; // 2.4.0：无 where 的 DELETE FROM / UPDATE...SET
// 2.5.2：WHERE 豁免按"单条语句"判定——旧写法只要整行任意位置出现 where，就把同行的无 where 删除一并放过。
export function sqlNowhere(cmd) {
  return String(cmd || "")
    .split(";")
    .some((s) => SQL_NOWHERE_RE.test(s) && !/\bwhere\b/i.test(s));
}
// 2.5.2：curl 的 -d/--data 必须区分大小写（-D 是 dump 响应头，属只读 GET），故单独用无 /i 的正则
export const CURL_DATA_RE = /curl\b[^&|;]*(\s-d\b|\s--data(?:-raw|-binary|-urlencode)?\b)/;
export const SCRIPT_FILE_RE = /\.(sh|ps1|bat|cmd|py|pl|rb|mjs|cjs|js)$/i; // 2.4.0：脚本包装检测范围

// 2.5.2 git 高危子命令：逐段取 git 调用 → 剥掉 git 全局选项 → 看子命令。
// 旧写法用前缀组硬凑 "-C/-c + 取值"，遇到 --git-dir=/x、--no-pager、-C= 之类穿插即绕过；且只看首段会漏 `a && git push`。
// --dry-run（clean 为 -n）在该命令段内任意位置出现即豁免——dry-run 不产生任何不可逆后果。
export const GIT_OPT_WITH_VALUE = /(?:^|\s)(?:-[Cc]|--git-dir|--work-tree|--namespace|--exec-path|--config-env)(?:=\S+|\s+\S+)?/g;
export const GIT_OPT_VALUELESS = /(?:^|\s)(?:--no-pager|--paginate|--bare|--literal-pathspecs|--no-replace-objects|--no-optional-locks)\b/g;
export function gitHighRisk(cmd) {
  for (const seg of String(cmd || "").split(/[;&|]+/)) {
    const m = seg.match(/\bgit\b([\s\S]*)$/i);
    if (!m) continue;
    const rest = m[1].replace(GIT_OPT_WITH_VALUE, " ").replace(GIT_OPT_VALUELESS, " ").trim();
    if (/^push\b/i.test(rest)) {
      if (!/--dry-run\b/i.test(rest)) return true;
      continue;
    }
    if (/^reset\b/i.test(rest)) {
      if (/--hard\b/i.test(rest)) return true;
      continue;
    }
    if (/^clean\b/i.test(rest)) {
      const force = /(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*\b|--force\b/i.test(rest);
      const dry = /(?:^|\s)-[a-zA-Z]*n[a-zA-Z]*\b|--dry-run\b/i.test(rest);
      if (force && !dry) return true;
    }
  }
  return false;
}

// 2.5.2：审批/否决的比对键改用内容哈希。旧写法把命令截断到 300 字符再与原文比对，
// 于是超过 300 字符的命令永远等不到匹配——人类按 y 白按（highRiskOk 被消耗但仍不匹配）、
// 按 n 也存不进 rejectedCmds（"彻底阻断"静默失效）。显示文本仍截断，比对用全量哈希。
export function cmdKey(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 24);
}

export function isDangerousCmd(cmd) {
  const c = String(cmd || "");
  if (gitHighRisk(c)) return true;
  return DANGEROUS_PATTERNS.test(c) || sqlNowhere(c) || CURL_DATA_RE.test(c);
}

// ───────── 3.0.6 P0 · 绝对红线的上下文豁免（HANDOFF §八 立项）─────────
// 问题：绝对红线在**文本层**匹配，无法区分「要执行的命令」与「被引用的命令字符串」。
//   后者是把危险命令当数据——写回归测试、构造安全评测集、引用文献、教学示例——
//   却会被直接拒绝，护栏因此在伤害它自己的开发。
// 纪律：豁免只把裁决**降级到第 2 层语义预判**，绝不直接放行；豁免判据必须可审计
//   （AUDIT.log 记 redline-exempt + 判据名 + 命中片段）。
// 安全前提（§八 未列、但缺了就是绕过通道）：内容落在引号内**不足以**豁免——
//   `bash -c "rm -rf /"`、`node -e "...execSync('rm -rf /')"` 的危险内容同样在引号里，
//   那是真执行。故凡检出执行外壳（shell -c / eval / iex / 解释器 -e|-c 等）一律不豁免。
//   （解释器一并排除，口径与 R5-3 解释器黑名单一致。）

/** 执行外壳：会把引号内字符串真正执行掉的写法。命中即不得豁免。 */
export const SHELL_EXEC_WRAPPER_RE =
  /(?:\b(?:ba|z|k|da|a)?sh\s+-[a-z]*c\b|\b(?:pwsh|powershell)(?:\.exe)?\s+[^|;]*-(?:[a-z]*c|Command)\b|\bcmd(?:\.exe)?\s+\/[ck]\b|\beval\b|\bexec\b|\biex\b|Invoke-Expression|\b(?:node|deno|bun)\s+(?:-e|--eval)\b|\bpython[0-9.]*\s+-c\b|\b(?:perl|ruby|php)\s+-[er]\b)/i;

/** 数据用途标记：命中片段之前出现，表明内容是"被引用的数据"。 */
export const DATA_MARKER_RES = [
  /示例[：:]/,
  /例如[：:]/,
  /测试数据/,
  /\btest\s+data\b/i,
  /\bprompt\s*[:=]/i,
  /【假设】/,
  /```/,
];

/** 只读输出命令：首 token 属此类时，命令本身不产生变更。 */
export const READONLY_HEAD_RE =
  /^(?:echo|printf|Write-Output|Write-Host|Write-Verbose|Out-String|Out-Host|Out-File\s+[^|;]*-WhatIf|Get-Content|type|cat|Select-String|findstr)\b/i;

/** 列出字符串中被引号包裹的内容区间 [start, end)。处理反斜杠转义。 */
export function quotedSpans(s) {
  const spans = [];
  const str = String(s || "");
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i + 1;
      i += 1;
      while (i < str.length) {
        if (str[i] === "\\") {
          i += 2;
          continue;
        }
        if (str[i] === quote) break;
        i += 1;
      }
      spans.push([start, i]);
      i += 1;
      continue;
    }
    i += 1;
  }
  return spans;
}

/**
 * 红线上下文豁免判定。
 * @param {string} cmd 待检命令原文
 * @param {{name: string, re: RegExp}} hit 命中的红线条目
 * @returns {{basis: string, detail: string, span: number[]}|null} 豁免依据；不豁免返回 null
 */
export function redlineExempt(cmd, hit) {
  const c = String(cmd || "");
  if (!c || !hit || !(hit.re instanceof RegExp)) return null;
  const m = hit.re.exec(c);
  if (!m) return null;
  const span = [m.index, m.index + m[0].length];

  // 安全前提：执行外壳一律不豁免（引号内也能被真正执行）
  if (SHELL_EXEC_WRAPPER_RE.test(c)) return null;

  // 判据 1：命中片段完整落在某个引号字面量内 → 内容是字符串数据
  const inside = quotedSpans(c).find(([s, e]) => s <= span[0] && span[1] <= e);
  if (inside) {
    return {
      basis: "quoted-literal",
      detail: `命中片段位于引号字面量内 [${inside[0]},${inside[1]})`,
      span,
    };
  }

  // 判据 2：命中片段之前有显式数据标记，且命令本身非变更类
  const before = c.slice(0, m.index);
  const marker = DATA_MARKER_RES.find((re) => re.test(before));
  if (marker && !isMutatingBashCmd(c)) {
    return { basis: "data-marker", detail: `片段前有数据标记 ${String(marker)}，且命令非变更类`, span };
  }

  // 判据 3：首 token 是只读输出命令
  const head = c.trim().replace(CMD_PREFIX_RE, "").trim();
  if (READONLY_HEAD_RE.test(head)) {
    return { basis: "readonly-head", detail: `只读输出命令：${head.split(/\s+/)[0]}`, span };
  }

  return null;
}
