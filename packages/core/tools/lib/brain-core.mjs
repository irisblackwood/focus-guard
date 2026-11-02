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
 * 但"事件"不等于"知识"（2026-11-02 补）。审计日志里绝大多数行是**心跳**：预算重置、
 * 残留检查、KPI 结算，每回合一次，内容是几个计数器。旧版照单全收，于是 12,721 次提及里
 * 48% 是 `reset-fired` / `residue-check` 两个机械动作，真实文件（166 个，最高 228 次）
 * 全被压成暗雾。第一道闸：**没有对象的事件不进脑**（`entitiesOf`）。
 *
 * 第二道闸是**强度不按次数算**（`templateOf` / `applyEvent`）。用户第二次追问
 * 「3条 残留(已清理): fused readSet=21 / 第 35 次写操作全量审计，这种记得干嘛？
 * 难道是里程碑？」——不是里程碑，是同一句话的第 N 遍。这份日志 8,585 行只有 622 种
 * 不同的样子，所以「提及次数」量的是重复度，不是重要度。强度改成
 * **s = 种数 × √(种数/次数)**：每次都新 → 退回计数；翻来覆去一句 → 趋近 0。
 * 心跳留在 AUDIT.log 里，那本来就是它该待的地方。
 *
 * 遗忘曲线（Ebbinghaus 的指数衰减）：
 *   强度 s 在最后一次事件时刻算出，展示时衰减到"现在"：s_now = s · 2^(−(now−last)/半衰期)
 *   每次命中都刷新 last，所以"还在发生的东西"不会开始遗忘——它只是不再变大。

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

/* 「一行字怎么被读懂」那部分搬到 brain-text.mjs 了：对象抽取、内容模板、实体抽取。
   切分线是**改动的理由**——那边改是因为读法变了，这边改是因为索引怎么长变了。
   调用方不必知道它搬家：这里原样转出去，与上面 brain-regions 同一个处理。 */
import { MAX_TEMPLATES, entitiesOf, templateOf } from "./brain-text.mjs";
export { entitiesOf, hash32, normPath, objectsIn, templateOf } from "./brain-text.mjs";

/* ── 索引：加载 / 增量更新 / 落盘 ───────────────────────────── */
export const INDEX_VERSION = 5; // v4 只记有对象的事件；v5 强度改「种数×新意率」（旧索引里的 s 是次数，必须重算）
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
    // 记忆块的分区由**来源文档**决定（法条进脑干、方法进小脑），不是由标题文字猜。
    // 拿 classify 去跑「第43条 未经调查取证即改文件」这种长标题只会落到兜底。
    if (e.t === "memory") continue;
    const r = regionOf(e.t, e.n, opts);
    if (r !== e.r) {
      e.r = r;
      n++;
    }
  }
  return n;
}

/**
 * 一条事件并入索引。
 *
 * 强度 = **见过几种不同的样子** × 新意率，不是出现次数（2026-11-02 第三次改）。
 *
 * 前两版都错了，错法不同：
 *   ① 按事件数累加：`reset-fired` 3,220 次 → s=3,096。可它每回合都响一次，内容是计数器。
 *   ② 按天折叠：降到 16。用户仍然问「这种记得干嘛？难道是里程碑？」——他问得对，
 *      「活跃 16 天」和「很重要」不是一回事。
 * 真相是这份日志 8,585 行只有 622 种不同的样子。**提及次数量的不是重要度，是重复度。**
 *
 * 现在的判据：
 *   s = 种数 × √(种数 / 次数)
 *   每次都是新样子（种数=次数）→ s=种数，退回"计数"；翻来覆去同一句（种数=1）→ s≈0。
 *   中间连续过渡，没有阈值，也没有"多少次算例行"这种拍脑袋的线。
 *   实测：deny 36种/139次 → 18.3；第43条 3种/2940次 → 0.096；random-audit 1种/181次 → 0.074。
 *   **例行与真事差 100 倍**，不用另设过滤，它们自己就沉下去了。
 *
 * `c` 仍记原始次数（PMI 的分母要真实频次），`h` 仍记每天的真实次数（共活跃要真实形状）。
 */
