/**
 * 脑的分区与筛选（tools/lib/brain-regions.mjs，2026-11-02）——零依赖，纯函数。
 *
 * 为什么单独一个文件：`brain-core` 管「记什么」（实体、强度、衰减、索引），
 * 这里管「这东西算哪一类」。判据每改一次就要重算全部分区，它有自己的演化节奏——
 * 混在一起，改一行词表都要翻四百行衰减逻辑。
 *
 * 判据的演化史（对着 258 个实体逐个核对出来的，不是想出来的）：
 *   ① 最早是三组硬正则按顺序 if：路径里有 `src/` 才算代码。
 *      → `cleanup.mjs`（228 次，最大的文件实体）落在右脑，因为它在根目录。
 *   ② 加上扩展名判据：`.mjs` 就是代码，放哪儿都是。
 *   ③ `trigger` 类型此前没有分区分支，22 个全落右脑——`high-risk-rm` 出现 1,729 次，
 *      被当成「叙事」按 30 天半衰期遗忘。触发器是**判据的实例**，不是故事。
 *   ④ 词表外置 + 打分 + 认不出来就报出来（`--unknown`）。
 *
 * 一条硬约束：**分区必须稳定**。位置 = hash → 分区顶点池，分区一变位置就跳，
 * 图就变成烟花。所以自动学习只配「提议」，落地必须写进配置，由人拍板。
 */

import { existsSync, readFileSync } from "node:fs";

export const REGIONS = {
  stem: { label: "脑干", halfLife: Infinity, note: "硬约束，永不遗忘" },
  cerebellum: { label: "小脑", halfLife: 180, note: "程序记忆，半年" },
  left: { label: "大脑·左", halfLife: 60, note: "判据与代码，两个月" },
  right: { label: "大脑·右", halfLife: 30, note: "叙事与文档，一个月" },
};

/* ── 分区：从「关键词 if 链」改成「先验词表 + 打分 + 可覆盖」 ────────────
 *
 * 旧版是三组硬正则按顺序 if。实测它错在哪（对着 258 个实体逐个核对）：
 *   `cleanup.mjs`（228 次，最大的文件实体）落在右脑——判据是「路径里有 src/」，
 *     而根目录的 .mjs 也是代码。**代码的判据是扩展名，不是路径形状。**
 *   `trigger` 类型根本没有分区分支，22 个全落右脑——`high-risk-rm` 出现 1,729 次，
 *     被当成「叙事」按 30 天半衰期遗忘。触发器是**判据的实例**，不是故事。
 *   `grants-swept` 没命中 `sweep`（屈折变化），掉进兜底。
 *   新词（`deny-shuanggui`、`inv-pool-exceeded`）只能靠改代码。
 *
 * 现在：词表是**数据**（`brain-config.json` 可覆盖），命中算分取最高，
 * 同分按硬度（stem > cerebellum）。没命中**不猜**——标 fallback 并由 `--unknown` 报出来，
 * 等人补词表。这才是"灵活"的正确含义：不假装认识，而是把不认识的东西列出来。
 */
export const DEFAULT_LEXICON = {
  // 硬约束：拦、拒、熔断、红线、授权。这些是"生命维持"，永不遗忘。
  stem: [
    "deny", "reject", "refuse", "forbid", "ban", "veto", "block", "fuse", "redline",
    "high-risk", "violation", "usurp", "bypass", "stall", "pardon", "gate", "risky",
    "grant", "preauth", "cleared", "declared", "destructive",
    "rm-rf", "drop-database",
  ],
  // 机械动作：每会话/每回合都会发生的程序性动作，属"肌肉记忆"。
  cerebellum: [
    "fired", "check", "kpi", "budget", "audit", "start", "startup", "reset", "register",
    "pre-push", "version", "handover", "session", "sweep", "swept", "record", "run", "exec",
    "write", "read", "edit", "bash", "grep", "glob", "scan", "probe", "tag", "drop",
    "list", "inherit", "watch", "compaction", "pool", "exceeded", "delegate", "spawn",
    "settle", "extend", "purge", "gap", "slim", "bump", "backfill", "cli", "dump",
    "end", "lines", "casefile",
  ],
};

/** 代码靠扩展名认，不靠目录。`.mjs` 就是代码，放在哪儿都是。 */
const CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|py|sh|ps1|bat|go|rs|java|rb|php|lua|vue|svelte|html|css)$/i;
const CODE_DIR = /(^|\/)(src|tools|hooks|tests|lib)\//;
/** 配置/清单：不是叙事，也不是判据逻辑——它是"这东西怎么跑"的程序性记忆。 */
const CONFIG_EXT = /\.(json|json5|ya?ml|toml|ini)$/i;
const DOC_EXT = /\.(md|mdx|txt|rst|adoc)$/i;
const DOC_DIR = /(^|\/)(docs|skills)\/|(^|\/)(README|CHANGELOG|HANDOFF|CONTRIBUTING|LICENSE)/i;

