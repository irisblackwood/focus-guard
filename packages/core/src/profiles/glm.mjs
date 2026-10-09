// FocusGuard 画像 · glm
//
// 纪律：本文件**只放参数**，禁止任何函数、分支或 import 逻辑。
//      治理层与 checkEligibility 各层的映射见 core/profileLoader.mjs。
// 参数标 TODO 者为未实测值；实测后回填，勿凭印象填写。
//
// 备注：GLM 预设层挂载已于 2026-10-07 摘除（见 HANDOFF 第六节）；本画像留档备用。

export default {
  id: 'glm',
  displayName: 'GLM',

  // —— 治理层开关（每个维度独立）——
  stalledFuse: { enabled: true, threshold: 3 }, // TODO(实测)：停滞熔断阈值
  budgetGate: { enabled: true, ceiling: 200 }, // TODO(实测)：预算上限
  reasoningWatch: { enabled: true, maxSeconds: 120 }, // TODO：引擎未实现，仅登记
  evidenceGate: { enabled: true }, // L4 未取证
  emotionFilter: { enabled: true }, // TODO：引擎未实现，仅登记
  approvalGate: { enabled: true, scope: 'mutating' }, // L3 高危资格
  redlineGate: { enabled: true }, // L2 绝对红线

  // —— API 兼容度（供适配层选路）——
  apiCompat: 'openai-strict', // TODO(实测)：GLM 走 OpenAI 兼容接口
  toolCallFormat: 'standard', // TODO(实测)
  supportsParallelTools: true, // TODO(实测)
}
