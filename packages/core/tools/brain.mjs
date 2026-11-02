#!/usr/bin/env node
/**
 * 3D 脑（tools/brain.mjs，2026-11-02）——零依赖，产出单文件 HTML。
 *
 * 为什么做这个：
 *   `AUDIT.log` 是一列按时间排的事件。时间轴告诉你「发生了什么」，不告诉你
 *   「什么东西在长、什么东西正在被忘掉」。这个工具把事件流摊成一个体积：
 *   **实体是位置，共现是连线，强度是大小**。
 *
 * 三条判据（缺一条这东西就只是烟花）：
 *   ① 位置 = FNV-1a(实体名) → 皮层顶点。实体不变，位置就不变。
 *   ② 位置由**分区**决定：脑干/小脑/大脑左右半球各自一块。解剖位置即语义。
 *   ③ 大小与亮度 = **遗忘曲线**（Ebbinghaus 指数衰减）。常用的亮，久不用的淡。
 *
 * 为什么要有索引（`.focus-guard/brain-index.json`）：
 *   审计按事件增长，永无止境；但**记忆的价值不随事件数增长**——第 8000 条和
 *   第 8001 条讲的多半是同一批文件。所以这里把事件聚合成实体：**事件无界，实体有界**。
 *   索引增量更新（游标），并随强度修剪——这是"不无限增长"的真正实现。
 *   附带效果：`archive/` 里的原始底稿可以删，记忆不会丢（索引里已有聚合）。
 *
 * 边界（硬性，别越）：
 *   ① **只读审计**。不写 AUDIT.log、不碰状态文件、不改任何判定。只写自己的索引与 HTML。
 *   ② **不进 hook**。`npm run brain` 手动跑一次，不在任何工具调用路径上。
 *   ③ **不打包第三方皮层数据**。网格是 `buildMesh` 自己算的。
 *   ④ **不引 three.js**。本仓 `dependencies: {}` 是唯一的性格。
 *
 * 用法：
 *   node packages/core/tools/brain.mjs                 # 增量 → .focus-guard/brain.html
 *   node packages/core/tools/brain.mjs --open
 *   node packages/core/tools/brain.mjs --rebuild       # 丢掉索引，从头重算
 *   node packages/core/tools/brain.mjs --json          # 只打图数据（供测试）
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REGIONS, applyEvent, applySeqLinks, emptyIndex, entitiesOf, listSources, loadIndex,
  prune, readNewLines, saveIndex, snapshot,
} from "./lib/brain-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

const DEFAULTS = {
  log: join(REPO, ".focus-guard", "AUDIT.log"),
  out: join(REPO, ".focus-guard", "brain.html"),
  index: join(REPO, ".focus-guard", "brain-index.json"),
  maxNodes: 3000,
  maxEdges: 12000,
  maxInf: 800,
};

function parseArgs(argv) {
  const o = { ...DEFAULTS, json: false, open: false, rebuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--open") o.open = true;
    else if (a === "--rebuild") o.rebuild = true;
    else if (a === "--log") o.log = resolve(argv[++i]);
    else if (a === "--out") o.out = resolve(argv[++i]);
    else if (a === "--index") o.index = resolve(argv[++i]);
    else if (a === "--max-nodes") o.maxNodes = Number(argv[++i]) || o.maxNodes;
    else if (a === "--max-edges") o.maxEdges = Number(argv[++i]) || o.maxEdges;
    else if (a === "--max-inf") o.maxInf = Number(argv[++i]) || o.maxInf;
  }
  return o;
}

/** 一批新行 → 索引。seq 链要跨行，所以按批聚合后再补边。 */
function ingest(idx, lines, repo, now) {
  const groups = new Map();
  let added = 0;
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    added += applyEvent(idx, rec, repo, now);
    if (!rec.seq) continue;
    const ids = entitiesOf(rec, repo).map((e) => `${e.type}:${e.name}`);
    if (!ids.length) continue;
    const g = groups.get(rec.seq) || [];
    g.push({ ids, t: Date.parse(rec.ts || "") || now });
    groups.set(rec.seq, g);
  }
  applySeqLinks(idx, [...groups.values()], now);
  return added;
}

function readAll(opts, idx, now) {
  let added = 0;
  let sources = 0;
  for (const src of listSources(opts.log)) {
    const { lines, cursor } = readNewLines(src.path, idx.cursors[src.path]);
    idx.cursors[src.path] = cursor;
    if (!lines.length) continue;
    sources++;
    added += ingest(idx, lines, REPO, now);
  }
  return { added, sources };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = Date.now();

  if (opts.rebuild && existsSync(opts.index)) rmSync(opts.index, { force: true });
  const idx = opts.rebuild ? emptyIndex() : loadIndex(opts.index);
  const { added, sources } = readAll(opts, idx, now);
  const dropped = prune(idx, now);
  saveIndex(opts.index, idx, now);

  const g = snapshot(idx, now, opts.maxNodes, opts.maxEdges, opts.maxInf);
  const regionCount = {};
  for (const n of g.nodes) regionCount[n.r] = (regionCount[n.r] || 0) + 1;
  const from = g.nodes.reduce((m, n) => (!m || (n.f && n.f < m) ? n.f : m), "");
  const to = g.nodes.reduce((m, n) => (n.l && n.l > m ? n.l : m), "");

  const meta = {
    log: opts.log.replace(REPO, "").replace(/\\/g, "/"),
    generatedAt: new Date(now).toISOString(),
    events: idx.seen,
    added,
    sources,
    nodes: g.nodes.length,
    edges: g.edges.length,
    inferred: g.inferred,
    clusters: g.clusters,
    total: g.total,
    totalEdges: g.totalEdges,
    truncated: g.nodes.length < g.total,
    forgotten: dropped,
    from,
    to,
    regions: regionCount,
    halfLives: Object.fromEntries(Object.entries(REGIONS).map(([k, v]) => [k, v.halfLife])),
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify({ meta, nodes: g.nodes, edges: g.edges }, null, 1));
    return;
  }

  const tpl = readFileSync(join(HERE, "brain-view.html"), "utf8");
  const payload = JSON.stringify({ meta, nodes: g.nodes, edges: g.edges }).replace(/<\//g, "<\\/");
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, tpl.replace("/*__FG_BRAIN_DATA__*/null", payload));

  const rl = Object.entries(REGIONS)
    .map(([k, v]) => `${v.label} ${regionCount[k] || 0}`)
    .join(" · ");
  process.stdout.write(
    `脑已更新：${opts.out.replace(REPO, ".")}\n` +
      `  新增 ${added} 条（源 ${sources} 个）· 累计 ${idx.seen} 条事件 · 遗忘 ${dropped} 个\n` +
      `  ${g.nodes.length} 实体 / ${g.edges.length} 边（推断 ${g.inferred}）　${rl}\n` +
      `  知识簇：${g.clusters.map((c) => `${c.name}(${c.size})`).slice(0, 6).join(" · ") || "（无）"}\n` +
      `  ${(from || "").slice(0, 10)} → ${(to || "").slice(0, 10)}　索引 ${(readFileSync(opts.index).length / 1024).toFixed(0)} KB\n`,
  );
}

main();