const tokensOf = (name) => String(name).toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean);

/**
 * 给一个实体定分区，并**说明理由**。纯函数：同样的输入永远同样的输出。
 * 理由码：rule（人工规则）/ type（类型即结构）/ ext / path / lexicon / fallback。
 */
export function classify(type, name, opts = {}) {
  const raw = String(name || "");
  const low = raw.toLowerCase();

  // 0 人工规则最优先。写在 brain-config.json 的 rules 里，按顺序第一条命中即生效。
  for (const r of opts.rules || []) {
    if (!r || !r.re) continue;
    const re = r.re instanceof RegExp ? r.re : new RegExp(r.re, "i");
    if (re.test(raw)) return { r: r.region, why: "rule" };
  }

  // 1 类型即结构：条号就是脑干，工具就是小脑——这两个不看词。
  if (type === "rule") return { r: "stem", why: "type" };
  if (type === "tool") return { r: "cerebellum", why: "type" };

  // 2 文件：先扩展名，再目录。
  if (type === "file") {
    if (CODE_EXT.test(raw)) return { r: "left", why: "ext" };
    if (CODE_DIR.test(raw)) return { r: "left", why: "path" };
    if (CONFIG_EXT.test(raw)) return { r: "cerebellum", why: "ext-config" };
    if (DOC_EXT.test(raw) || DOC_DIR.test(raw)) return { r: "right", why: "ext" };
    return { r: "right", why: "fallback" };
  }

  // 3 动作与触发器：打分。多词短语整名命中权重最高（`drop-database` 压过 `drop`）。
  const toks = tokensOf(raw);
  const lex = opts.lexicon || DEFAULT_LEXICON;
  const ORDER = ["stem", "cerebellum", "left", "right"];
  const sc = Object.fromEntries(ORDER.map((r) => [r, 0]));
  for (const [region, words] of Object.entries(lex)) {
    if (!(region in sc)) continue; // 词表里写了未知分区名就当没写
    for (const w of words || []) {
      const wl = String(w).toLowerCase();
      if (wl.includes("-") || wl.includes(":")) {
        if (low.includes(wl)) sc[region] += 6;
        continue;
      }
      for (const t of toks) {
        if (t === wl) { sc[region] += 4; break; }
        // 屈折变化：denied→deny、running→run。前缀互相包含即算命中，权重减半。
        if (wl.length >= 3 && t.length >= 3 && (t.startsWith(wl) || wl.startsWith(t))) { sc[region] += 2; break; }
      }
    }
  }
  let best = null;
  for (const r of ORDER) if (sc[r] > (best ? sc[best] : 0)) best = r;
  if (best && sc[best] > 0) return { r: best, why: "lexicon", score: sc[best] };

  // 4 兜底。触发器是**判据的实例**，按左脑算（判据面）；动作没有词表依据时按右脑。
  if (type === "trigger") return { r: "left", why: "fallback-trigger" };
  return { r: "right", why: "fallback" };
}

export function regionOf(type, name, opts) {
  return classify(type, name, opts).r;
}

/**
 * 读可选配置 `.focus-guard/brain-config.json`。不存在就是默认值——零配置可用。
 * 合并策略：lexicon 的数组**追加**（不替换，否则升级一次就把默认词表丢了），
 * rules 前置（人工永远压过机器）。
 */
export function loadConfig(file) {
  const base = { lexicon: { ...DEFAULT_LEXICON }, rules: [], noise: [] };
  if (!file || !existsSync(file)) return base;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    for (const [region, words] of Object.entries(raw.lexicon || {})) {
      if (!Array.isArray(words)) continue;
      base.lexicon[region] = [...new Set([...(base.lexicon[region] || []), ...words.map(String)])];
    }
    if (Array.isArray(raw.rules)) base.rules = raw.rules.filter((r) => r && r.re && r.region);
    if (Array.isArray(raw.noise)) base.noise = raw.noise.map(String);
    return base;
  } catch {
    return base; // 配置写坏了不该让整个脑打不开
  }
}

/**
 * 噪音路径：测试临时文件、运行时状态、日志本身。
 * 实测 437 个实体里 179 个是这些——半个脑是测试残留，那不是记忆，是垃圾。
 * 判据是"路径里带 temp/tmp 段"或"是本仓自己写的状态文件"，不是按文件名猜。
 */
const NOISE_RE = /(^|\/)tmp\/|temp\/|AppData\/Local\/Temp|focus-guard-(session|hermes|atomic-state)|\.tmp$/i;

/** 噪音判据：内置正则 + 配置追加的字符串。配置只做**追加**，关不掉内置的那几条。 */
export function isNoise(path, extra) {
  if (NOISE_RE.test(path)) return true;
  if (!extra || !extra.length) return false;
  const p = String(path).toLowerCase();
  return extra.some((s) => s && p.includes(String(s).toLowerCase()));
}

