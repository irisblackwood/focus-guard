/**
 * 关系引擎（tools/lib/brain-relate.mjs，2026-11-02）——零依赖，纯函数。
 *
 * 为什么单独一个文件：关系是**另一个物种**。`brain-core` 管"记什么"（实体、强度、衰减），
 * 这里管"谁跟谁有关"。混在一起，两边都说不清自己在算什么。
 *
 * 一条关系由四个信号合成，每个都能单独复算、单独解释：
 *
 *   ① 结构（AA）  score = Σ_{z∈N(A)∩N(B)} 1/ln(2+|N(z)|)
 *      共同邻居越多越强，但热门中间物权重被 ln 压掉。回答"它们被同一批东西串起来"。
 *
 *   ② 统计（PMI）  log2( P(A,B) / (P(A)·P(B)) ) = log2( w·N / (c_A·c_B) )
 *      回答"它们一起出现，是**超出偶然**的，还是因为都太常见"。这是给**事实边**用的：
 *      原始计数会让枢纽（reset-fired，3220 次）跟谁都"强相关"，PMI 把这种稀释掉。
 *
 *   ③ 亲缘（affinity）  共同路径前缀深度 / 最大深度
 *      回答"它们住在同一个目录里"。对文件是强信号，对动作是 0。
 *
 *   ④ 共活跃（temporal）  按天计数的直方图余弦
 *      回答"它们是不是同一段时间里在动"。两件从未同现、也不同目录的事，
 *      如果连续三周一起活跃，那就是有关系。
 *
 * 为什么不叠 embedding：闸门的记忆必须能复跑。上面四项你都能拿日志手算一遍，
 * 向量余弦不能。这不是保守，是**可审计性**——一条解释不了的关联，等于没有关联。
 */

const DAY = 86400e3;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** PMI：>0 才叫"超出偶然"。w=1 撞上一次、双方各 1000 次、总量 12000 → 0，正是想要的。 */
export function pmi(w, ca, cb, total) {
  if (!w || !ca || !cb || !total) return 0;
  return Math.max(0, Math.log2((w * total) / (ca * cb)));
}

/** 路径亲缘：共同前缀占较长路径的比例。同目录=高分，同仓不同层=中分，无交集=0。 */
export function affinity(a, b) {
  if (!a || !b || a.t !== "file" || b.t !== "file") return 0;
  const A = a.n.split("/");
  const B = b.n.split("/");
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) i++;
  return i / Math.max(A.length, B.length);
}

/** 共活跃：按天直方图的余弦。只比"形状"不比"数量"，所以热点文件和冷门文件也能比。 */
export function temporal(a, b) {
  const hx = a.h || {};
  const hy = b.h || {};
  let dot = 0;
  let ax = 0;
  let ay = 0;
  for (const d in hx) {
    const v = hx[d];
    ax += v * v;
    if (hy[d]) dot += v * hy[d];
  }
  for (const d in hy) ay += hy[d] * hy[d];
  if (!ax || !ay) return 0;
  return dot / Math.sqrt(ax * ay);
}

/** 邻接表（只走事实边里的 co）。 */
function adjacency(edges) {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const e of edges) {
    if (e.k !== "co") continue;
    add(e.s, e.t);
    add(e.t, e.s);
  }
  return adj;
}

/** Adamic-Adar 原始分（未归一）。 */
export function aaRaw(adj) {
  const score = new Map();
  for (const [, set] of adj) {
    const arr = [...set];
    if (arr.length < 2) continue;
    const w = 1 / Math.log(2 + arr.length);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = Math.min(arr[i], arr[j]);
        const b = Math.max(arr[i], arr[j]);
        const k = `${a}:${b}`;
        const cur = score.get(k) || { a, b, aa: 0, n: 0 };
        cur.aa += w;
        cur.n += 1;
        score.set(k, cur);
      }
    }
  }
  return score;
}

/**
 * 推断关系：四个信号加权，返回带**分项拆解**的边。
 * 拆解是重点——没有它，界面上一句"分 0.86"等于什么都没说。
 */
