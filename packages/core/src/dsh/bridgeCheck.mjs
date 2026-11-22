/**
 * 官方桥版本核验（2026-11-22）
 *
 * 边界：`@deepseek-ai/dsh-hooks-claude-code`（官方桥）由官方仓库维护，本仓只提供
 * `hooks/hooks.json` 这个**适配层**。桥的事件契约/载荷一变，适配层可能跟着要改。
 * 所以启动时若检测到桥版本落在已验证区间外，报警并给升级/回退命令——不静默跑。
 *
 * 检测顺序：
 *   ① `FG_BRIDGE_VERSION`（测试/特殊部署显式覆盖）
 *   ② 从当前解析链读桥的 package.json（DSH 把桥放在 app.asar 内，普通 fs 读不到时跳过）
 *
 * 区间依据：hooks 六事件映射在 0.2.1-rc.1 ~ 0.2.2-rc.5 实测通过；0.3 起未回归。
 */
import { createRequire } from 'node:module'

export const SUPPORTED_BRIDGE_RANGE = '>=0.2.1-rc.1 <0.3.0'
export const VERIFIED_BRIDGE_VERSIONS = Object.freeze(['0.2.1-rc.1', '0.2.2-rc.5'])

const RANGE_MIN = [0, 2, 1]
const RANGE_MAX_EXCLUSIVE = [0, 3, 0]

const require = createRequire(import.meta.url)

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim())
  if (!m) return null
  return { main: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' }
}

function cmp(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** 是否落在支持区间：>=0.2.1-rc.1 且 <0.3.0。预发布按主版本比较（宽松：rc 都算在区间内）。 */
export function bridgeSupported(version) {
  const p = parse(version)
  if (!p) return false
  if (cmp(p.main, RANGE_MIN) < 0) return false
  if (cmp(p.main, RANGE_MAX_EXCLUSIVE) >= 0) return false
  return true
}

/** 读桥版本；读不到返回空串（不报假警）。 */
export function detectBridgeVersion() {
  const forced = String(process.env.FG_BRIDGE_VERSION || '').trim()
  if (forced) return forced
  try {
    const pkg = require('@deepseek-ai/dsh-hooks-claude-code/package.json')
    return String((pkg && pkg.version) || '')
  } catch {
    return ''
  }
}

/**
 * 核验结果：{version, supported, message}
 * message 只在"检测到版本但不支持"时非空——升级/回退命令写在里面。
 */
export function checkBridge(version = detectBridgeVersion()) {
  if (!version) return { version: '', supported: true, message: '' }
  if (bridgeSupported(version)) return { version, supported: true, message: '' }
  return {
    version,
    supported: false,
    message:
      `[focus-guard] 官方桥 ${version} 不在适配层支持区间 ${SUPPORTED_BRIDGE_RANGE}（已验证：${VERIFIED_BRIDGE_VERSIONS.join(' / ')}）。` +
      'hooks 契约可能已变，行为不作保证。升级：`npm i -g @deepseek-ai/dsh-hooks-claude-code@latest` 或升级 DSH 到自带匹配桥的版本；' +
      `回退：\`npm i -g @deepseek-ai/dsh-hooks-claude-code@${VERIFIED_BRIDGE_VERSIONS[VERIFIED_BRIDGE_VERSIONS.length - 1]}\` 或回退 DSH。` +
      '桥层面的缺陷/功能缺失请到官方仓库反馈；本仓只处理适配层缺陷与兼容问题。',
  }
}

/** 启动自检用：不抛错，只返回一行可注入/可 warn 的文本。 */
export function bridgeNotice() {
  try {
    return checkBridge().message
  } catch {
    return ''
  }
}
