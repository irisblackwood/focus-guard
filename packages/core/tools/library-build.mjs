// FocusGuard 积木构建器 v3.0.5（资料分层双轨：静态资料区 → 派生积木视图）
//
// "把原文拆成积木"：把 .ai/library/ 的外部来源原文按 ## 标题切成自包含积木块，每块带指纹与
// 溯源 frontmatter，产出到 .ai/output/library/，并生成 INDEX.md 清单（一行一条指针，索引与内容分离）。
// 资料分层（《资料与代码分层总规范》）：library 只放外部原文且只同步不就地改；本工具产出的是派生
// 视图，同样禁止直写（guard.mjs LIBRARY_RE / BLOCKS_RE 拦截 Write/Edit，防自我投毒）。
//
// 用法：
//   node tools/library-build.mjs [--src <目录或文件，可多次>] [--out <目录>] [--name <源标签>]
//   默认 --src .ai/library --out .ai/output/library
//   幂等：源内容未变（SHA-256 一致）的积木跳过重建；源删除的积木标记 retired 不物理删除（留痕原则）。
//
// 积木格式（NNN-slug.md）：
//   ---
//   id: B001
//   title: <节标题>
//   source: <源文件相对路径>#<节标题>
//   sha256: <节内容指纹>
//   built: <ISO 时间>
//   tags: <从源文件名与标题派生>
//   ---
//   <节正文>

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync,
} from "node:fs";
import { join, basename, relative, dirname } from "node:path";
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const slug = (s) =>
  s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "block";

const DEFAULT_SRC = ".ai/library"; // 静态资料区：外部来源原文（只同步不就地改）
const DEFAULT_OUT = ".ai/output/library"; // 派生积木视图：由本工具生成

function parseArgs(argv) {
  const args = { src: [], out: DEFAULT_OUT, name: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--src") args.src.push(argv[++i]);
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--name") args.name = argv[++i];
  }
  if (!args.src.length) args.src.push(DEFAULT_SRC);
  return args;
}

