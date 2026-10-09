// FocusGuard 画像 · deepseek-flash
//
// 纪律：本文件**只放参数**，禁止任何函数、分支或 import 逻辑。
//      治理层与 checkEligibility 各层的映射见 core/profileLoader.mjs。
// 参数标 TODO 者为未实测值；实测后回填，勿凭印象填写。

export default {
  id: 'deepseek-flash',
  displayName: 'DeepSeek V4.1 Flash',

  // —— 治理层开关（每个维度独立）——
  stalledFuse: { enabled: true, threshold: 3 }, // TODO(实测)：停滞熔断阈值
  budgetGate: { enabled: true, ceiling: 200 }, // TODO(实测)：预算上限
  reasoningWatch: { enabled: true, maxSeconds: 90 }, // TODO：引擎未实现，仅登记
  evidenceGate: { enabled: true }, // L4 未取证
  emotionFilter: { enabled: true }, // TODO：引擎未实现，仅登记
  approvalGate: { enabled: true, scope: 'mutating' }, // L3 高危资格
  redlineGate: { enabled: true }, // L2 绝对红线

  // —— API 兼容度（供适配层选路）——
  apiCompat: 'openai-strict',
  toolCallFormat: 'standard',
  supportsParallelTools: true,
}
