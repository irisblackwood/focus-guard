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
