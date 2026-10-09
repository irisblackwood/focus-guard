// FocusGuard 母版层 · 事前资格审核（六层判定，规格 §三）
//
// 逻辑层是法官：自己判简单的（状态 / 红线 / 资格 / 前置），复杂的送模型（鉴定科）出信号，
// 最终 allow / deny / needApproval 一律由本层裁决。模型只出信号，不出裁决。
//
// 依赖注入：redlines / model / audit / grants / profile 全部由调用方传入 —— 母版不反向依赖适配层
// （《资料与代码分层总规范》二·1）。model 未注入时跳过第 5 层，故第一步零模型即可用。
// 审计一律走注入的 audit：本文件不直接写 AUDIT.log（测试注入 mock，不污染真实审计）。
//
// 3.0.5 增补（画像驱动）：
//   · 接收 profile；每层判定前查 layerEnabled(profile, 层键)，被画像禁用的层整体跳过，
//     并在 trace 里记 { decision:"skip", reason:"profile:xxx off" }；
//   · L1 按领导批复拆成两个子判据：1-fuse（stalledFuse，管 fused/probation）、
//     1-budget（budgetGate，管 taskBudget）；两者同用层号 "1"，全关才整层 skip；
//   · reasoningWatch / emotionFilter 系已登记未实现，只在 trace 追加 skip（附原因），不参与执行；
//   · **不传 profile 时行为与 3.0.4 完全一致**（全部层启用、不追加任何 skip 条目）。

import { isMutating } from "./risk.mjs";
import { createGrantTable } from "./grants.mjs";
import { layerEnabled, unimplementedSwitches } from "./profileLoader.mjs";
import { redlineExempt } from "./redlines.mjs";

/** 第 5 层语义风险的审批阈值（与 pipeline 的 RISK_ASK_THRESHOLD 同值）。 */
export const RISK_ASK_THRESHOLD = 0.85;

