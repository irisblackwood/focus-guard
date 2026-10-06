// FocusGuard Semantica 图谱导出桥 v3.0.4（bridges/ 衍生区 / 总纲 3.0.0 十五·二）
//
// 偷师 Semantica（图原生记忆层）：把执法档案因果链导出为 LPG 图谱 JSON（nodes/edges），
// 供 Semantica Knowledge Explorer 导入做因果追溯与可视化。
//
// 依赖的契约（bridges/README.md）：执法档案 AUDIT.log JSONL——
//   每条 {ts, session, seq, chain, ref, action, trigger, level, evidence, pardon}。
// 自包含：不 import 主分支源码；3.0.0 前旧格式记录（无 seq）按流水账对待并明示。
//
// 用法：node bridges/audit-chain-semantica.mjs <AUDIT.log> [--chain <链id>]

import { readFileSync, existsSync } from "node:fs";

function parse(argv) {
  const args = { file: "", chain: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--chain") args.chain = argv[++i];
    else args.file = argv[i];
  }
  if (!args.file || !existsSync(args.file)) {
    console.error("用法：node bridges/audit-chain-semantica.mjs <AUDIT.log> [--chain <链id>]");
    process.exit(1);
  }
  return args;
}

function load(file) {
  const recs = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r && r.action && r.seq) recs.push(r); // 契约记录：须有 seq（3.0.0+）
    } catch {} // 非 JSONL 行跳过
  }
  return recs;
}

// LPG 图谱：节点=执法事件（labels=[AuditEvent, action]），边=ref 引用（caused）+ 链间派生（spawned）
export function toGraph(recs, chainFilter) {
  const nodes = [];
  const edges = [];
  for (const r of recs) {
    if (chainFilter && r.chain !== chainFilter) continue;
    nodes.push({
      id: r.seq,
      labels: ["AuditEvent", r.action],
      props: {
        ts: r.ts,
        chain: r.chain || "",
        level: r.level ?? null,
        action: r.action,
        evidence: String(r.evidence || "").slice(0, 140),
        session: r.session,
      },
    });
    if (r.ref) edges.push({ src: r.ref, dst: r.seq, label: "caused", directed: true });
  }
  const chains = new Set(recs.filter((r) => !chainFilter).map((r) => r.chain || "(无链)"));
  for (const c of chains) {
    const m = String(c).match(/^(.+)\/d\d+$/);
    if (m && chains.has(m[1])) {
      const childFirst = recs.find((r) => r.chain === c);
      const parentFirst = recs.find((r) => r.chain === m[1]);
      if (childFirst && parentFirst) edges.push({ src: parentFirst.seq, dst: childFirst.seq, label: "spawned", directed: true });
    }
  }
  return { format: "lpg-v1", generator: "focus-guard audit-chain-semantica 3.0.4", node_count: nodes.length, edge_count: edges.length, nodes, edges };
}

const args = parse(process.argv.slice(2));
const recs = load(args.file);
if (!recs.length) {
  console.log("本 AUDIT.log 无因果链记录（3.0.0 前格式缺 seq/chain/ref），流水账原文即全部信息。");
  process.exit(0);
}
console.log(JSON.stringify(toGraph(recs, args.chain), null, 2));