function collectFiles(src) {
  const out = [];
  const st = statSync(src);
  if (st.isFile()) return src.endsWith(".md") ? [src] : out;
  for (const e of readdirSync(src)) {
    if (e === "README.md") continue; // 区说明文件不是资料，不入积木
    const p = join(src, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...collectFiles(p));
    else if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

// 按 ## 标题切积木；无 ## 的文件整体作为一块
function splitBlocks(text) {
  const lines = text.split("\n");
  const heads = [];
  lines.forEach((l, i) => {
    if (/^## (?!#)/.test(l)) heads.push(i);
  });
  if (!heads.length) {
    const t = (lines[0] || "").replace(/^#+\s*/, "").trim() || "全文";
    return [{ title: t, body: text }];
  }
  const blocks = [];
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h];
    const end = h + 1 < heads.length ? heads[h + 1] : lines.length;
    const title = lines[start].replace(/^##\s*/, "").trim();
    const body = lines.slice(start + 1, end).join("\n").trim();
    if (body) blocks.push({ title, body });
  }
  return blocks;
}

// 主题导航：只影响 INDEX.md 的分组渲染——积木编号、文件名、指纹与内容一律不动。
// 判定按标题顺序匹配，先命中先归组；改分组只改这张表，无需重建积木。
const THEMES = [
  ["验证与证据纪律", /验证|证据|oracle|保真|校准|问责|auto-review|自我审查|复核|advisor|诚实声明|防幻觉/],
  ["记忆 · 图书馆 · 写入面", /记忆|memory|patterns|图书馆|积木|压缩|skill|经验文件|会话基建|doctor|写入面|截断/],
  ["委派 · 蜂群 · 编排", /委派|worker|子代理|subagent|蜂群|swarm|多代理|cowork|调度|编排|并行|等待|所有权|共存|谱系|路由器|关键路径|任务设计/],
  ["边界 · 身份 · 信任模型", /边界|身份|归属|反猜测|谄媚|信任|档位/],
  ["危险操作与授权门", /危险|确认|审批|授权|权限|白名|注入|computer-use|safety|安全条款|防护|意图论|好条款|规则风格/],
  ["长任务 · 交付 · 流程纪律", /不早停|持久|步数|预算|额度|kpi|幽灵任务|收尾声明|监护/],
  ["输出 · 写作 · 格式规范", /输出|简洁|写作|微格式|前端|\bui\b|design|金句|风格/],
  ["检索 · 提问 · 澄清", /提问|澄清|搜索|查询|检索/],
  ["采纳矩阵与增补", /采纳矩阵|采纳清单|采纳增补/],
  ["产品与资料杂项", /misc|杂锦|杂项|补录|其他|产品|档案|演化|反工具蔓延/],
  ["深审发现（v2.5.3）", /执行摘要|发现清单|修复优先级|方法论附注/],
];
// 按源路径判定：新研读批次整体成组，优先于标题正则（现有 9 份源不含 vault-notes，不受影响）
const SRC_THEMES = [
  ["研读精华（FG3）", /vault-notes\/TOP-TAKEAWAYS/],
  ["厂商研读（FG3）", /vault-notes\/vendors\//],
];
const UNGROUPED = "未归类";
const themeOf = (title, src) => {
  const bySrc = SRC_THEMES.find(([, re]) => re.test(String(src || "")));
  if (bySrc) return bySrc[0];
  return (THEMES.find(([, re]) => re.test(title)) || [])[0] || UNGROUPED;
};

function loadIndex(libDir) {
  const p = join(libDir, "INDEX.md");
  if (!existsSync(p)) return { path: p, rows: [], raw: "" };
  const raw = readFileSync(p, "utf8");
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("| B")) continue;
    const c = line.split("|").map((x) => x.trim());
    // | id | 积木 | 标题 | sha256 | 源 | 状态 |
    if (c.length >= 7 && /^B\d+$/.test(c[1])) rows.push({ id: c[1], file: c[2], title: c[3], sha: c[4], src: c[5] });
  }
  return { path: p, rows, raw };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const libDir = args.out;
  const index = loadIndex(libDir);
  mkdirSync(libDir, { recursive: true });

  const sources = args.src.flatMap(collectFiles);
  let built = 0, kept = 0, maxN = 0;
  for (const v of index.rows) maxN = Math.max(maxN, parseInt(v.id.slice(1), 10) || 0);

  const rows = []; // {id,file,title,sha,src,status}
  const today = new Date().toISOString();
  const normSep = (s) => String(s).replace(/\\/g, "/"); // 幂等配对与平台无关（分隔符归一）
  for (const f of sources) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    const srcLabel = args.name || basename(dirname(f)) || "src";
    const rel = normSep(relative(process.cwd(), f) || f);
    for (const b of splitBlocks(text)) {
      const fp = sha(b.title + "\n" + b.body);
      // 幂等：同内容指纹的积木已存在 → 复用旧 id 与文件（重建不换号；按内容配对，与源路径写法无关）
      const dup = index.rows.find((v) => v.sha === fp);
      if (dup) {
        kept++;
        rows.push({ id: dup.id, file: dup.file, title: b.title, sha: fp, src: rel, status: "保留" });
        continue;
      }
      const id = "B" + String(++maxN).padStart(3, "0");
      const tags = [srcLabel, slug(b.title)].join(",");
      const file = `${id}-${slug(b.title)}.md`;
      const blockPath = join(libDir, file);
      const md = [
        "---",
        `id: ${id}`,
        `title: ${b.title}`,
        `source: ${rel}#${b.title}`,
        `sha256: ${fp}`,
        `built: ${today}`,
        `tags: ${tags}`,
        "---",
        "",
        b.body,
        "",
      ].join("\n");
      writeFileSync(blockPath, md, "utf8");
      built++;
      rows.push({ id, file, title: b.title, sha: fp, src: rel, status: "新建" });
    }
  }

  // 源已消失的积木：标 retired（不物理删——档案不改写原则）
  const activeIds = new Set(rows.map((r) => r.id));
  for (const v of index.rows) {
    if (!activeIds.has(v.id)) rows.push({ id: v.id, file: v.file, title: v.title, sha: v.sha, src: "(源已移除)", status: "retired" });
  }

  // 主题分组渲染：组标题 + 重复表头，保证每组独立成表；`| B` 行格式不变（外部解析器只认该前缀）
  const header = [
    "| id | 积木 | 标题 | sha256(前16) | 源 | 状态 |",
    "|---|---|---|---|---|---|",
  ].join("\n");
  const groups = [];
  for (const r of rows) {
    const name = themeOf(r.title, r.src);
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, rows: [] }));
    g.rows.push(r);
  }
  const themeOrder = [...SRC_THEMES.map(([n]) => n), ...THEMES.map(([n]) => n), UNGROUPED];
  groups.sort((a, b) => themeOrder.indexOf(a.name) - themeOrder.indexOf(b.name));
  const table = groups
    .map((g) =>
      [
        `### ${g.name}（${g.rows.length} 块）`,
        "",
        header,
        ...g.rows.map((r) => `| ${r.id} | ${r.file} | ${r.title} | ${r.sha} | ${r.src} | ${r.status} |`),
      ].join("\n")
    )
    .join("\n\n");
  const indexMd = [
    "# 派生积木 · 索引（积木清单）",
    "",
    "> 本目录是 `.ai/library/` 外部原文的派生视图，由 library-build 生成；禁止直写（引擎拦截 Write/Edit）。",
    "> 索引与内容分离：每行一条指针；积木指纹在此固化，动态卷宗【三】不为其记账（动静隔离）。",
    "> 按主题分组仅为导航（判定表见 library-build.mjs THEMES）：分组变动不改 id、文件名与指纹。",
    "",
    table,
    "",
    `> 构建于 ${today} · 共 ${rows.length} 块（新建 ${built} / 保留 ${kept}）`,
    "",
  ].join("\n");
  writeFileSync(index.path, indexMd, "utf8");

  console.log(`library-build：共 ${rows.length} 块（新建 ${built}，保留 ${kept}），索引 ${index.path}`);
}

main();
