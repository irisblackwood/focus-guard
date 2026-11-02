/**
 * 脑的数据层（tools/lib/brain-core.mjs，2026-11-02）——零依赖，纯函数 + 一个索引文件。
 *
 * 为什么要有"索引"这层，而不是每次从头扫日志：
 *   审计日志按事件增长，一天几十到上千行，永无止境。任何"每次全量重算"的方案，
 *   成本都随事件数线性上涨，而**记忆的价值不随事件数上涨**——第 8,000 条和
 *   第 8,001 条讲的多半是同一批文件。
 *   所以这里把"事件"聚合成"实体"：**事件无界，实体有界**。这是唯一能给出稳态上界的东西
 *   （与 P0-1 学到的是同一条：只有上限能给稳态上界，年龄不能）。
 *
 * 遗忘曲线（Ebbinghaus 的指数衰减，改成增量式）：
 *   每次命中：s ← s · 2^(−Δt/半衰期) + 1
 *   展示时再衰减到"现在"：s_now = s · 2^(−(now−last)/半衰期)
 *   增量式的好处是不用存历史，O(1) 更新，且天然满足"常用的忘得慢"——
 *   命中越频繁，两次衰减之间的间隔越短，衰减越少。
 *
 * 分区（解剖位置即语义）：
 *   脑干   不可违的硬约束（条号、deny/熔断/红线）—— 永不遗忘
 *   小脑   程序性记忆（工具、机械动作）—— 忘得最慢
 *   大脑左 判据与逻辑（代码）—— 正常衰减
 *   大脑右 陈述与叙事（文档、事件）—— 忘得最快
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { detectClusters, inferRelations, pmi } from "./brain-relate.mjs";
import { REGIONS, isNoise, regionOf } from "./brain-regions.mjs";

// 分区判据在 brain-regions.mjs，这里原样转出去——调用方（工具与测试）不必知道它搬家了。
export { DEFAULT_LEXICON, REGIONS, classify, isNoise, loadConfig, regionOf } from "./brain-regions.mjs";

/* ── 分区与半衰期 ────────────────────────────────────────────── */
export const lambdaOf = (halfLife) => (halfLife === Infinity ? 0 : Math.LN2 / halfLife);
const DAY = 86400e3;
const days = (a, b) => (a && b ? Math.max(0, (b - a) / DAY) : 0);

/** 把 strength 从 last 衰减到 now。 */
export function decayTo(s, lastIso, halfLife, now) {
  const t = Date.parse(lastIso);
  if (!t || !Number.isFinite(t)) return s;
  return s * Math.exp(-lambdaOf(halfLife) * days(t, now));
}

/* ── 实体抽取 ───────────────────────────────────────────────── */
const PER_LINE_FILES = 6;
const PER_LINE_RULES = 2;
const FILE_RE =
  /(?:[A-Za-z]:)?[A-Za-z0-9_.\-/\\]*[A-Za-z0-9_\-]\.(?:mjs|js|cjs|json|md|log|html|yml|yaml|txt|py|sh|ps1|bat)\b/g;
const RULE_CN_RE = /第[一二三四五六七八九十百零〇\d]{1,6}条/g;
const RULE_NUM_RE = /(?:^|[^\d.])(\d{1,3})条/g;
const SEC_RE = /§\s?[一二三四五六七八九十]{1,4}/g;

