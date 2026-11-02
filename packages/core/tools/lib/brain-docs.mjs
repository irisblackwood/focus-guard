/**
 * 文档 → 记忆块（tools/lib/brain-docs.mjs，2026-11-02）——零依赖，纯函数。
 *
 * 用户一问：「真正的文件内容记忆呢？某某工具怎么执行，某某函数调用？踩过的坑，
 * 人格画像呢，use.md 培养呢，这样怎么训练情感」
 *
 * 这一问问在脑的短板上：**它以前只读 AUDIT.log**。于是它认识「docs/RULES.md 被提到 85 次」，
 * 却不知道那 85 次说的是什么——甚至不知道 `docs/RULES.md` 这个路径根本不存在
 * （真实位置是 `packages/core/docs/RULES.md`）。**记名字，所以记错了也不知道。**
 *
 * 三条判据，各自对应用户后来的一句批评：
 *   ① **权重**（「没有权重吗？」）——不拍脑袋，优先读条目里人标的 `imp`，读不到才用类别默认值。
 *   ② **关联**（「还有关联算法」）——记忆里提到的文件/条号，连到对应实体上。这是事实边：
 *      这一段确实写了这个路径，不是"两者都出现过所以大概有关"。
 *   ③ **文本**（「文本格式」）——存进脑的必须是**能直接读的正文**，不是 markdown 原文。
 *      `- **第一条**` 的横杠星号是给渲染器的，`{origin:tool,imp:9}` 该单独成行。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hash32, linkEdge, objectsIn } from "./brain-core.mjs";

/* 顺序即优先级：越靠前的越"硬"，出图时越大越亮。
   region 沿用脑的分区语义：法条进脑干（永不遗忘）、坑进左脑（判据）、
   方法进小脑（程序性记忆）、偏好与事实进右脑（叙事）。
   defaultW 只在条目里**没有** `imp` 时兜底——有真值就别用猜测值。 */
export const DOC_SOURCES = [
  { path: "packages/core/docs/RULES.md", kind: "rule", label: "法条", region: "stem", defaultW: 8, start: /^- \*\*第/ },
  { path: "self-improvement/memory/lessons.md", kind: "lesson", label: "坑", region: "left", defaultW: 6, start: /^- \[/ },
  { path: "self-improvement/memory/methods.md", kind: "method", label: "方法", region: "cerebellum", defaultW: 6, start: /^- \[/ },
  { path: "self-improvement/memory/facts.md", kind: "persona", label: "偏好", region: "right", defaultW: 6, start: /^- \[/ },
  { path: ".ai/notes/USER-prefs-draft.md", kind: "persona", label: "偏好", region: "right", defaultW: 7, start: /^§ / },
  { path: "CHANGELOG.md", kind: "lesson", label: "坑", region: "left", defaultW: 3, start: /^- (fix|feat)[(:]/ },
];

const MAX_TEXT = 600;

/** 条目尾部的 `{origin:tool,src:user,imp:9,ttl:180,vfy:2026-…}` —— 值里有冒号，按逗号切。 */
function metaOf(text) {
  const m = /\{([^}]*)\}/.exec(text);
  if (!m) return null;
  const out = {};
  for (const kv of m[1].matchAll(/([A-Za-z_]+):([^,]+)/g)) out[kv[1]] = kv[2].trim();
  return Object.keys(out).length ? out : null;
}

/** 一行标题：够长能认出来，够短能画在卡片上。 */
function titleOf(kind, block) {
  const first = block[0].trim();
  let s;
  if (kind === "rule") {
    const m = /^- \*\*(第[^*]+)\*\*\s*(.*)$/.exec(first);
    s = m ? `${m[1]} ${m[2]}` : first;
  } else if (kind === "persona" && first.startsWith("§")) {
    s = first.replace(/^§\s*/, "");
  } else if (/^- (fix|feat)/.test(first)) {
    // `- fix(tool): 半轴退回解剖值〔开发期〕` → `半轴退回解剖值`
    s = first.replace(/^- (fix|feat)(\([^)]*\))?:\s*/, "").replace(/〔[^〕]*〕\s*$/, "");
  } else {
    // `- [2026-10-27T20:13:56+08:00] (lesson) 正文…… {origin:tool,...}`
    s = first.replace(/^-\s*\[[^\]]*\]\s*(\([^)]*\)\s*)?/, "").replace(/\{[^}]*\}\s*$/, "");
  }
  s = s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  // 标题在第一个句末标点处断开，后面留给正文
  const cut = s.search(/[。；;]/);
  if (cut > 8) s = s.slice(0, cut);
  return s.length > 56 ? `${s.slice(0, 55)}…` : s;
}

