// FocusGuard 母版层 · 画像加载器（3.0.5）
//
// 职责：① modelId → 画像对象；② 层 → 子开关映射；③ 开关判定；④ 未实现开关登记。
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
 * modelId → 画像对象（浅拷贝 + 标注来源，避免调用方改到画像本体）。
 * 匹配顺序：空值 → 显式别名 → 画像 id 精确 → 画像 id 前缀 → default 兜底。
 */
export function loadProfile(modelId) {
  const id = normalizeModelId(modelId)
  if (!id) return { ...defaultProfile, profileSource: 'default:empty-model-id' }

  const alias = PROFILE_ALIASES[id]
  if (alias && PROFILES[alias]) return { ...PROFILES[alias], profileSource: `alias:${id}` }

  if (PROFILES[id]) return { ...PROFILES[id], profileSource: `exact:${id}` }

  const prefixed = Object.keys(PROFILES).find((key) => key !== 'default' && id.startsWith(key))
  if (prefixed) return { ...PROFILES[prefixed], profileSource: `prefix:${prefixed}` }

  return { ...defaultProfile, profileSource: `default:unmatched:${id}` }
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