export function normPath(raw, repo) {
  let s = String(raw).replace(/\\/g, "/");
  const r = repo.replace(/\\/g, "/").toLowerCase();
  const at = s.toLowerCase().indexOf(r);
  if (at >= 0) s = s.slice(at + r.length);
  return s.replace(/^\/+/, "").replace(/^\.\//, "");
}

function pushUnique(list, v, cap) {
  if (list.length >= cap || list.includes(v)) return;
  list.push(v);
}

export function entitiesOf(rec, repo, opts = {}) {
  const out = [];
  if (rec.action) out.push({ type: "action", name: String(rec.action) });
  if (rec.tool) out.push({ type: "tool", name: String(rec.tool) });
  // 8,543 行里 action 与 trigger 同名的有 8,075 行（94.5%），同名再建节点只是影子
  if (rec.trigger && rec.trigger !== rec.action) out.push({ type: "trigger", name: String(rec.trigger) });
  const text = `${rec.evidence || ""} ${rec.command || ""}`;
  const files = [];
  for (const m of text.matchAll(FILE_RE)) pushUnique(files, normPath(m[0], repo), PER_LINE_FILES);
  for (const f of files) if (f && f.includes(".") && !isNoise(f, opts.noise)) out.push({ type: "file", name: f });
  const rules = [];
  for (const m of text.matchAll(RULE_CN_RE)) pushUnique(rules, m[0], PER_LINE_RULES);
  for (const m of text.matchAll(RULE_NUM_RE)) pushUnique(rules, `第${m[1]}条`, PER_LINE_RULES);
  for (const m of text.matchAll(SEC_RE)) pushUnique(rules, m[0].replace(/\s+/g, ""), PER_LINE_RULES);
  for (const r of rules) out.push({ type: "rule", name: r });
  return out;
}

/* ── 索引：加载 / 增量更新 / 落盘 ───────────────────────────── */
export const INDEX_VERSION = 3; // v2 加按天直方图；v3 分区判据重写（旧索引里的 r 是旧判据算的，必须重算）
const MAX_ENTITIES = 20000;
const MAX_EDGES = 60000;
const FORGET_STRENGTH = 0.05; // 低于这个且一年没动 → 真的忘了，删

export function emptyIndex() {
  return { v: INDEX_VERSION, updatedAt: "", cursors: {}, entities: {}, edges: {}, seen: 0 };
}

export function loadIndex(path) {
  if (!existsSync(path)) return emptyIndex();
  try {
    const idx = JSON.parse(readFileSync(path, "utf8"));
    if (idx.v !== INDEX_VERSION) return emptyIndex();
    idx.entities = idx.entities || {};
    idx.edges = idx.edges || {};
    idx.cursors = idx.cursors || {};
    return idx;
  } catch {
    return emptyIndex();
  }
}

/**
 * 按**当前**判据重算所有实体的分区。
 *
 * 分区在实体创建时就固化了，可判据会变（补了词表、改了配置、升级了默认表）。
 * 不重算的话，改配置对老实体不生效——"灵活"就成了只对新数据灵活，那等于没有。
 * 只改 `r`，不动强度：强度是历史累积的结果，换分区只影响「以后衰减多快」。
 */
export function reclassify(idx, opts = {}) {
  let n = 0;
  for (const e of Object.values(idx.entities || {})) {
    const r = regionOf(e.t, e.n, opts);
    if (r !== e.r) {
      e.r = r;
      n++;
    }
  }
  return n;
}

/** 一条事件并入索引。同一个实体两次命中之间按半衰期衰减，然后 +1。 */
export function applyEvent(idx, rec, repo, now, opts = {}) {
  const ents = entitiesOf(rec, repo, opts);
  if (!ents.length) return 0;
  const ts = String(rec.ts || new Date(now).toISOString());
  const t = Date.parse(ts) || now;

  for (const e of ents) {
    const id = `${e.type}:${e.name}`;
    let n = idx.entities[id];
    if (!n) {
      n = idx.entities[id] = { t: e.type, n: e.name, r: regionOf(e.type, e.name, opts), c: 0, f: ts, l: ts, s: 0, x: [] };
    }
    const hl = REGIONS[n.r].halfLife;
    n.s = n.s * Math.exp(-lambdaOf(hl) * days(Date.parse(n.l), t)) + 1;
    n.c += 1;
    if (!n.f || ts < n.f) n.f = ts;
    if (!n.l || ts > n.l) n.l = ts;
    // 按天直方图：共活跃信号的原料。稀疏存，只记有事件的那几天。
    const day = ts.slice(0, 10);
    n.h = n.h || {};
    n.h[day] = (n.h[day] || 0) + 1;
    const ev = String(rec.evidence || "").replace(/\s+/g, " ").slice(0, 200);
    if (ev && n.x.length < 3 && !n.x.includes(ev)) n.x.push(ev);
  }

  const ids = [...new Set(ents.map((e) => `${e.type}:${e.name}`))].slice(0, 10);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) bumpEdge(idx, ids[i], ids[j], "co", t);
  }
  idx.seen += 1;
  return 1;
}

function bumpEdge(idx, a, b, kind, t) {
  if (a === b) return;
  const [s, t2] = a < b ? [a, b] : [b, a];
  const key = `${kind}|${s}|${t2}`;
  const e = idx.edges[key] || (idx.edges[key] = { s, t: t2, k: kind, w: 0, s2: 0, l: "" });
  const iso = new Date(t).toISOString();
  e.s2 = e.s2 * Math.exp(-lambdaOf(30) * days(Date.parse(e.l), t)) + 1;
  e.w += 1;
  e.l = iso;
}

/** 同 seq 的多行是一条链：补一层弱边。 */
export function applySeqLinks(idx, groups, now) {
  let n = 0;
  for (const g of groups) {
    if (g.length < 2) continue;
    const head = g[0].ids;
    for (let i = 1; i < g.length; i++) {
      for (const a of head.slice(0, 3)) for (const b of g[i].ids.slice(0, 3)) {
        bumpEdge(idx, a, b, "seq", g[i].t || now);
        n++;
      }
    }
  }
  return n;
}

/**
 * 修剪：这是"不无限增长"的真正实现。
 * 判据不是年龄，是**强度**——忘了就删，记着的留下。上限只是最后一道保险。
 */
