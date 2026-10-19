// FocusGuard 母版层 · 画像加载器（3.0.5）
//
// 职责：① modelId → 画像对象；② 层 → 子开关映射；③ 开关判定；④ 未实现开关登记；
//      ⑤ 审批 scope 解析（显式 `approvalGate.scope` 优先，否则由 L1 的 `evasionRisk` 派生）。
// 纪律：**只做数据查表**，禁止按 modelId 做全等判断的硬编码分支；
//      匹配不到一律回落 default 画像（最严治理）。
// 层→开关的拆分依据：领导 2026-10-09 批复——L1 拆成 stalledFuse 与 budgetGate 两个子判据；
//      reasoningWatch / emotionFilter 只登记、不绑定执行（trace 报 skipped 并注明原因）。

import defaultProfile from '../profiles/default.mjs'
import deepseekFlash from '../profiles/deepseek-flash.mjs'
import deepseekPro from '../profiles/deepseek-pro.mjs'
import glm from '../profiles/glm.mjs'
import gptAstra from '../profiles/gpt-astra.mjs'

/** 画像注册表：画像 id → 画像对象。新增画像 = 加 profiles/ 文件 + 在此登记一行。 */
export const PROFILES = {
  'deepseek-flash': deepseekFlash,
  'deepseek-pro': deepseekPro,
  'glm': glm,
  'gpt-astra': gptAstra,
  'default': defaultProfile,
}

/**
 * 显式别名表：真实模型名 → 画像 id。这是**数据**，不是分支。
 * 已知真实 modelId 时在此登记一行即可，无需改任何逻辑。
 */
export const PROFILE_ALIASES = {
  // 例：'deepseek-v4.1-flash': 'deepseek-flash',
}

/**
 * 层 → 子开关名。与 checkEligibility 的六层对齐；null 表示该层不受画像控制、永不跳过。
 * L0 申请完整性 / L5 语义探针（由调用方是否注入 model 决定）/ L6 授权：均无画像开关。
 */
export const LAYER_SWITCHES = {
  '0': null,
  '1-fuse': 'stalledFuse',
  '1-budget': 'budgetGate',
  '2': 'redlineGate',
  '3': 'approvalGate',
  '4': 'evidenceGate',
  '5': null,
  '6': null,
}

/** 已登记但引擎尚未实现的开关：只进 trace 的 skipped 报告，不参与执行。 */
export const UNIMPLEMENTED_SWITCHES = {
  reasoningWatch: 'no engine implementation, TODO',
  emotionFilter: 'no engine implementation, TODO',
}

/** modelId 归一化：去空白 + 小写。 */
export function normalizeModelId(modelId) {
  return String(modelId ?? '').trim().toLowerCase()
}

/**
 * 画像**不可关闭**的开关：审批层（L3）是最后防线。
 * 若允许画像关掉它，则"decide 跳过 L3 + 闸只认授权表"会把审批端到端绕过
 * （HANDOFF §十 安全项，子代理实测）。加载时强制启用并留痕，不静默接受。
 */
export const FORCED_ON_SWITCHES = ['approvalGate']

/** 审批范围合法值（与 checkEligibility 的 L3 判定对齐）。 */
export const APPROVAL_SCOPES = ['mutating', 'irreversible']

/** 规避风险合法值。 */
export const EVASION_RISKS = ['high', 'low']

/**
 * 画像的规避风险（`evasionRisk`，L1 画像包的纯参数字段）。
 * 缺失、非字符串、非法值一律按最严 `high`（保守优先，不误放行）。
 * 取值尚未实测（各画像标 TODO(实测)），当前一律 `high` = 与 3.0.8 行为一致。
 */
export function evasionRiskOf(profile) {
  const raw = profile && profile.evasionRisk
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return EVASION_RISKS.includes(value) ? value : 'high'
}

/**
 * 画像的**审批范围**——全仓唯一真源（`checkEligibility.profileScope` 委托到这里）。
 *
 * 解析顺序：① 显式 `approvalGate.scope`（合法即用，数据优先）→ ② 由 `evasionRisk` 派生：
 *   low → `irreversible`（只收不可逆类别）；high / 缺省 / 非法 → `mutating`（全部高危类别）。
 *
 * 安全边界：`IRREVERSIBLE_IDS`（rm-rf / format-volume / drop-database / git-push-force /
 * write-system-path）在**任何** scope 下都需要审批——本函数只能把范围收窄到不可逆，永远放不掉它们。
 * 本函数也不决定审批层是否启用：审批层不可被画像关闭（FORCED_ON_SWITCHES）。
 */
export function approvalScopeOf(profile) {
  const entry = profile && profile.approvalGate
  const explicit = entry && typeof entry === 'object' ? entry.scope : undefined
  if (APPROVAL_SCOPES.includes(explicit)) return explicit
  return evasionRiskOf(profile) === 'low' ? 'irreversible' : 'mutating'
}

/**
 * 落地画像：浅拷贝 + 标注来源 + 强制不可关闭的开关保持启用。
 */
function enforcePolicy(base, source) {
  const profile = { ...base, profileSource: source }
  for (const key of FORCED_ON_SWITCHES) {
    const entry = profile[key]
    if (entry && typeof entry === 'object' && entry.enabled === false) {
      console.warn(
        `[focus-guard] 画像「${profile.id}」试图关闭 ${key} → 已强制启用（审批层不可关，见 HANDOFF §十 安全项）`,
      )
      profile[key] = { ...entry, enabled: true, forcedOn: true }
    }
  }
  return profile
}

/**
 * modelId → 画像对象（浅拷贝 + 标注来源，避免调用方改到画像本体）。
 * 匹配顺序：空值 → 显式别名 → 画像 id 精确 → 画像 id 前缀 → default 兜底。
 */
export function loadProfile(modelId) {
  const id = normalizeModelId(modelId)
  if (!id) return enforcePolicy(defaultProfile, 'default:empty-model-id')

  const alias = PROFILE_ALIASES[id]
  if (alias && PROFILES[alias]) return enforcePolicy(PROFILES[alias], `alias:${id}`)

  if (PROFILES[id]) return enforcePolicy(PROFILES[id], `exact:${id}`)

  const prefixed = Object.keys(PROFILES).find((key) => key !== 'default' && id.startsWith(key))
  if (prefixed) return enforcePolicy(PROFILES[prefixed], `prefix:${prefixed}`)

  return enforcePolicy(defaultProfile, `default:unmatched:${id}`)
}

/**
 * 该层是否启用。无开关（null）、画像缺字段、字段非对象 → 一律 true（保守优先，不误跳过）。
 */
export function layerEnabled(profile, layerKey) {
  const switchName = LAYER_SWITCHES[layerKey]
  if (!switchName) return true
  const entry = profile && profile[switchName]
  if (!entry || typeof entry !== 'object') return true
  return entry.enabled !== false
}

/** 未实现开关清单（供 trace 的 skipped 报告）。 */
export function unimplementedSwitches(profile) {
  const out = []
  for (const [name, reason] of Object.entries(UNIMPLEMENTED_SWITCHES)) {
    const entry = profile && profile[name]
    if (entry && typeof entry === 'object') {
      out.push({ name, enabled: entry.enabled !== false, reason })
    }
  }
  return out
}
