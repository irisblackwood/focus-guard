// FocusGuard 画像 · deepseek-pro
//
// 纪律：本文件**只放参数**，禁止任何函数、分支或 import 逻辑。
//      治理层与 checkEligibility 各层的映射见 core/profileLoader.mjs。
// 参数标 TODO 者为未实测值；实测后回填，勿凭印象填写。

export default {
  id: 'deepseek-pro',
  displayName: 'DeepSeek V4.1 Pro',

  // —— 治理层开关（每个维度独立）——
  // 相对 flash：推理更强、可容忍更长停滞与更高预算，其余治理层不放松。
  stalledFuse: { enabled: true, threshold: 4 }, // TODO(实测)：停滞熔断阈值
  budgetGate: { enabled: true, ceiling: 300 }, // TODO(实测)：预算上限
  reasoningWatch: { enabled: true, maxSeconds: 180 }, // TODO：引擎未实现，仅登记
  evidenceGate: { enabled: true }, // L4 未取证
  emotionFilter: { enabled: true }, // TODO：引擎未实现，仅登记
  approvalGate: { enabled: true, scope: 'mutating' }, // L3 高危资格
  redlineGate: { enabled: true }, // L2 绝对红线

  // —— API 兼容度（供适配层选路）——
  apiCompat: 'openai-strict',
  toolCallFormat: 'standard',
  supportsParallelTools: true,
}
