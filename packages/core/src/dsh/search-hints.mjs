/**
 * 检索后端探测与提示协调（2026-10-25）
 *
 * 病根：整文件闸的理由里**无条件**写死 `xerj search/def`。没装 XERJ 的用户照做必然失败——
 * 与"死闸"同类：提示看着专业，实际不可执行。
 *
 * 本模块只做三件事，不改任何判定：
 *   ① 探测本机可用的检索后端（xerj / rg / fd，允许环境变量指定）；
 *   ② 按探测结果给出**能立刻照做**的换法；
 *   ③ 一个都探测不到时，提示用户装一个（每会话一次），并说明 FG 会自动协调。
 *
 * 环境变量：
 *   FG_SEARCH_TOOL=rg|xerj|fd    强制指定首选后端（用户已装别的检索插件时用）
 *   FG_SEARCH_BIN_DIR           额外的可执行文件目录（如 scoop shims）
 */

import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

const BACKENDS = {
  xerj: {
    label: 'XERJ',
    how: '`xerj search "<关键词>"` / `xerj def "<符号>"`',
    install: 'https://github.com/xerj-org/xerj',
  },
  rg: {
    label: 'ripgrep',
    how: '`rg -n "<关键词>" <目录>` 或 `rg -n "<符号>" -g "*.mjs"`',
    install: 'https://github.com/BurntSushi/ripgrep',
  },
  fd: {
    label: 'fd',
    how: '`fd -e mjs <文件名片段>` 先定位文件，再 `read` 分段读',
    install: 'https://github.com/sharkdp/fd',
  },
}

function existsInPath(bin) {
  const extra = String(process.env.FG_SEARCH_BIN_DIR || '')
    .split(delimiter)
    .filter(Boolean)
  const dirs = [...String(process.env.PATH || '').split(delimiter), ...extra].filter(Boolean)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const d of dirs) {
    for (const ext of exts) {
      try {
        accessSync(join(d, bin + ext), constants.X_OK)
        return true
      } catch {
        /* 继续找 */
      }
    }
  }
  return false
}

/** 探测可用后端；`FG_SEARCH_TOOL` 指定的后端优先（即使探测不到也信任用户）。 */
export function detectSearchBackends() {
  const forced = String(process.env.FG_SEARCH_TOOL || '').toLowerCase().trim()
  const found = {}
  for (const id of Object.keys(BACKENDS)) found[id] = existsInPath(id)
  if (forced && BACKENDS[forced]) {
    found[forced] = true
    return { found, preferred: forced, forced: true }
  }
  const preferred = ['xerj', 'rg', 'fd'].find((id) => found[id]) || null
  return { found, preferred, forced: false }
}

/**
 * 整读被拦后的换法。永远给出**当前环境可执行**的命令。
 * @param {{found: Record<string, boolean>, preferred: string|null}} backends
 */
export function retrievalHint(backends) {
  const b = backends || detectSearchBackends()
  if (b.preferred && BACKENDS[b.preferred]) {
    const meta = BACKENDS[b.preferred]
    return `改用检索定位：${meta.how}；确实要读全文就带 offset/limit 分段读。`
  }
  return (
    '改用检索定位：先 `glob` 找到目标文件，再带 offset/limit 分段读；' +
    '本机未探测到检索工具（xerj / rg / fd 任一），装一个会显著更省。'
  )
}

/** 一个检索后端都没有时的安装提醒（每会话一次由调用方去重）。 */
export function installReminder(backends) {
  const b = backends || detectSearchBackends()
  if (b.preferred) return null
  return (
    '[FG 检索提示] 本机没有探测到 xerj / rg / fd 任一检索工具，整读被拦后只能分段读。' +
    '装一个即可（推荐 ripgrep：`scoop install ripgrep`），FG 会自动按可用后端改写拦截理由；' +
    '若你已装其它检索插件，可用 `FG_SEARCH_TOOL=<名字>` 或 `FG_SEARCH_BIN_DIR=<目录>` 让 FG 协调。'
  )
}

/** 测试/诊断用：返回人类可读的探测结果。 */
export function describeBackends(backends) {
  const b = backends || detectSearchBackends()
  const names = Object.keys(b.found).filter((k) => b.found[k])
  return `可用检索后端：${names.length ? names.join(' / ') : '（无）'}；首选=${b.preferred || '无'}${b.forced ? '（FG_SEARCH_TOOL 指定）' : ''}`
}
