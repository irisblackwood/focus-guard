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
    // 2026-11-20：XERJ 是**索引式**后端。二进制在 PATH 只证明"装了"，不证明"当前目录被索引过"。
    // 装了没跑过 `xerj autoindex` 的用户照 `xerj search` 得到空结果——假提示换了个更隐蔽的形态。
    // 为什么不机械判定：`xerj autoindex status` 要连**运行中的节点**（localhost:9200），
    // hook 层每次工具调用都查不起（节点没起时会阻塞），且 `--data-dir` 默认值官方文档未给出，
    // 无法靠"看某个目录是否存在"离线判断。故如实声明前提，并在 retrievalHint 里给 rg 退路。
    caveat: 'XERJ 需先对当前目录建过索引（`xerj autoindex status` 可查），未建索引时检索为空',
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
/**
 * 探测结果缓存（2026-10-29）
 *
 * 病根：`wholeFileStage` 每一步工具调用都会调本函数，而它要遍历整个 PATH——
 * 实测 PATH 73 个目录 × 3 个后端 × Windows 4 种扩展名 = 最多 876 次 `accessSync`，
 * **单次 13.72ms**，占判定总延迟的绝大部分（bench:decision 的 p95 从 2.37 涨到 18.35 就是这个）。
 * 模块头注释原本写着"每会话探测一次并缓存结果"，但实现里没有缓存——注释与代码不符。
 *
 * 用 60 秒 TTL 而不是永久缓存：用户装完 rg 后一分钟内就能被重新探到，
 * 不至于因为进程常驻而一直报"没装检索工具"。
 */
const PROBE_TTL_MS = 60_000
let probeCache = null
let probeKey = ''
let probeAt = 0

/** 缓存键 = 影响探测结果的全部输入。环境一变缓存立即失效——缓存不能比它的输入活得久。 */
function probeKeyOf() {
  return `${process.env.FG_SEARCH_TOOL || ''}\u0000${process.env.FG_SEARCH_BIN_DIR || ''}\u0000${process.env.PATH || ''}`
}

/** 清探测缓存（测试用；装完检索工具后想立刻重探也可手动调）。 */
export function resetSearchBackendsCache() {
  probeCache = null
  probeKey = ''
  probeAt = 0
}

export function detectSearchBackends() {
  const key = probeKeyOf()
  const now = Date.now()
  if (probeCache && probeKey === key && now - probeAt < PROBE_TTL_MS) return probeCache
  const forced = String(process.env.FG_SEARCH_TOOL || '').toLowerCase().trim()
  const found = {}
  for (const id of Object.keys(BACKENDS)) found[id] = existsInPath(id)
  if (forced && BACKENDS[forced]) {
    found[forced] = true
    probeCache = { found, preferred: forced, forced: true }
  } else {
    probeCache = { found, preferred: ['xerj', 'rg', 'fd'].find((id) => found[id]) || null, forced: false }
  }
  probeKey = key
  probeAt = now
  return probeCache
}

/**
 * 整读被拦后的换法。永远给出**当前环境可执行**的命令。
 * @param {{found: Record<string, boolean>, preferred: string|null}} backends
 */
export function retrievalHint(backends) {
  const b = backends || detectSearchBackends()
  if (b.preferred && BACKENDS[b.preferred]) {
    const meta = BACKENDS[b.preferred]
    const lines = [`改用检索定位：${meta.how}；确实要读全文就带 offset/limit 分段读。`]
    // 首选是索引式后端时，必须同时给一条**不依赖索引**的退路：
    // "装了但没索引"的 xerj 比 rg 更难用，只留一条路等于把人堵在死胡同里。
    // 退路只在本机真装了 rg 时给——否则退路本身就成了新的假提示。
    if (meta.caveat) {
      lines.push(`${meta.caveat}。`)
      if (b.found && b.found.rg) lines.push('若当前目录未建索引，改用 `rg -n "<关键词>" <目录>`。')
    }
    return lines.join('')
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
