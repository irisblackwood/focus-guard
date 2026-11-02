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
  REGIONS, applyEvent, applySeqLinks, classify, emptyIndex, entitiesOf, listSources, loadConfig,
  loadIndex, prune, readNewLines, reclassify, saveIndex, snapshot,
} from "./lib/brain-core.mjs";
import { syncDocs } from "./lib/brain-docs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
/* 包根：仓库里是 `packages/core`，装到 node_modules 之后就是包自己。
   文档源的路径在两个位置不同，`readDocs` 两个基都试。 */
const PKG = resolve(HERE, "..");

const DEFAULTS = {
  log: join(REPO, ".focus-guard", "AUDIT.log"),
  out: join(REPO, ".focus-guard", "brain.html"),
  index: join(REPO, ".focus-guard", "brain-index.json"),
  config: join(REPO, ".focus-guard", "brain-config.json"),
  casefile: join(REPO, ".ai", "CASE_FILE.md"),
  maxNodes: 3000,
  maxEdges: 12000,
  maxInf: 800,
};

function parseArgs(argv) {
  const o = { ...DEFAULTS, json: false, open: false, rebuild: false, unknown: false, casefileWrite: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--open") o.open = true;
    else if (a === "--rebuild") o.rebuild = true;
    else if (a === "--unknown") o.unknown = true;
    else if (a === "--casefile") o.casefileWrite = true;
    else if (a === "--log") o.log = resolve(argv[++i]);
    else if (a === "--out") o.out = resolve(argv[++i]);
    else if (a === "--index") o.index = resolve(argv[++i]);
    else if (a === "--config") o.config = resolve(argv[++i]);
    else if (a === "--max-nodes") o.maxNodes = Number(argv[++i]) || o.maxNodes;
    else if (a === "--max-edges") o.maxEdges = Number(argv[++i]) || o.maxEdges;
    else if (a === "--max-inf") o.maxInf = Number(argv[++i]) || o.maxInf;
  }
  return o;
}

/** 一批新行 → 索引。seq 链要跨行，所以按批聚合后再补边。 */
function ingest(idx, lines, repo, now, cfg) {
  const groups = new Map();
  let added = 0;
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    added += applyEvent(idx, rec, repo, now, cfg);
    if (!rec.seq) continue;
    const ids = entitiesOf(rec, repo, cfg).map((e) => `${e.type}:${e.name}`);
    if (!ids.length) continue;
    const g = groups.get(rec.seq) || [];
    g.push({ ids, t: Date.parse(rec.ts || "") || now });
    groups.set(rec.seq, g);
  }
  applySeqLinks(idx, [...groups.values()], now);
  return added;
}

function readAll(opts, idx, now, cfg) {
  let added = 0;
  let sources = 0;
  for (const src of listSources(opts.log)) {
    const { lines, cursor } = readNewLines(src.path, idx.cursors[src.path]);
    idx.cursors[src.path] = cursor;
    if (!lines.length) continue;
    sources++;
    added += ingest(idx, lines, REPO, now, cfg);
  }
  return { added, sources };
}

/**
 * 认不出来的东西，报出来——这是"灵活"的落点。
 *
 * 分类器没命中词表时**不猜**，标 fallback。但光标记没用，人看不见。
 * 这里把 fallback 的实体按次数排序打出来，并附一条**共现建议**：
 * 跟它连得最多的邻居都在哪个区，就建议归到哪个区。
 *
 * 为什么建议只进报告、不自动生效：分区决定位置（位置 = hash → 分区顶点池）。
 * 让分区随图演化，同一个实体会今天在左脑、明天在右脑——那就看不出东西在长了。
 * 自动学习只配**提议**，落地必须写进配置，由人拍板。
 */