/**
 * 正文：抹掉 markdown 与元数据，只留能直接读的话。
 *
 * 用户说的是「文本格式」，实质是：**卡片上不该出现给人眼看的源码**。
 * 子项的 `  - ` 换成 `· `——竖排里比横杠好认。
 */
function bodyOf(kind, block) {
  const lines = block.map((l) => l.replace(/\*\*/g, "").replace(/\{[^}]*\}\s*$/, "").trimEnd());
  const head = lines[0].trim();
  if (kind === "rule") {
    lines[0] = head.replace(/^- (第\S+?条)\s*/, "");
  } else if (kind === "persona" && head.startsWith("§")) {
    lines[0] = head.replace(/^§\s*/, "");
  } else if (/^- (fix|feat)/.test(head)) {
    lines[0] = head.replace(/^- (fix|feat)(\([^)]*\))?:\s*/, "").replace(/〔[^〕]*〕\s*$/, "");
  } else {
    lines[0] = head.replace(/^-\s*\[[^\]]*\]\s*(\([^)]*\)\s*)?/, "");
  }
  for (let i = 1; i < lines.length; i++) lines[i] = lines[i].replace(/^\s*-\s+/, "· ");
  return lines.filter((l, i) => i === 0 || l.trim()).join("\n").trim().slice(0, MAX_TEXT);
}

/** 时间戳：能拿到就用，拿不到用文件 mtime——"最近改过的记忆更亮"这条判据靠它。 */
function tsOf(block, mtime) {
  const m = /\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/.exec(block[0]);
  if (m) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return mtime;
}

/**
 * 读全部文档源 → 记忆块。
 * 文件不存在就跳过（`docs/RULES.md` 那种搬家的事真的发生过），不报错、不编内容。
 */
