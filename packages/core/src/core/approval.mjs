// FocusGuard 母版层 · 高危审批状态机（v3.0.5；《资料与代码分层总规范》二·1）
// 待批队列、批量出示、批示消费与目标绑定、阶梯提示。
import {
  readFileSync, writeFileSync, rmSync, statSync, appendFileSync,
  mkdirSync, existsSync, renameSync, realpathSync, readdirSync, copyFileSync,
} from "node:fs";
import { join, dirname, sep, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { HIGH_RISK_QUEUE_MAX } from "./constants.mjs";

export function pushHighRiskPending(state, key, cmdBrief) {
  if (!key) return;
  state.highRiskQueue = state.highRiskQueue || [];
  if (state.highRiskQueue.some((x) => x.k === key)) return;
  if (state.highRiskQueue.length >= HIGH_RISK_QUEUE_MAX) return;
  state.highRiskQueue.push({ k: key, c: String(cmdBrief || "").slice(0, 80) });
}
// 待批队列注记：除当前命令外还有几条在队列里，提示可合并批示
export function queueNote(state, currentBrief) {
  const q = (state.highRiskQueue || []).filter((x) => x.c !== currentBrief);
  if (q.length < 1) return "";
  return `另有 ${q.length} 条待批已合并出示：${q.map((x) => x.c).join("；")}。回复 y 放行全部待批（各一次）、n 全部阻断。`;
}
// 授权消费（单条与批量统一）：命中即消费一次，且两槽同时清除——否则批量 y 放行的命令
// 会在单条槽消费后仍留在批量槽里，同一命令被无声放行两次（一次性语义被破坏）
export function consumeHighRisk(state, key) {
  // 3.0.5 目标绑定：批示 y 后该目标键本会话内持续有效——同目标重复触达不再重复弹单
  // （修"一次一 attempt 消费制"被程序性拒绝烧掉批准、同目标反复弹单之痛，《审 2 号》同源）。
  // 每次命中仍逐一记档 high-risk-executed；n 批示即解除绑定；键为全量哈希，命令变体不受豁免。
  if (state.highRiskApprovedKeys && state.highRiskApprovedKeys[key]) {
    // 绑定命中：同步清空单条槽，保持"绑定映射"为唯一授权事实源
    state.highRiskOk = false;
    state.highRiskCmd = "";
    state.highRiskKey = "";
    return "bound";
  }
  let hit = false;
  if (state.highRiskOk && state.highRiskKey === key) {
    state.highRiskOk = false;
    state.highRiskCmd = "";
    state.highRiskKey = "";
    hit = true;
  }
  const batch = state.highRiskBatch || [];
  const i = batch.indexOf(key);
  if (i >= 0) {
    batch.splice(i, 1);
    state.highRiskBatch = batch;
    hit = true;
  }
  return hit;
}

export function ladderNote(level) {
  if (level >= 6) return "L6：已上报人类。";
  if (level >= 5) return "L5：只读模式直至批示。";
  if (level >= 4) return "L4：已记档。";
  if (level >= 3) return "L3：等批示或降级方案。";
  if (level >= 2) return "L2：下一调用必须取证。";
  return "";
}

