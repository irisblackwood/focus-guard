/**
 * 第 1.4 层：整文件读取闸（2026-10-18 人类批示：整文件检索交给 XERJ）。
 * 2026-10-27 从 pipeline.mjs 抽出，纯搬运。
 *
 * 口径：目标文件 > N 行（默认 300）且**没有分段参数/限量管道** → 拒绝，并指向 XERJ。
 * 为什么排在 1.5 层之前：环境指纹对 cat 只给「用 bat 替代」，而 bat 同样是整文件灌屏；
 * 本层的正解是「别整读，去检索」——谁先开口决定模型学会哪条。
 * 边界：命中不了目标文件（相对路径、动态拼接、变量）一律 fail-open，不猜。
 */
import { statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { detectSearchBackends, retrievalHint, installReminder } from '../search-hints.mjs'
import { auditDeny } from '../audit.mjs'
import { cwdOf, pathOfTool, resolveToolPath, sessionIdOf } from './tooling.mjs'

// 每会话只提醒一次"没装检索工具"（避免每步刷屏）。
const remindedNoBackend = new Set()

const WHOLE_FILE_MAX_LINES = Number(process.env.FG_WHOLE_FILE_MAX_LINES) || 300
// 提示按**本机可用后端**给（2026-10-25）：xerj 装了就用它，没装就退到 rg/fd，
// 一个都没有时给出安装建议。写死 xerj 的后果是"照做必然失败"的假提示。
const WHOLE_FILE_READ_TOOLS = /^(?:read|read_file|readfile|view)$/i
const WHOLE_FILE_SHELL = /(^|[;&|]\s*)(?:cat|type|Get-Content|bat)\s/i

/** 该文件是否超过 n 行；分块数换行、够数即停，绝不把整文件读进内存。 */
export function exceedsLines(file, n) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.allocUnsafe(64 * 1024)
    let lines = 0
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null)
      if (read <= 0) return false
      for (let i = 0; i < read; i += 1) {
        if (buf[i] === 10) {
          lines += 1
          if (lines > n) return true
        }
      }
    }
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* fd 已关或不可关：不影响判定 */
      }
    }
  }
}

/** 读类 shell 命令里的第一个真实存在的文件参数；取不到返回 null（fail-open）。 */
export function shellFileTarget(cmd, cwd) {
  for (const token of String(cmd).split(/\s+/)) {
    if (!token || token.startsWith('-') || /[|&;><$`]/.test(token)) continue
    const abs = isAbsolute(token) ? token : join(cwd || process.cwd(), token)
    try {
      if (statSync(abs).isFile()) return abs
    } catch {
      /* 不是文件就下一个 */
    }
  }
  return null
}

/** pre-execute 阶段：大文件整读 → 拒绝并指向检索；异常 fail-open 继续。 */
export async function wholeFileStage(ctx) {
  const { exec, warn, cmd } = ctx
  try {
    const toolName = String((exec && exec.name) || '')
    const args = (exec && exec.arguments) || {}
    // 检索后端每会话探测一次并缓存结果（PATH 扫描很便宜，但没必要每步都扫）。
    const backends = detectSearchBackends()
    if (!backends.preferred && !remindedNoBackend.has(sessionIdOf(exec))) {
      remindedNoBackend.add(sessionIdOf(exec))
      const tip = installReminder(backends)
      if (tip) warn(tip)
    }
    let target = null
    let segmented = false
    if (WHOLE_FILE_READ_TOOLS.test(toolName)) {
      // 2026-10-19 修：真实调用传相对路径，必须按会话 cwd 解析，否则 statSync 抛错 → 闸无声跳过。
      target = resolveToolPath(pathOfTool(args), exec)
      segmented = Boolean(args.limit || args.offset)
    } else if (cmd && WHOLE_FILE_SHELL.test(cmd)) {
      segmented = /\||>|-TotalCount|-First|-Tail|--limit/.test(cmd)
      if (!segmented) target = shellFileTarget(cmd, cwdOf(exec))
    }
    if (target && !segmented && exceedsLines(target, WHOLE_FILE_MAX_LINES)) {
      warn('整文件闸拦截：', `${target} 超过 ${WHOLE_FILE_MAX_LINES} 行整读`)
      auditDeny(exec, `整读 ${target}`, { trigger: 'whole-file:lines' })
      return {
        kind: 'deny',
        reason:
          `focus-guard-native: 整文件闸——${target} 超过 ${WHOLE_FILE_MAX_LINES} 行，禁止整文件读取（本次为相对路径，已按会话 cwd 解析）。` +
          retrievalHint(backends),
      }
    }
  } catch (error) {
    warn('整文件闸异常，fail-open 放行：', (error && error.message) || error)
  }
  return null
}