export function applyEvent(idx, rec, repo, now, opts = {}) {
  const ents = entitiesOf(rec, repo, opts);
  if (!ents.length) return 0;
  const ts = String(rec.ts || new Date(now).toISOString());
  const t = Date.parse(ts) || now;
  const day = ts.slice(0, 10);
  const tp = templateOf(rec);

  for (const e of ents) {
    const id = `${e.type}:${e.name}`;
    let n = idx.entities[id];
    if (!n) {
      n = idx.entities[id] = { t: e.type, n: e.name, r: regionOf(e.type, e.name, opts), c: 0, f: ts, l: ts, s: 0, x: [] };
    }
    // 按天直方图：共活跃信号的原料。稀疏存，只记有事件的那几天。
    n.h = n.h || {};
    n.h[day] = (n.h[day] || 0) + 1;
    n.c += 1;
    // 只在新样子时扩表；重复只让分母变大，于是强度自己往下走。
    n.g = n.g || [];
    if (n.g.length < MAX_TEMPLATES && !n.g.includes(tp)) n.g.push(tp);
    n.s = n.g.length * Math.sqrt(n.g.length / n.c);
    if (!n.f || ts < n.f) n.f = ts;
    // 每次命中都刷新"最近出现"：它还在发生，就不该开始遗忘。
    if (!n.l || ts > n.l) n.l = ts;
    const ev = String(rec.evidence || "").replace(/\s+/g, " ").slice(0, 200);
    if (ev && n.x.length < 3 && !n.x.includes(ev)) n.x.push(ev);
  }

  const ids = [...new Set(ents.map((e) => `${e.type}:${e.name}`))].slice(0, 10);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) linkEdge(idx, ids[i], ids[j], "co", t);
  }
  idx.seen += 1;
  return 1;
}

/**
 * 连一条边。导出是因为记忆块也要连：一段内容里提到的文件/条号，是一条**事实边**
 * （这段确实写了这个路径），不是共现猜的"两者都出现过所以大概有关"。
 */
export function linkEdge(idx, a, b, kind, t) {
  if (a === b) return;
  const [s, t2] = a < b ? [a, b] : [b, a];
  const key = `${kind}|${s}|${t2}`;
  const e = idx.edges[key] || (idx.edges[key] = { s, t: t2, k: kind, w: 0, s2: 0, l: "" });
  const iso = new Date(t).toISOString();
  e.s2 = e.s2 * Math.exp(-lambdaOf(30) * days(Date.parse(e.l), t)) + 1;
  e.w += 1;
  e.l = iso;
}

/** 同 seq 的多行是一条链：**相邻行之间**连边，不是全挂到第一行（2026-11-02）。
 *  星形连接会把链头变成枢纽，且链尾之间的关系丢失；链式只连 i-1 ↔ i，形状就是"一条链"。 */
export function applySeqLinks(idx, groups, now) {
  let n = 0;
  for (const g of groups) {
    if (g.length < 2) continue;
    for (let i = 1; i < g.length; i++) {
      for (const b of g[i - 1].ids.slice(0, 3)) for (const c of g[i].ids.slice(0, 3)) {
        if (b === c) continue;
        linkEdge(idx, b, c, "seq", g[i].t || now);
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
    /* 记忆块不衰减。
       s 对足迹是「强度」——越久没提越淡，这是对的；
       对记忆块 s 是**人给的 imp**，是绝对刻度。一条法条不会因为写下三个月就不算数。
       实跑症状：右脑（半衰期 30d）的偏好块 imp 9 被衰减到 6.1，
       权重闸门落在 8 时整类消失——衰减曲线把"权重"偷换成了"新鲜度"。 */
    return { id, ...n, sNow: n.t === "memory" ? n.s : decayTo(n.s, n.l, hl, now) };
  });
  rows.sort((a, b) => b.sNow - a.sNow);
  const kept = rows.slice(0, maxNodes);
  const idxOf = new Map();
  const nodes = kept.map((n, i) => {
    idxOf.set(n.id, i);
    return {
      i, id: n.id, type: n.t, name: n.n, r: n.r, c: n.c,
      s: +n.sNow.toFixed(3), f: n.f, l: n.l, ev: n.x, h: n.h,
      // 种数要带出去：卡片上「出现 2,940 次」如果不说「其中只有 3 种样子」，
      // 读的人就会把它当成 2,940 次重要的事——这正是用户质疑的那个误读。
      g: n.g ? n.g.length : 0,
      // 记忆块的出处与类别。**字段名必须叫 kd 不能叫 k**：视图里 k 是强度归一值
      // （node.k = st），叫 k 会被 ...n 展开后覆盖，卡片上就会显示成一串小数。
      kd: n.k, src: n.src, ord: n.ord,
      // 权重是不是人标的。imp 是我拍的和领导批的，卡片上必须分得清——
      // 分不清就会出现「我猜的 8 分」冒充「用户定的 8 分」。
      im: n.mt && n.mt.imp ? Number(n.mt.imp) || null : null,
      by: n.mt && n.mt.src ? n.mt.src : null,
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