export function prune(idx, now) {
  const ents = Object.entries(idx.entities);
  let dropped = 0;
  for (const [id, n] of ents) {
    const s = decayTo(n.s, n.l, REGIONS[n.r].halfLife, now);
    const age = days(Date.parse(n.l), now);
    if (s < FORGET_STRENGTH && age > 365) {
      delete idx.entities[id];
      dropped++;
    }
  }
  // 直方图只留最近 180 天：它表达的是"最近一起活跃过"，太老的没有信息量，只会让索引膨胀
  const cutoff = new Date(now - 180 * DAY).toISOString().slice(0, 10);
  for (const n of Object.values(idx.entities)) {
    if (!n.h) continue;
    for (const d of Object.keys(n.h)) if (d < cutoff) delete n.h[d];
  }
  const kept = Object.entries(idx.entities);
  if (kept.length > MAX_ENTITIES) {
    kept.sort((a, b) => decayTo(b[1].s, b[1].l, REGIONS[b[1].r].halfLife, now) - decayTo(a[1].s, a[1].l, REGIONS[a[1].r].halfLife, now));
    for (const [id] of kept.slice(MAX_ENTITIES)) {
      delete idx.entities[id];
      dropped++;
    }
  }
  for (const [key, e] of Object.entries(idx.edges)) {
    if (!idx.entities[e.s] || !idx.entities[e.t]) delete idx.edges[key];
    else if (e.s2 < 0.5) delete idx.edges[key];
  }
  const edges = Object.entries(idx.edges);
  if (edges.length > MAX_EDGES) {
    edges.sort((a, b) => b[1].s2 - a[1].s2);
    for (const [key] of edges.slice(MAX_EDGES)) delete idx.edges[key];
  }
  return dropped;
}

/* ── 源文件游标 ─────────────────────────────────────────────── */
/** 活日志 + `archive/` 下的全部历史。轮转不该等于失忆——归档只是底稿，索引才是记忆。 */
export function listSources(logPath) {
  const dir = join(dirname(logPath), "archive");
  const out = [{ path: logPath, archive: false }];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      if (!f.startsWith(basename(logPath))) continue;
      const p = join(dir, f);
      try {
        if (statSync(p).isFile()) out.push({ path: p, archive: true });
      } catch {}
    }
  }
  return out;
}

/** 从游标处读新增行。文件变短（被轮转/截断）则从头读。 */
export function readNewLines(path, cursor) {
  if (!existsSync(path)) return { lines: [], cursor };
  const size = statSync(path).size;
  const from = cursor && size >= cursor ? cursor : 0;
  const buf = readFileSync(path);
  const text = buf.subarray(from).toString("utf8");
  return { lines: text.split("\n").filter(Boolean), cursor: size };
}

export function saveIndex(path, idx, now) {
  idx.updatedAt = new Date(now).toISOString();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(idx));
}

/* ── 出图 ───────────────────────────────────────────────────── */
/**
 * 出图：节点 + 事实边 + 推断边 + 知识簇。
 *
 * 事实边的强度**不再用原始计数**，改用 PMI。原因：reset-fired 出现 3220 次，
 * 它跟谁共现 50 次都不稀奇——原始计数会把这种"因为太常见"读成"强相关"，
 * 于是满屏都是枢纽拉出来的白线。PMI 减去偶然，只留"超出预期"的那部分。
 */
export function snapshot(idx, now, maxNodes = 3000, maxEdges = 12000, maxInf = 800) {
  const rows = Object.entries(idx.entities).map(([id, n]) => {
    const hl = REGIONS[n.r].halfLife;
    return { id, ...n, sNow: decayTo(n.s, n.l, hl, now) };
  });
  rows.sort((a, b) => b.sNow - a.sNow);
  const kept = rows.slice(0, maxNodes);
  const idxOf = new Map();
  const nodes = kept.map((n, i) => {
    idxOf.set(n.id, i);
    return {
      i, id: n.id, type: n.t, name: n.n, r: n.r, c: n.c,
      s: +n.sNow.toFixed(3), f: n.f, l: n.l, ev: n.x, h: n.h,
    };
  });

  const edges = [];
  for (const e of Object.values(idx.edges)) {
    const s = idxOf.get(e.s);
    const t = idxOf.get(e.t);
    if (s === undefined || t === undefined) continue;
    const raw = pmi(e.w, kept[s].c, kept[t].c, idx.seen);
    // w=1 的单次撞见，PMI 会虚高（小样本），乘个 1/3 折价
    edges.push({ s, t, w: e.w, k: e.k, v: +(raw * Math.min(1, e.w / 3)).toFixed(2) });
  }
  edges.sort((a, b) => b.v - a.v);
  const keptEdges = edges.slice(0, maxEdges);
  const inferred = inferRelations(nodes, keptEdges, { maxInf });
  const all = keptEdges.concat(inferred);

  // 分簇只用**事实边**：簇应当反映真实结构，而不是我自己推断出来的结构。
  // 把 800 条推断边也喂进去，等于拿猜测去证明猜测。
  const clusters = detectClusters(nodes, keptEdges);
  const summary = [];
  clusters.forEach((c, ci) => {
    for (const m of c.members) nodes[m].cl = ci;
    // 注意 i 用的是**原始下标**：summary 是过滤后的前 12 个，若用过滤后的序号，
    // 界面按 cl 去找簇名会全部错位。
    if (c.members.length >= 3 && summary.length < 12) summary.push({ i: ci, name: c.name, size: c.members.length });
  });

  return {
    nodes,
    edges: all,
    total: rows.length,
    totalEdges: Object.keys(idx.edges).length,
    inferred: inferred.length,
    clusters: summary,
  };
}
