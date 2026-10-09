// FocusGuard 画像 · gpt-astra
//
// 纪律：本文件**只放参数**，禁止任何函数、分支或 import 逻辑。
//      治理层与 checkEligibility 各层的映射见 core/profileLoader.mjs。
// 参数标 TODO 者为未实测值；实测后回填，勿凭印象填写。
//
// 与 deepseek-flash 的差异（用于验收「同请求不同画像决策不同」）：
//   evidenceGate  off  → L4 未取证不再 deny
//   stalledFuse   off  → 停滞熔断子判据不启用
//   emotionFilter off  → 仅登记项，本就不绑定执行
//   approvalGate scope: 'irreversible' → 高危资格收窄到不可逆操作

export default {
  id: 'gpt-astra',
  displayName: 'GPT Astra',

  // —— 治理层开关（每个维度独立）——
  stalledFuse: { enabled: false, threshold: 3 }, // TODO(实测)：关闭
  budgetGate: { enabled: true, ceiling: 200 }, // TODO(实测)：预算上限
  reasoningWatch: { enabled: true, maxSeconds: 90 }, // TODO：引擎未实现，仅登记
  evidenceGate: { enabled: false }, // 差异化：关闭 L4 未取证闸
  emotionFilter: { enabled: false }, // TODO：引擎未实现，仅登记
  approvalGate: { enabled: true, scope: 'irreversible' }, // L3：仅不可逆操作需审批
  redlineGate: { enabled: true }, // L2 绝对红线

  // —— API 兼容度（供适配层选路）——
  apiCompat: 'openai-strict',
  toolCallFormat: 'standard',
  supportsParallelTools: true,
}