export function inferRelations(nodes, edges, opts = {}) {
  const { maxInf = 800, minAA = 2, weights = { aa: 1, aff: 0.8, tmp: 0.6 } } = opts;
  const adj = adjacency(edges);
  const raw = aaRaw(adj);
  const has = new Set(edges.map((e) => `${Math.min(e.s, e.t)}:${Math.max(e.s, e.t)}`));

  const cand = [];
  let maxAA = 0;
  for (const [k, v] of raw) {
    if (has.has(k) || v.n < minAA) continue;
    cand.push(v);
    if (v.aa > maxAA) maxAA = v.aa;
  }

  const out = [];
  for (const c of cand) {
    const A = nodes[c.a];
    const B = nodes[c.b];
    const aaN = maxAA ? c.aa / maxAA : 0;
    const aff = affinity(A, B);
    const tmp = temporal(A, B);
    const v = weights.aa * aaN + weights.aff * aff + weights.tmp * tmp;
    out.push({
      s: c.a,
      t: c.b,
      k: "inf",
      w: c.n,
      v: +v.toFixed(3),
      parts: { aa: +aaN.toFixed(2), aff: +aff.toFixed(2), tmp: +tmp.toFixed(2) },
    });
  }
  out.sort((p, q) => q.v - p.v);
  return out.slice(0, maxInf);
}

/**
 * 知识簇：模块度局部移动（Louvain 第一阶段）。
 *
 * 为什么不用标签传播：它在稠密图上**必然塌成一个簇**——实测 258 个节点、1210 条边，
 * 标签传播把 145 个成员塞进同一个簇，等于没分。原因很直白：标签只问"邻居里谁票多"，
 * 不问"这条边相对于随机基线有多重"。稠密图里最大簇的票永远最多，于是自我强化。
 *
 * 模块度增益问的是后者：
 *   ΔQ ∝ w(i→C) − k_i · Σtot_C / (2m)
 * 前项是"连向该簇的实际权重"，后项是"如果随机连，期望连过去多少"。
 * 一个节点只有当它跟某簇的连接**超出随机期望**时才搬过去，大簇因此不会无脑吞并。
 *
 * 确定性：固定遍历顺序，增益相等时取编号更小的簇——同一份数据每次跑出同一个分簇。
 * 这比多几个百分点的模块度重要：一个每次都变的簇，你没法拿它做判断。
 */
export function detectClusters(nodes, edges, iters = 20) {
  const n = nodes.length;
  const adj = Array.from({ length: n }, () => new Map());
  let m2 = 0;
  for (const e of edges) {
    if (e.s >= n || e.t >= n || e.s === e.t) continue;
    const wt = Math.max(0.01, e.v || 0.01);
    adj[e.s].set(e.t, (adj[e.s].get(e.t) || 0) + wt);
    adj[e.t].set(e.s, (adj[e.t].get(e.s) || 0) + wt);
    m2 += 2 * wt;
  }
  if (!m2) return [];
  const m = m2 / 2;

  const k = adj.map((a) => [...a.values()].reduce((s, x) => s + x, 0));
  const comm = Array.from({ length: n }, (_, i) => i);
  const tot = k.slice();

  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const ci = comm[i];
      if (!adj[i].size) continue;
      const wTo = new Map();
      for (const [j, w] of adj[i]) {
        const c = comm[j];
        wTo.set(c, (wTo.get(c) || 0) + w);
      }
      tot[ci] -= k[i];
      let bestC = ci;
      let bestGain = (wTo.get(ci) || 0) - (k[i] * tot[ci]) / m;
      for (const [c, w] of wTo) {
        const gain = w - (k[i] * tot[c]) / m;
        if (gain > bestGain + 1e-9 || (Math.abs(gain - bestGain) < 1e-9 && c < bestC)) {
          bestGain = gain;
          bestC = c;
        }
      }
      tot[bestC] += k[i];
      if (bestC !== ci) {
        comm[i] = bestC;
        moved++;
      }
    }
    if (!moved) break;
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const l = comm[i];
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(i);
  }
  return [...groups.values()]
    .map((members) => ({ members, name: clusterName(nodes, members) }))
    .sort((a, b) => b.members.length - a.members.length);
}

/** 簇名 = 簇里**最强**的那个成员。
 *  用目录名当簇名是坏主意：实测三个簇都叫 `packages/core/tests`，读者分不出谁是谁。
 *  用代表成员命名，"deny 组""evidence-gate 组"一眼就知道这块在讲什么。 */
function clusterName(nodes, members) {
  let best = null;
  for (const i of members) {
    const node = nodes[i];
    if (!best || (node.s || 0) > (best.s || 0)) best = node;
  }
  if (!best) return "（空）";
  const short = best.name.split("/").pop();
  return short.length > 22 ? `${short.slice(0, 21)}…` : short;
}

/** 给每个节点打上簇号（-1 = 不属于任何簇），供详情卡与筛选使用。 */
export function labelNodes(nodes, clusters) {
  const out = new Array(nodes.length).fill(-1);
  clusters.forEach((c, idx) => {
    for (const i of c.members) out[i] = idx;
  });
  return out;
}

export { clamp01, DAY };
