// FocusGuard 画像 · default（未匹配 modelId 时的兜底）
//
// 纪律：本文件**只放参数**，禁止任何函数、分支或 import 逻辑。
//      治理层与 checkEligibility 各层的映射见 core/profileLoader.mjs。
//
// 兜底策略：行为未知的模型按**最严治理**处理——所有治理层开启，
// 未知 API 兼容度按最保守取值，不假设支持并行工具调用。

export default {
  id: 'default',
  displayName: 'Default（未识别模型兜底画像）',

  // —— 治理层开关（每个维度独立）——
  stalledFuse: { enabled: true, threshold: 3 }, // TODO(实测)：停滞熔断阈值
  budgetGate: { enabled: true, ceiling: 200 }, // TODO(实测)：预算上限
  reasoningWatch: { enabled: true, maxSeconds: 90 }, // TODO：引擎未实现，仅登记
  evidenceGate: { enabled: true }, // L4 未取证
  emotionFilter: { enabled: true }, // TODO：引擎未实现，仅登记
  approvalGate: { enabled: true, scope: 'mutating' }, // L3 高危资格
  redlineGate: { enabled: true }, // L2 绝对红线

  // —— API 兼容度（未知即保守）——
  apiCompat: 'unknown', // TODO(实测)
  toolCallFormat: 'standard', // TODO(实测)
  supportsParallelTools: false, // TODO(实测)：未知模型不假设支持
}
