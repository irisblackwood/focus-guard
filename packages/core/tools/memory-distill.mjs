#!/usr/bin/env node
/**
 * 记忆自动沉淀（tools/memory-distill.mjs，2026-11-11）
 *
 * ── 这一件是补什么 ────────────────────────────────────────────────
 * 脑的记忆块只从六份文档读，其中三份在 `self-improvement/memory/` 下：
 *   lessons.md → 左脑（判据）· methods.md → 小脑（程序）· facts.md → 右脑（叙事）
 * 这三份是**私有面**（`.git/info/exclude` 里明确排除），而且历来靠人手写。
 * 于是别人 clone 下来，小脑和右脑恒为 0——不是"从零开始长"，是**根本没有生长机制**。
 *
 * 判据：私有记忆不能靠分发解决，只能靠**各自从自己的行为里长**。
 * 这个工具就是那台生长机：读审计索引，把反复发生的事沉淀成条目写进各自的三份文件。
 *
 * ── 判据（每条都对着一个已知的错）────────────────────────────────
 * ① **只沉淀反复发生的**（默认 ≥8 次，且跨 ≥3 个不同日子）。一次性的动作是日志，
 *    不是记忆；同一天跑 200 次和连着 20 天各跑 10 次，次数一样、意义完全不同。
 * ② **只沉淀程序性的**：tool / action。`file` 不沉淀——182 个文件实体全灌进去，
 *    记忆就退化成文件清单。`trigger` 与法条高度重叠，也不碰。
 * ③ **偏好不代笔**：facts.md 只由人写。从日志里推"用户喜欢什么"，
 *    推出来的永远是"用户最近做了什么"——把行为当偏好，是这类系统的通病。
 * ④ **带 ttl，到期作废**。`{ttl:N}` 此前写进实体却零消费（`tools/` 下无人读），
 *    等于给了一个"会忘"的承诺却不实现。这里让它真的生效：实体超过 N 天没再出现，
 *    条目打 `{invalid:…}`（留痕，不删行），`brain-docs.mjs` 读到就跳过。
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *   node packages/core/tools/memory-distill.mjs           # 沉淀 + 作废
 *   node packages/core/tools/memory-distill.mjs --dry     # 只看会写什么
 *   node packages/core/tools/memory-distill.mjs --min=5   # 改阈值
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classify } from "./lib/brain-regions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..", "..", "..");

/** 数据根跟**工作区**走，不跟包安装位置——和 `brain.mjs` 同一条判据，别各写一套。 */
function repoRoot(cwd = process.cwd()) {
  return [".focus-guard", ".ai"].some((d) => existsSync(join(cwd, d))) ? cwd : PKG_ROOT;
}

/* 沉淀到哪份文件，**由分区判据说**，不另立一套。
   同一个动作在图上落小脑、在记忆里就该进 methods.md——两处判据不一致，
   迟早出现"图上在小脑、记忆里在左脑"的分裂。
   stem（法条）与 right（叙事）不沉淀：前者由 RULES.md 供，后者只由人写。 */
const FILE_OF_REGION = {
  cerebellum: { file: "methods.md", kind: "method", region: "cerebellum" },
  left: { file: "lessons.md", kind: "lesson", region: "left" },
};

const PROMOTE_TYPES = new Set(["tool", "action"]);

const HEADERS = {
  "methods.md": "# 方法（程序性记忆 · 小脑）\n\n由 `memory-distill` 从审计日志自动沉淀；也可以手写。\n" +
    "`{origin:auto,src:auto/<类型>/<名字>,imp:权重,ttl:天}` 是自动条目的身份证——\n" +
    "`src` 用来去重（同一件事不写第二遍），`ttl` 到期且不再发生就作废。\n",
  "lessons.md": "# 坑（判据 · 左脑）\n\n手写为主：踩过的坑要写清「当时错在哪、判据改成什么」，工具推不出来。\n",
  "facts.md": "# 偏好与事实（叙事 · 右脑）\n\n**只由人写。** 从行为里推偏好，推出来的是行为，不是偏好。\n",
};

