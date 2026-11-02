/**
 * 文本 → 对象 / 模板（tools/lib/brain-text.mjs，2026-11-02）——零依赖，纯函数。
 *
 * 从 brain-core.mjs 里切出来的。切的原因不是"文件太长"好看不好看，是这里换了物种：
 * brain-core 管的是**索引怎么长**（事件 → 实体 → 强度 → 边 → 出图），
 * 这个文件管的是**一行字怎么被读懂**（哪些是文件、哪些是条号、哪部分是可变的）。
 * 两件事改动的理由完全不同，混在一个文件里，改一处要读另一处的上下文。
 *
 * 三个判据都在这：
 *   ① `objectsIn`——一段文本提到了哪些**对象**。日志用它判"这条是不是心跳"，
 *      记忆块用它判"这段内容提到了谁"。**判据只有这一份**，两处各写一份迟早漂移。
 *   ② `templateOf`——抹掉对象、数字、`key=value` 之后的样子。
 *      「提及次数」量的是重复度不是重要度，靠它把同一句话的 N 遍认出来。
 *   ③ `entitiesOf`——一条日志 → 实体。**没有对象就整条不记**（动词不是名词）。
 */

import { isNoise } from "./brain-regions.mjs";

/* ── 实体抽取 ───────────────────────────────────────────────── */
const PER_LINE_FILES = 6;
const PER_LINE_RULES = 2;
const FILE_RE =
  /(?:[A-Za-z]:)?[A-Za-z0-9_.\-/\\]*[A-Za-z0-9_\-]\.(?:mjs|js|cjs|json|md|log|html|yml|yaml|txt|py|sh|ps1|bat)\b/g;
const RULE_CN_RE = /第[一二三四五六七八九十百零〇\d]{1,6}条/g;
const RULE_NUM_RE = /(?:^|[^\d.])(\d{1,3})条/g;
const RULE_ANY_RE = /\d{1,3}条/g;
const SEC_RE = /§\s?[一二三四五六七八九十]{1,4}/g;

/* ── 内容模板：抹掉"什么变了"，只留"这是哪种事" ──────────────────────
 *
 * 用户原话：「3条 残留(已清理): fused readSet=21 / 第 35 次写操作全量审计
 *   这种记得干嘛？难道是里程碑？」
 * 不是里程碑，是**同一句话的第 N 遍**。实测这份日志 8,585 行只有 622 种不同的样子：
 *   residue-check 2,940 行 = 3 种；random-audit 181 行 = 1 种；handover-inspect 79 行 = 1 种。
 * 所以「提及次数」量的不是重要度，是**重复度**。真正的判据是「见过几种不同的样子」。
 *
 * 抹掉三样才算同一种样子：
 *   ① 对象（文件路径、条号、小节）——它们各自有实体，再数一遍是双重计数；
 *   ② 数字——`readSet=5` 和 `readSet=1` 是同一件事的两个读数；
 *   ③ `key=value` 整对——参数名不是内容。
 * 只存 32 位哈希，不存原文：索引里 227 个实体，存原文会白白胖几十 KB。
 */
export const MAX_TEMPLATES = 128;

export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function templateOf(rec) {
  let s = `${rec.evidence || ""} ${rec.command || ""}`;
  s = s.replace(FILE_RE, " ").replace(RULE_CN_RE, " ").replace(RULE_ANY_RE, " ").replace(SEC_RE, " ");
  s = s.replace(/\S*=\S*/g, " ").replace(/\d+/g, " ");
  return hash32(s.replace(/\s+/g, " ").trim().slice(0, 96));
}

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

/**
 * 一段文本里提到的**对象**：文件、条号、小节。
 *
 * 抽成单独函数，因为有两种调用方：日志要判"这条有没有对象"（没有就是心跳），
 * 记忆块要判"这段内容提到了谁"（用来连边）。**判据必须是同一份**——
 * 两处各写一份正则，迟早漂移成两个真相。
 */
export function objectsIn(text, repo, opts = {}) {
  const objs = [];
  const files = [];
  for (const m of text.matchAll(FILE_RE)) pushUnique(files, normPath(m[0], repo), PER_LINE_FILES);
  for (const f of files) if (f && f.includes(".") && !isNoise(f, opts.noise)) objs.push({ type: "file", name: f });
  const rules = [];
  for (const m of text.matchAll(RULE_CN_RE)) pushUnique(rules, m[0], PER_LINE_RULES);
  for (const m of text.matchAll(RULE_NUM_RE)) pushUnique(rules, `第${m[1]}条`, PER_LINE_RULES);
  for (const m of text.matchAll(SEC_RE)) pushUnique(rules, m[0].replace(/\s+/g, ""), PER_LINE_RULES);
  for (const r of rules) objs.push({ type: "rule", name: r });
  return objs;
}

/**
 * 一条日志 → 实体。**先找对象，没有对象就整条不记**。
 *
 * 为什么加这道闸（2026-11-02，用户问「为什么无聊的第 xx 次审计，也要记？」）：
 *   旧版把每条日志的 action / tool / trigger **无条件**建成实体。实测 12,721 次提及里，
 *   `reset-fired` 3,220 次、`residue-check` 2,940 次——两个机械动作占掉 48%。而它们的内容是
 *   `prompt:有 kw=10 budget=10 eff=0` 这种计数器：**同一件事在重复发生，不是新知识**。
 *   代价很具体：真实文件实体 166 个、最高只有 228 次（`cleanup.mjs`），全被压成暗雾。
 *   所以判据改成——**动词不是名词**。动作只有作用在某个具体对象（文件、条号、小节）上
 *   才值得记；不指认任何对象的动作只是一次脉搏，脉搏该留在 AUDIT.log 里，不该长进脑里。
 *
 *   这条闸同时也把 `第43条` 这类"被同一行反复带出来"的条号救回来：
 *   `residue-check` 每一行都写着 `43条 残留(已清理): turnCount=1`，于是第43条被数了 2,940 次，
 *   跟真实的判据引用（`第36条` 79 次）差了 37 倍。心跳没了，条号才回到真实量级。
 */
export function entitiesOf(rec, repo, opts = {}) {
  const text = `${rec.evidence || ""} ${rec.command || ""}`;
  // 先收对象：文件 → 条号 → 小节。这一段决定了这条日志"讲的是什么"。
  const objs = objectsIn(text, repo, opts);

  // 没有对象 = 心跳。整条不产生实体，连动作名也不建。
  if (!objs.length) return [];

  const out = [];
  if (rec.action) out.push({ type: "action", name: String(rec.action) });
  if (rec.tool) out.push({ type: "tool", name: String(rec.tool) });
  // 8,543 行里 action 与 trigger 同名的有 8,075 行（94.5%），同名再建节点只是影子
  if (rec.trigger && rec.trigger !== rec.action) out.push({ type: "trigger", name: String(rec.trigger) });
  return out.concat(objs);
}