function reportUnknown(idx, cfg, configPath) {
  // 空索引说「没有认不出来的」是假绿——那是没东西可认，不是都认出来了。
  if (!Object.keys(idx.entities || {}).length) {
    process.stdout.write("索引为空（还没跑过，或索引版本已升级被丢弃）。先跑一次 npm run brain。\n");
    return;
  }
  const adj = new Map();
  for (const e of Object.values(idx.edges)) {
    for (const [a, b] of [[e.s, e.t], [e.t, e.s]]) {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(b);
    }
  }
  const rows = [];
  for (const [id, n] of Object.entries(idx.entities)) {
    const c = classify(n.t, n.n, cfg);
    if (c.why !== "fallback" && c.why !== "fallback-trigger") continue;
    const tally = {};
    for (const nb of adj.get(id) || []) {
      const m = idx.entities[nb];
      if (!m) continue;
      tally[m.r] = (tally[m.r] || 0) + 1;
    }
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    rows.push({ id, type: n.t, name: n.n, count: n.c, region: n.r, why: c.why, suggest: top ? top[0] : "", hits: top ? top[1] : 0 });
  }
  rows.sort((a, b) => b.count - a.count);

  if (!rows.length) {
    process.stdout.write("分类器：没有认不出来的实体（全部命中词表或结构判据）。\n");
    return;
  }
  const lines = rows.slice(0, 40).map(
    (r) =>
      `  ${String(r.count).padStart(5)} 次  ${r.type.padEnd(7)} ${r.name.slice(0, 52).padEnd(52)}` +
      `→ ${REGIONS[r.region].label}` +
      (r.suggest ? `　（邻居多在${REGIONS[r.suggest].label} ${r.hits} 个）` : ""),
  );
  process.stdout.write(
    `分类器：${rows.length} 个实体没命中词表，暂按兜底处理（共 ${rows.reduce((s, r) => s + r.count, 0)} 次）。\n` +
      `补词表：在 ${String(configPath).replace(REPO, ".").replace(/\\/g, "/")} 里写 ` +
      `{"lexicon":{"stem":["…"]}}，或 {"rules":[{"re":"…","region":"stem"}]}\n` +
      `${lines.join("\n")}\n` +
      (rows.length > 40 ? `  …另有 ${rows.length - 40} 个\n` : ""),
  );
}

/**
 * 卷宗反写：把推断关联写成【六】段，让卷宗自己长出「相关条目」。
 *
 * 为什么默认**不写**、要显式 `--casefile`：脑是只读面的工具，卷宗是判定面的文件。
 * 每次跑脑都顺手改判定面的文件，测试里那条「软记录变化」就会被自己的噪音淹掉，
 * 而且"只读审计"这条边界也就名存实亡。要写，就写成一个明确的动作。
 */