export function readDocs(repo, sources = DOC_SOURCES, stats = {}, pkg = "") {
  const blocks = [];
  stats.stale = 0;
  /* 实际读到的文档，不是配置里有几份。
     `self-improvement/` 与 `.ai/` 是私有面，别人 clone 下来根本没有——
     输出若照 `DOC_SOURCES.length` 写"来自 6 份文档"，就是在撒谎：
     干净副本里只有 RULES.md 和 CHANGELOG 两份，另外四份不存在。 */
  stats.found = [];
  stats.missing = [];
  for (const src of sources) {
    /* 同一条记忆源，在仓库里和在 npm 包里**不在同一个位置**：
       仓库里是 `packages/core/docs/RULES.md`，装进 node_modules 之后是
       `focus-guard/docs/RULES.md`。只认仓库位置，下载的人就永远是 0 条——
       那不是"从 0 开始"，那是"根本长不出来"。所以两个基都试。 */
    const cands = [join(repo, src.path)];
    if (pkg) cands.push(join(pkg, src.path.replace(/^packages\/core\//, "")));
    const full = cands.find((c) => existsSync(c));
    if (!full) { stats.missing.push(src.path); continue; }
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const mtime = statSync(full).mtime.toISOString();
    stats.found.push(src.path);
    const lines = text.split("\n");
    // CHANGELOG 的条目要带上所属版本：同一句话在两个版本里出现时，它们是两件事
    let version = "";
    for (let i = 0; i < lines.length; i++) {
      const v = /^##\s+(\S+)/.exec(lines[i]);
      if (v) version = v[1];
      if (!src.start.test(lines[i])) continue;
      const chunk = [lines[i]];
      for (let j = i + 1; j < lines.length; j++) {
        if (src.start.test(lines[j]) || /^##\s/.test(lines[j])) break;
        chunk.push(lines[j]);
      }
      const title = titleOf(src.kind, chunk);
      if (!title) continue;
      const raw = chunk.join("\n");
      /* 作废的条目不画。`facts.md` 里有条目尾部挂着第二个花括号
         `{invalid:2026-10-19T…,origin:panel}`——那是被后续批示推翻的旧口径。
         把它当记忆读出来，就是把"已经改掉的规矩"当成现行规矩。
         **必须认带 ISO 时间戳的结构，不能只认 `invalid:` 这个词**：
         CHANGELOG 里有一句在讲这件事，正文写着 `{invalid:…}`，
         按词匹配会把那条说明自己也当成作废条目跳掉——判据把它的描述吃掉了。 */
      if (/\{invalid:\d{4}-\d{2}-\d{2}T/.test(raw)) { stats.stale++; continue; }
      const meta = metaOf(raw);
      const imp = meta && Number(meta.imp);
      blocks.push({
        id: `mem:${src.kind}:${hash32(`${title}|${src.path}|${version}`).toString(36)}`,
        kind: src.kind,
        label: src.label,
        title,
        /* 在**本文档里**的序号。目录面板要按文档顺序排——法条按条号、
           CHANGELOG 按版本先后。不存这个就只能按标题字符串排，
           于是「第八十八条」会跑到「第八十二条」前面。 */
        ord: blocks.length,
        text: bodyOf(src.kind, chunk),
        src: src.path,
        ts: tsOf(chunk, mtime),
        region: src.region,
        // 人标的 imp 优先；没有才退回类别默认值。**权重不该由我拍脑袋定。**
        weight: Number.isFinite(imp) && imp > 0 ? imp : src.defaultW,
        meta,
        // 这一段提到了谁：用来连事实边（"这条记忆里确实写了这个路径"）。
        objects: objectsIn(raw, repo),
      });
    }
  }
  return blocks;
}

/* 共享一个冷门对象时，最多连几对。
   一个文件被 20 块提到，两两相连就是 190 条边——那不是"关联"，是把它们焊成一坨。
   取前 4 块连满 6 对：够表达"这四块在说同一件事"，不至于把图糊死。 */
const SHARE_MAX = 4;

/** 这一块自己的身份键：法条用条号，其余用来源路径。 */
function selfKeyOf(b) {
  if (b.kind === "rule") {
    const m = /^(第\S+?条)/.exec(b.title);
    if (m) return `rule:${m[1]}`;
  }
  return null;
}

/**
 * 把记忆块同步进索引。
 *
 * **每次全量重读、先删后建**，不做增量。理由：文档会被改、会被删、会搬家——
 * 增量同步留下的幽灵实体，恰恰是"记名字不记内容"的翻版。
 * 量也小（几百块），全量重读的代价可以忽略。
 *
 * ── 关联算法（2026-11-02 重做）────────────────────────────────
 * 上一版只连「记忆 → 日志实体」。实跑结果：356 块里只有 41 块连上了边，
 * 423 次对象提及落空——304 次是日志从没碰过的文件路径，119 次是各条**自己的条号**。
 * 结论：**拿日志当记忆之间的中介是错的**。日志记的是"我碰过什么"，
 * 而两条法条之间的关系、两个坑之间的关系，本来就不经过日志。
 *
 * 现在分三类边，各连各的：
 *   trace —— 记忆 ↔ 日志实体。是**锚点**，不是主干：说明"这条记忆在现实里被碰到过"。
 *   ref   —— 记忆 ↔ 记忆。提到同一条法条、同一个文件，就是同一件事的两面。
 *            这才是主干。自指（第43条 提到 第43条）不算，那是它的名字。
 *   share —— 记忆 ↔ 记忆，共享一个**冷门**对象（只被少数几块提到）。
 *            热门对象（如 RULES.md 被 88 块提到）连边等于没连。
 */
export function syncDocs(idx, repo, sources = DOC_SOURCES, pkg = "") {
  let removed = 0;
  for (const [id, n] of Object.entries(idx.entities || {})) {
    if (n.t !== "memory") continue;
    delete idx.entities[id];
    removed++;
  }
  // 记忆相关的边一起清：文档改了，旧关系就不成立了。
  for (const [key, e] of Object.entries(idx.edges || {})) {
    if (e.k === "ref" || e.k === "trace" || e.k === "share" || !idx.entities[e.s] || !idx.entities[e.t]) {
      delete idx.edges[key];
    }
  }

  const stats = {};
  const blocks = readDocs(repo, sources, stats, pkg);

  // ── 第一趟：全部落地。必须先建完再连边，否则 A 引用 B 时 B 可能还没进来。
  const selfKey = new Map();      // "rule:第43条" → 块 id
  const byObject = new Map();     // "file:src/a.mjs" → [块 id]
  for (const b of blocks) {
    idx.entities[b.id] = {
      t: "memory", n: b.title, r: b.region, c: 1,
      f: b.ts, l: b.ts, s: b.weight, x: [b.text],
      k: b.kind, src: b.src, mt: b.meta, ord: b.ord,
    };
    const sk = selfKeyOf(b);
    if (sk && !selfKey.has(sk)) selfKey.set(sk, b.id);
    for (const o of b.objects) {
      const oid = `${o.type}:${o.name}`;
      /* 自己的条号不进倒排表。进了的话，「第三条 照第一条办理」会让 `rule:第一条`
         的桶里同时有 [第一条块, 第三条块]，于是同一对既有一条 ref 又有一条 share——
         一条关系画两遍，边数虚高，图上还看不出是同一个意思。 */
      if (oid === sk) continue;
      let arr = byObject.get(oid);
      if (!arr) byObject.set(oid, (arr = []));
      if (!arr.includes(b.id)) arr.push(b.id);
    }
  }

  // ── 第二趟：连边。记忆只锚定事实对象（文件/条号/记忆块），不连行动记录（2026-11-02 批示）
  const TRACE_DENY = new Set(["action", "trigger", "tool"]);
  let trace = 0, ref = 0, share = 0, orphan = 0;
  for (const b of blocks) {
    const t = Date.parse(b.ts) || Date.now();
    const mine = selfKeyOf(b);
    for (const o of b.objects) {
      const oid = `${o.type}:${o.name}`;
      // 自指：一块法条提到自己的条号，那是它的名字，不是关系。
      if (oid === mine) continue;
      const hit = idx.entities[oid];
      if (hit) { if (!TRACE_DENY.has(hit.t)) { linkEdge(idx, b.id, oid, "trace", t); trace++; } continue; }
      const other = selfKey.get(oid);
      if (other && other !== b.id) { linkEdge(idx, b.id, other, "ref", t); ref++; continue; }
      orphan++;
    }
  }

  /* 共享冷门对象 → 连边。只对**恰好 2..SHARE_MAX 块**提到的对象做：
     1 块提到没有对偶，20 块提到则是公共设施（每条都连等于每条都不连）。 */
  for (const [, ids] of byObject) {
    if (ids.length < 2 || ids.length > SHARE_MAX) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = idx.entities[ids[i]];
        linkEdge(idx, ids[i], ids[j], "share", Date.parse(a && a.f) || Date.now());
        share++;
      }
    }
  }

  return {
    blocks: blocks.length, removed, trace, ref, share, orphan, stale: stats.stale || 0,
    linked: trace + ref + share,
    // 实到几份、缺几份。干净副本里 self-improvement/ 与 .ai/ 是不存在的，
    // 这两个数就是"别人下载到的是什么"的直接读数。
    sources: (stats.found || []).length,
    missing: stats.missing || [],
  };
}
