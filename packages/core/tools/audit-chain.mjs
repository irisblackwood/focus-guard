// FocusGuard 因果链渲染器 v3.0.0（总纲 3.0.0 十五·二 / 偷师 Semantica：日志从流水账变因果图）
//
// AUDIT.log（JSONL）自 v3.0.0 起每条带 seq（事件唯一号）/ chain（任务链，子代理派生 /dN 子链）/
// ref（父事件 seq）。本工具把流水账按链重组为"决策→取证→动作→处置"因果树：
//
//   node tools/audit-chain.mjs <AUDIT.log> [--chain <链id>] [--mermaid] [--tail <n>]
//
// 文本树（默认）：按链分组，ref 用 ← 指回父事件；--mermaid 输出 Mermaid graph 供 Markdown 直接渲染。
// （Semantica LPG 图谱导出见 external-bridges 分支的 --semantica 扩展。）

import { readFileSync, existsSync } from "node:fs";

function parse(argv) {
  const args = { file: "", chain: "", mermaid: false, tail: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--chain") args.chain = argv[++i];
    else if (argv[i] === "--mermaid") args.mermaid = true;
    else if (argv[i] === "--tail") args.tail = parseInt(argv[++i], 10) || 0;
    else args.file = argv[i];
  }
  if (!args.file || !existsSync(args.file)) {
    console.error("用法：node tools/audit-chain.mjs <AUDIT.log> [--chain <链id>] [--mermaid] [--tail <n>]");
    process.exit(1);
  }
  return args;
}

function load(file, tail) {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const pick = tail > 0 ? lines.slice(-tail) : lines;
  const recs = [];
  for (const l of pick) {
    try {
      const r = JSON.parse(l);
      if (r && r.action) recs.push(r);
    } catch {} // 非 JSONL 行（旧格式或手工备注）跳过
  }
  return recs;
}

const short = (s, n = 60) => String(s || "").replace(/\s+/g, " ").slice(0, n);
const label = (r) => {
  const lvl = r.level ? ` L${r.level}` : "";
  return `${r.action}${lvl}｜${short(r.evidence)}`;
};

function textTree(recs, chainFilter) {
  const bySeq = new Map(recs.map((r) => [r.seq, r]));
  const children = new Map();
  for (const r of recs) {
    const k = r.chain || "(无链)";
    if (!children.has(k)) children.set(k, []);
    children.get(k).push(r);
  }
  const out = [];
  for (const [chain, rs] of children) {
    if (chainFilter && chain !== chainFilter) continue;
    out.push(`## 链 ${chain}（${rs.length} 事件）`);
    for (const r of rs) {
      const parent = r.ref && bySeq.get(r.ref) ? ` ← ${bySeq.get(r.ref).action}` : "";
      out.push(`  ${r.seq}  ${r.ts.slice(5, 19)}  ${label(r)}${parent}`);
    }
    out.push("");
  }
  return out.join("\n");
}

function mermaid(recs, chainFilter) {
  const ids = new Map();
  let n = 0;
  for (const r of recs) if (!chainFilter || r.chain === chainFilter) ids.set(r.seq, `E${++n}`);
  const lines = ["graph TD"];
  for (const [seq, id] of ids) {
    const r = recs.find((x) => x.seq === seq);
    lines.push(`  ${id}["${short(label(r), 46).replace(/"/g, "'")}"]`);
  }
  for (const r of recs) {
    if (chainFilter && r.chain !== chainFilter) continue;
    if (r.ref && ids.has(r.ref) && ids.has(r.seq)) {
      lines.push(`  ${ids.get(r.ref)} --> ${ids.get(r.seq)}`);
    }
  }
  // 链间的父子关系：子代理链首事件 ref 指向父链派单事件
  const chains = new Set(recs.filter((r) => !chainFilter).map((r) => r.chain || "(无链)"));
  for (const c of chains) {
    const m = String(c).match(/^(.+)\/d\d+$/);
    if (m && chains.has(m[1])) {
      const childFirst = recs.find((r) => r.chain === c);
      const parentFirst = recs.find((r) => r.chain === m[1]);
      if (childFirst && parentFirst && ids.has(childFirst.seq) && ids.has(parentFirst.seq)) {
        lines.push(`  ${ids.get(parentFirst.seq)} -.-> ${ids.get(childFirst.seq)}`);
      }
    }
  }
  return lines.join("\n");
}

const args = parse(process.argv.slice(2));
const recs = load(args.file, args.tail);
const modern = recs.filter((r) => r.seq);
if (!modern.length) {
  console.log("本 AUDIT.log 无因果链记录（3.0.0 前格式缺 seq/chain/ref），流水账原文即全部信息。");
  process.exit(0);
}
console.log(args.mermaid ? mermaid(modern, args.chain) : textTree(modern, args.chain));