/** 第 4 层·系统路径：命中即 deny（配置与系统目录不属业务改动面）。 */
export const SYSTEM_PATH_RE =
  /(?:^|[\s"'=:,])(?:[A-Za-z]:[\\/]Windows(?:[\\/]|$)|[A-Za-z]:[\\/]Program Files(?:[\\/]|$)|\/etc(?:\/|$)|\/usr(?:\/|$)|\/bin(?:\/|$)|\/sbin(?:\/|$)|\/System(?:\/|$))/im;

/** 第 4 层·特殊目录：命中需人工审批（改之会污染版本库或依赖树）。 */
export const SPECIAL_DIR_RE = /(?:^|[\s"'=:,]|[\\/])(?:\.git|node_modules)(?:[\\/]|$)/i;

/** 第 3 层·高危工具/命令特征库。带 id，便于审计与测试定点。 */
export const HIGH_RISK_TOOLS = [
  { id: "rm-rf", re: /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*(?:r\w*f|f\w*r)\w*/ },
  { id: "format-volume", re: /\bFormat-Volume\b|\bmkfs\b|\bdiskpart\b|\bformat\s+[a-z]:/i },
  { id: "git-push-force", re: /\bgit\s+push\b[^\n]*\s(?:-f|--force(?:-with-lease)?)\b/i },
  { id: "drop-database", re: /\b(?:drop\s+(?:database|schema)|truncate\s+table)\b/i },
  { id: "publish", re: /\b(?:npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b/i },
  { id: "global-install", re: /\b(?:npm|pnpm)\s+(?:i|install|add)\b[^\n]*\s-g(?:\s|$)|\byarn\s+global\s+add\b/i },
  { id: "chmod-wide", re: /\bchmod\s+[^\n]*\b777\b|\bchmod\s+-R\b/i },
];

/**
 * 不可逆高危类别：用于 approvalGate.scope='irreversible' 时的审批范围判定。
 * 执行后无法回滚的才计入；publish / global-install / chmod 属可逆或可撤销，不计入。
 */
export const IRREVERSIBLE_IDS = ["rm-rf", "format-volume", "drop-database", "git-push-force", "write-system-path"];

/**
 * 取画像的审批范围。缺字段或非法值一律按最严 'mutating'（保守优先）。
 * 注意：本函数只决定"哪些类别需审批"，**不决定审批层是否启用**——审批层不可被画像关闭。
 */
export function profileScope(profile) {
  const entry = profile && profile.approvalGate;
  const scope = entry && typeof entry === "object" ? entry.scope : undefined;
  return scope === "irreversible" ? "irreversible" : "mutating";
}

/** 命中哪条高危特征（未命中返回 null）。 */
export function highRiskOf(command) {
  const cmd = String(command || "");
  return HIGH_RISK_TOOLS.find((r) => r.re.test(cmd)) || null;
}

/**
 * 六层资格审核。async：第 5 层要 await 模型信号。
 *
 * @param {object} req
 * @param {string} req.tool 工具名
 * @param {string} [req.command] 命令或操作描述
 * @param {string} req.purpose 声称的目的（必填，空白即 deny）
 * @param {string} req.scope 声称的影响范围（必填，空白即 deny）
 * @param {"turn"|"task"|"persist"} [req.ttl="turn"]
 * @param {object} [req.state] guard 侧只读状态：fused / probation / taskBudget / readSet
 * @param {string} [req.target] 改动类操作的目标路径（供第 4 层比对 readSet；缺省则跳过该项）
 * @param {Array<{name: string, re: RegExp}>} [req.redlines] 第 2 层绝对红线表（适配层注入）
 * @param {Function} [req.model] 第 5 层探针：({command,purpose,scope}) => {mismatch,risk,reason,actual_effect}
 * @param {Function} [req.audit] 审计写入（注入；本函数不碰真实 AUDIT.log）
 * @param {object} [req.grants] 授权表（默认新建一张）
 * @param {Function} [req.trace] 逐层回调，用于打印/断言每层判定
 * @param {object|null} [req.profile] 画像对象；缺省 null = 全部层启用（与 3.0.4 行为一致）
 * @returns {Promise<{decision: "allow"|"deny"|"needApproval", layer: string, reason: string, modelSignal: object|null, trace: Array}>}
 */
export async function checkEligibility({
  tool,
  command = "",
  purpose,
  scope,
  ttl = "turn",
  state = {},
  target,
  redlines = [],
  model,
  audit,
  grants = createGrantTable(),
  trace,
  profile = null,
} = {}) {
  const steps = [];
  const mark = (layer, decision, reason) => {
    const row = { layer, decision, reason };
    steps.push(row);
    if (typeof trace === "function") trace(row);
    return row;
  };
  const skippedRows = () => steps.filter((s) => s.decision === "skip").map((s) => ({ layer: s.layer, reason: s.reason }));
  const settle = (decision, layer, reason, modelSignal = null) => {
    if (typeof audit === "function") {
      audit({
        action: decision === "allow" ? "grant" : decision,
        tool,
        command: String(command || "").slice(0, 120),
        purpose,
        scope,
        ttl,
        layer,
        decision,
        modelSignal,
        reason,
        evidence: reason,
        skipped: skippedRows(),
      });
    }
    return { decision, layer, reason, modelSignal, trace: steps };
  };

  // 第 0 层：申请完整性（规格 §五：purpose / scope 必填，空白即 deny）。无画像开关，永不跳过。
  if (!String(purpose ?? "").trim()) {
    mark("0", "deny", "purpose 缺失");
    return settle("deny", "0", "purpose 缺失：申请必须写明目的");
  }
  if (!String(scope ?? "").trim()) {
    mark("0", "deny", "scope 缺失");
    return settle("deny", "0", "scope 缺失：申请必须写明影响范围");
  }
  mark("0", "pass", "申请完整");

  // 第 1 层：状态（拆两个子判据，共用层号 "1"；两者皆关才整层跳过）
  const fuseOn = layerEnabled(profile, "1-fuse");
  const budgetOn = layerEnabled(profile, "1-budget");
  if (!fuseOn && !budgetOn) {
    mark("1", "skip", "profile: stalledFuse 与 budgetGate 均关闭");
  } else {
    if (fuseOn && state.fused) {
      mark("1", "deny", "熔断中");
      return settle("deny", "1", "熔断中，仅允许只读");
    }
    if (fuseOn && state.probation) {
      mark("1", "deny", "降权中");
      return settle("deny", "1", "降权中，资格审核暂停");
    }
    const budget =
      typeof state.taskBudget === "number" ? state.taskBudget : typeof state.budget === "number" ? state.budget : undefined;
    if (budgetOn && typeof budget === "number" && budget <= 0) {
      mark("1", "deny", "预算耗尽");
      return settle("deny", "1", "预算耗尽");
    }
    mark("1", "pass", fuseOn && budgetOn ? "状态正常" : `状态正常（${fuseOn ? "budgetGate" : "stalledFuse"} 子判据已关）`);
  }

  // 第 2 层：绝对红线（命中即 deny，不进第 3 层）
  // 3.0.6 补口（HANDOFF §十 缺陷 2）：命中后先过上下文豁免，与 pipeline 文本层同口径。
  // 豁免成立则**降级**（不 deny，继续往下走），绝不直接放行。
  if (!layerEnabled(profile, "2")) {
    mark("2", "skip", "profile:redlineGate off");
  } else {
    const hit = (Array.isArray(redlines) ? redlines : []).find(
      (r) => r && r.re instanceof RegExp && r.re.test(String(command || "")),
    );
    if (hit) {
      const exempt = redlineExempt(String(command || ""), hit);
      if (exempt) {
        mark("2", "pass", `红线豁免降级（${exempt.basis}）：${hit.name}`);
      } else {
        mark("2", "deny", `绝对红线 ${hit.name}`);
        return settle("deny", "2", `命中绝对红线「${hit.name}」，直接拒绝（不弹审批）`);
      }
    } else {
      mark("2", "pass", "未命中绝对红线");
    }
  }

  // 第 3 层：资格（高危且本会话无授权 → needApproval；已有授权则继续）
  // 3.0.6 修正（HANDOFF §十 缺陷 4/5 + 安全项）：审批层**不可被画像关闭**（否则闸只剩授权表
  // 一道防线），故不再查 layerEnabled(profile,"3")；scope 是唯一可调维度。
  // 3.0.7 判定（回应外部接手模型提问「L3 是否也该接 redlineExempt」）：**不接，是设计决策而非口径遗漏**。
  //   闸（gateToolCall）与 L3 语义不同——
  //   · 闸：「无授权即 deny」，无人类环节，所以它必须自判上下文豁免，否则引号内数据被直接拒绝；
  //   · L3：「命中高危 → 转人工审批」，人类环节本身就是裁决，且人看得到完整命令。
  //   若 L3 也接豁免，"数据形态的高危命令"会无人审批直接放行 —— 风险不对称，故保留转审批。
  {
    const scope = profileScope(profile);
    const risky = highRiskOf(command);
    const inScope = Boolean(risky) && (scope === "mutating" || IRREVERSIBLE_IDS.includes(risky.id));
    if (inScope && !grants.has(tool)) {
      mark("3", "needApproval", `高危 ${risky.id} 且无授权（scope=${scope}）`);
      return settle("needApproval", "3", `${tool} 命中高危特征「${risky.id}」且本会话无授权，需人工审批`);
    }
    if (!risky) mark("3", "pass", "非高危");
    else if (!inScope) mark("3", "pass", `超出审批范围（scope=${scope}）：${risky.id}`);
    else mark("3", "pass", `已有授权（${risky.id}）`);
  }

  // 第 4 层：前置条件（整体受 evidenceGate 控制）
  if (!layerEnabled(profile, "4")) {
    mark("4", "skip", "profile:evidenceGate off");
  } else {
    if (target && isMutating(tool, { command }, false)) {
      const readSet = state.readSet || {};
      if (!readSet[target]) {
        mark("4", "deny", "未取证");
        return settle("deny", "4", `改动 ${target} 前未取证（readSet 无此目标）`);
      }
    }
    if (SYSTEM_PATH_RE.test(String(command || ""))) {
      mark("4", "deny", "系统路径");
      return settle("deny", "4", "命令涉及系统路径（C:\\Windows / /etc / /usr 等），禁止");
    }
    if (SPECIAL_DIR_RE.test(String(command || ""))) {
      mark("4", "needApproval", "特殊目录");
      return settle("needApproval", "4", "命令涉及 .git/ 或 node_modules/，需人工审批");
    }
    mark("4", "pass", "前置条件通过");
  }

  // 第 5 层：语义对齐（仅注入了 model 时生效；未注入则跳过，第一步零模型可跑）
  let modelSignal = null;
  if (typeof model === "function") {
    try {
      modelSignal = await model({ command, purpose, scope });
    } catch (error) {
      modelSignal = { mismatch: false, risk: 0, reason: "model-unavailable", error: String((error && error.message) || error) };
    }
    if (!modelSignal || typeof modelSignal !== "object") {
      modelSignal = { mismatch: false, risk: 0, reason: "model-unavailable" };
    }
    if (modelSignal.reason === "model-unavailable") {
      mark("5", "needApproval", "模型不可用");
      return settle("needApproval", "5", "模型审核失败，保守审批", modelSignal);
    }
    if (modelSignal.mismatch === true) {
      mark("5", "deny", "目的不符");
      return settle("deny", "5", `声称目的与实际效果不符：${String(modelSignal.actual_effect || modelSignal.reason || "")}`, modelSignal);
    }
    const risk = Number(modelSignal.risk);
    if (Number.isFinite(risk) && risk > RISK_ASK_THRESHOLD) {
      mark("5", "needApproval", `语义风险 ${risk}`);
      return settle("needApproval", "5", `语义风险 ${risk} 超过阈值 ${RISK_ASK_THRESHOLD}，转人工审批`, modelSignal);
    }
    mark("5", "pass", "语义一致");
  } else {
    mark("5", "skip", "未注入模型探针");
  }

  // 已登记未实现的开关：只在传了画像时登记进 trace，不参与执行
  if (profile) {
    for (const s of unimplementedSwitches(profile)) {
      mark(s.name, "skip", s.reason);
    }
  }

  // 第 6 层：通过 → 临时开放该工具 + 审计
  const granted = grants.grant(tool, {
    ttl,
    reason: `${String(purpose).trim()} / ${String(scope).trim()}`,
    layer: "6",
  });
  mark("6", "allow", "已临时开放");
  return settle("allow", "6", `资格审核通过，已按 ttl=${granted.ttl} 临时开放 ${tool}`, modelSignal);
}