function writeCaseFile(casePath, g, now, events) {
  const name = (i) => (g.nodes[i] ? g.nodes[i].name : "?");
  // 两边都是盘符绝对路径（`E:/DSH/_install/*.mjs` 那批探针）互相关联，信息量最低：
  // 它们本来就同目录同批产生。过滤掉，把位置让给本仓内的关联。
  const external = (s) => /^[A-Za-z]:\//.test(String(s));
  const cand = g.edges.filter((e) => e.k === "inf" && e.v >= 0.5 && !(external(name(e.s)) && external(name(e.t))));
  const rows = cand.slice(0, 20).map(
    (e) =>
      `| \`${name(e.s)}\` | \`${name(e.t)}\` | ${e.v.toFixed(2)} | ${e.parts?.aa ?? "-"} | ${e.parts?.aff ?? "-"} | ${e.parts?.tmp ?? "-"} |`,
  );
  const block =
    `### 【六】相关条目（脑推断 · 非人工填写）\n\n` +
    `> 由 \`npm run brain -- --casefile\` 生成，${new Date(now).toISOString().slice(0, 16).replace("T", " ")}。\n` +
    `> 判据：两个实体**从未在同一行出现**，但共享冷门中间物（结构）、同目录（亲缘）、\n` +
    `> 或同一段时间一起活跃（共活跃）。只列综合分 ≥ 0.5 的前 20 条，分数逐项可复算。\n` +
    `> 用途：查一个东西时先看它跟谁有关，不必把 ${events} 条事件从头读一遍。\n` +
    `> 已排除「两边都是盘符绝对路径」的条目——那批探针同目录同批产生，关联是自明的。\n\n` +
    `| 甲 | 乙 | 分 | 结构 | 亲缘 | 共活跃 |\n|---|---|---|---|---|---|\n` +
    `${rows.join("\n")}\n`;

  const old = existsSync(casePath) ? readFileSync(casePath, "utf8") : "";
  const at = old.search(/^### 【六】/m);
  let head = old;
  if (at >= 0) {
    // 只替换【六】这一段，后面的【七】…（如果哪天加了）原样保留
    const nextAt = old.slice(at + 1).search(/^### 【/m);
    head = old.slice(0, at) + (nextAt >= 0 ? old.slice(at + 1 + nextAt) : "");
  } else if (old && !old.endsWith("\n")) {
    head = `${old}\n`;
  }
  writeFileSync(casePath, head + (head.endsWith("\n\n") ? "" : "\n") + block);
  return rows.length;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const cfg = loadConfig(o.config);

  if (o.rebuild && existsSync(o.index)) rmSync(o.index, { force: true });
  const idx = o.rebuild ? emptyIndex() : loadIndex(o.index);

  if (o.unknown) {
    reportUnknown(idx, cfg, o.config);
    return;
  }

  const moved = reclassify(idx, cfg);
  const { added, sources } = readAll(o, idx, now, cfg);
  // 文档源：日志记的是"我碰过什么"，文档记的是"我知道什么"。
  // 只有前者的时候，脑认识 `docs/RULES.md` 被提到 85 次，却不知道那 85 次说了什么。
  const docs = syncDocs(idx, REPO, o.docs, PKG);
  const dropped = prune(idx, now);
  saveIndex(o.index, idx, now);

  const g = snapshot(idx, now, o.maxNodes, o.maxEdges, o.maxInf);
  // 每个点自证位置：分区是按什么判据定的。没有这一行，点开只看到"它在左脑"，
  // 却不知道为什么——那正是"知识看起来莫名其妙"的来源。
  // 记忆块的分区来自**它所在的文档**（法条→脑干、方法→小脑），不是词表打分，所以单独标。
  for (const n of g.nodes) n.w = n.type === "memory" ? "source" : classify(n.type, n.name, cfg).why;
  const regionCount = {};
  for (const n of g.nodes) regionCount[n.r] = (regionCount[n.r] || 0) + 1;
  const from = g.nodes.reduce((m, n) => (!m || (n.f && n.f < m) ? n.f : m), "");
  const to = g.nodes.reduce((m, n) => (n.l && n.l > m ? n.l : m), "");

  const meta = {
    log: o.log.replace(REPO, "").replace(/\\/g, "/"),
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
    memories: docs.blocks,
    // 实读数，不是配置数。界面要能说"这个脑是从几份文档长出来的"。
    memorySources: docs.sources,
    memoryMissing: docs.missing.length,
    from,
    to,
    regions: regionCount,
    halfLives: Object.fromEntries(Object.entries(REGIONS).map(([k, v]) => [k, v.halfLife])),
  };

  if (o.json) {
    process.stdout.write(JSON.stringify({ meta, nodes: g.nodes, edges: g.edges }, null, 1));
    return;
  }

  const tpl = readFileSync(join(HERE, "brain-view.html"), "utf8");
  const payload = JSON.stringify({ meta, nodes: g.nodes, edges: g.edges }).replace(/<\//g, "<\\/");
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, tpl.replace("/*__FG_BRAIN_DATA__*/null", payload));

  const cf = o.casefileWrite ? writeCaseFile(o.casefile, g, now, idx.seen) : 0;
  report(o, { g, idx, added, sources, moved, dropped, docs, regionCount, from, to, cf });
}

/* 汇总输出单独成函数：它跟"跑一遍"本来就是两件事，混在 main() 里只会让流程读不清。
   判据要的是"这一段能不能读懂"，不是"能不能压到 80 行"。 */
function report(o, x) {
  const rl = Object.entries(REGIONS)
    .map(([k, v]) => `${v.label} ${x.regionCount[k] || 0}`)
    .join(" · ");
  process.stdout.write(
    `脑已更新：${o.out.replace(REPO, ".")}\n` +
      `  新增 ${x.added} 条（源 ${x.sources} 个）· 累计 ${x.idx.seen} 条事件 · 遗忘 ${x.dropped} 个 · 重分区 ${x.moved} 个\n` +
      `  记忆 ${x.docs.blocks} 块（实读 ${x.docs.sources} 份文档` +
      (x.docs.missing.length ? `，缺 ${x.docs.missing.length} 份` : "") +
      (x.docs.stale ? `，跳过作废 ${x.docs.stale} 条` : "") + `）\n` +
      memLine(x.docs) +
      `  ${x.g.nodes.length} 实体 / ${x.g.edges.length} 边（推断 ${x.g.inferred}）　${rl}\n` +
      `  知识簇：${x.g.clusters.map((c) => `${c.name}(${c.size})`).slice(0, 6).join(" · ") || "（无）"}\n` +
      (o.casefileWrite ? `  卷宗【六】已写：${x.cf} 条相关条目 → ${o.casefile.replace(REPO, ".")}\n` : "") +
      // 空态下不报日期范围：那两头的日期来自**文档条目**的 mtime，跟"事件"没关系，
      // 写着只是让人以为有 24 小时的数据。判据要用事件数，不能用 from 是否为空。
      `  ${x.idx.seen ? `${x.from.slice(0, 10)} → ${x.to.slice(0, 10)}　` : "尚无审计事件　"}索引 ${(readFileSync(o.index).length / 1024).toFixed(0)} KB\n`,
  );
}

/* 关联要报**连上了多少**，不能只报"有连边"——孤岛多少同样是事实。
   上一版只写「记忆 356 块」，于是"关联做好了"这句话成立了三周，图上一直是散点。 */
function memLine(d) {
  return `  记忆关联：痕迹 ${d.trace} · 互引 ${d.ref} · 同题 ${d.share}` +
    (d.orphan ? `　落空 ${d.orphan} 处` : "") + "\n";
}

main();