/** 条目里 `{...}` 的解析口径与 `brain-docs.mjs:metaOf` 一致——两处不一致就必然漂。 */
function metaOf(line) {
  const m = /\{([^}]*)\}/g;
  const out = {};
  let x;
  while ((x = m.exec(line))) {
    for (const kv of x[1].matchAll(/([A-Za-z_]+):([^,]+)/g)) out[kv[1]] = kv[2].trim();
  }
  return out;
}

const isoLocal = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+08:00`;
};

/**
 * 权重从次数来，不拍脑袋：`imp = 3 + log2(c)`，封顶 9。
 * c=8 → 6；c=64 → 9。和 `brain-core` 的强度口径同源（都是"多少次"的函数）。
 */
const weightOf = (c) => Math.min(9, Math.max(3, Math.round(3 + Math.log2(Math.max(1, c)))));

/** 把目标文件读进来。**去重必须基于现有内容**，不能靠"跑过一次就记住"——
    那样换个工作区就重复写。 */
function loadFiles(memDir) {
  const files = {};
  for (const name of new Set(Object.values(FILE_OF_REGION).map((p) => p.file))) {
    const p = join(memDir, name);
    const existed = existsSync(p);
    const lines = existed ? readFileSync(p, "utf8").split("\n") : [];
    files[name] = { path: p, existed, lines: lines.length ? lines : HEADERS[name].split("\n") };
  }
  return files;
}

/** 现有自动条目：`src:auto/<type>/<name>` → 行号。 */
function indexAuto(files) {
  const seen = new Map();
  for (const [name, f] of Object.entries(files)) {
    f.lines.forEach((line, i) => {
      if (!/^- \[/.test(line)) return;
      const m = metaOf(line);
      if (m.src && m.src.startsWith("auto/")) seen.set(m.src, { file: name, line: i });
    });
  }
  return seen;
}

/** 第一趟：作废。到期且实体已不再出现 → 打 invalid，不删行。 */
function expirePass(files, seen, ents, now, ttl, dry) {
  const expired = [];
  for (const [src, at] of seen) {
    const ent = ents[src.slice(5)];            // "auto/tool/xxx" → "tool/xxx"
    const line = files[at.file].lines[at.line];
    if (/\{invalid:\d{4}-\d{2}-\d{2}T/.test(line)) continue;
    const days = Number(metaOf(line).ttl || ttl);
    const last = ent ? Date.parse(ent.l) : 0;
    /* 实体还在、且最近 N 天内出现过 → 续命。**判据用"最后一次出现"，
       不用"条目写下的时间"**：一件事天天在做，就不该因为条目旧了而忘掉。 */
    if (ent && (now - last) / 86400e3 <= days) continue;
    expired.push({ src, file: at.file, days: Math.round((now - last) / 86400e3) });
    if (!dry) {
      files[at.file].lines[at.line] = line +
        ` {invalid:${isoLocal(now)},origin:auto,reason:${ent ? `${days} 天未再出现` : "实体已消失"}}`;
    }
  }
  return expired;
}

/** 够格沉淀的候选，按次数降序——先写最硬的。 */
function pickCandidates(ents, seen, now, min) {
  const cands = [];
  for (const [key, e] of Object.entries(ents)) {
    if (!PROMOTE_TYPES.has(e.t) || (e.c || 0) < min) continue;
    const src = `auto/${key}`;
    if (seen.has(src)) continue;

    /* 判"习惯"还是"爆发"，**用出现过的天数**，不用日历闸。
       索引里每个实体自带按天直方图 `h`——同一天里跑 200 次和连着 20 天各跑 10 次，
       次数一样、意义完全不同，只有直方图分得开。
       要求：① 跨 ≥3 个不同日子；② 最近 30 天内还在出现（停了的就不再是"现在的方法"）。 */
    const days = Object.keys(e.h || {}).length;
    const last = Date.parse(e.l || "") || 0;
    if (days < 3 || !last || (now - last) / 86400e3 > 30) continue;

    const dest = FILE_OF_REGION[classify(e.t, e.n, {}).r];
    if (!dest) continue;                       // 落到脑干/右脑的不沉淀
    cands.push({ key, e, dest, src });
  }
  return cands.sort((a, b) => (b.e.c || 0) - (a.e.c || 0));
}

/** 一条条目长什么样。正文带最近一次的**实际样本**——
    只有次数的条目是流水账（"residue-check 7356 次"读不出任何东西）；
    带上内容它才是一条能读、能核对、能反驳的记忆。 */
function entryOf(c, now, ttl) {
  const sample = (c.e.x && c.e.x.length ? String(c.e.x[c.e.x.length - 1]) : "")
    .replace(/\s+/g, " ").trim().slice(0, 160);
  return `- [${isoLocal(c.e.l || now)}] (${c.dest.kind}) 反复${c.e.t === "tool" ? "用" : "做"}「${c.e.n}」` +
    `${c.e.c} 次，${String(c.e.f || "").slice(0, 10)} 起、最近 ${String(c.e.l || "").slice(0, 10)}` +
    (sample ? `；最近一次：${sample}` : "") +
    ` {origin:auto,src:${c.src},imp:${weightOf(c.e.c)},ttl:${ttl}}`;
}

/** 落盘。内容没变就不写——否则每跑一次 brain 都改 mtime，日志里全是假变更。 */
function flush(files, memDir) {
  mkdirSync(memDir, { recursive: true });
  for (const [, f] of Object.entries(files)) {
    const body = f.lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
    if ((f.existed ? readFileSync(f.path, "utf8") : null) !== body) writeFileSync(f.path, body);
  }
}

export function distill(opts = {}) {
  const repo = opts.repo || repoRoot();
  const min = Number(opts.min || 8);
  const ttl = Number(opts.ttl || 90);
  const dry = Boolean(opts.dry);
  const memDir = join(repo, "self-improvement", "memory");
  const idxPath = join(repo, ".focus-guard", "brain-index.json");

  /* 索引优先用调用方传进来的那份。`brain.mjs` 里沉淀排在 `saveIndex` 之前
     （新条目要同轮进脑），此时盘上还没有索引——去读文件会得到"没有索引，
     先跑一次 npm run brain"，而用户正在跑的**就是** brain。 */
  let ents;
  if (opts.idx) {
    ents = opts.idx.entities || {};
  } else {
    if (!existsSync(idxPath)) {
      return { ok: false, reason: "没有索引（先跑一次 npm run brain）", added: 0, expired: 0 };
    }
    ents = JSON.parse(readFileSync(idxPath, "utf8")).entities || {};
  }
  const now = Date.now();
  const files = loadFiles(memDir);
  const seen = indexAuto(files);

  const expired = expirePass(files, seen, ents, now, ttl, dry);
  const added = [];
  for (const c of pickCandidates(ents, seen, now, min)) {
    added.push({ file: c.dest.file, name: c.e.n, count: c.e.c, imp: weightOf(c.e.c), region: c.dest.region });
    if (!dry) files[c.dest.file].lines.push(entryOf(c, now, ttl));
  }
  if (!dry) flush(files, memDir);
  return { ok: true, repo, added, expired, dry, min, ttl };
}

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const min = Number((argv.find((a) => a.startsWith("--min=")) || "").split("=")[1] || 8);
  const r = distill({ dry, min });
  if (!r.ok) {
    process.stderr.write(`${r.reason}\n`);
    process.exit(1);
  }
  const head = r.dry ? "（演练，不落盘）" : "";
  process.stdout.write(`记忆沉淀${head}：新增 ${r.added.length} 条 · 作废 ${r.expired.length} 条\n`);
  for (const a of r.added) process.stdout.write(`  + ${a.file}  ${a.name}（${a.count} 次 · imp ${a.imp}）\n`);
  for (const e of r.expired) process.stdout.write(`  - ${e.file}  ${e.src}（${e.days} 天未出现）\n`);
  if (!r.added.length && !r.expired.length) process.stdout.write("  没有够格沉淀的（阈值 8 次），也没有到期的。\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
