/**
 * 第 1.5 层：命令硬校验（规则来源 = .ai/env-fingerprint.json 的 map 表）。
 * 2026-10-27 从 pipeline.mjs 抽出，纯搬运。
 *
 * 指纹是规则来源、本层是执行层：mtime 变化立即生效，无需重启；指纹缺失/损坏一律 fail-open + warn。
 */
import { statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditDeny } from '../audit.mjs'
import { cwdOf } from './tooling.mjs'

const ENV_FINGERPRINT_REL = join('.ai', 'env-fingerprint.json')
let envFpCache = { path: null, mtimeMs: 0, map: null }
let envFpMissingWarned = false

/** 读环境指纹的 map 表；缺失或损坏返回 null（fail-open）。 */
function readEnvMap(warn, cwd = process.cwd()) {
  const p = join(cwd, ENV_FINGERPRINT_REL)
  try {
    const mtimeMs = statSync(p).mtimeMs
    if (envFpCache.path !== p || envFpCache.mtimeMs !== mtimeMs) {
      const parsed = JSON.parse(readFileSync(p, 'utf8'))
      const map = parsed && parsed.map && typeof parsed.map === 'object' && !Array.isArray(parsed.map) ? parsed.map : null
      envFpCache = { path: p, mtimeMs, map }
    }
    return envFpCache.map
  } catch {
    envFpCache = { path: null, mtimeMs: 0, map: null }
    if (warn && !envFpMissingWarned) {
      envFpMissingWarned = true
      warn(`环境指纹缺失（${p}）：命令硬校验跳过（fail-open）。生成：node packages/core/tools/env-fingerprint.mjs`)
    }
    return null
  }
}

/**
 * 命令硬校验：任一段（|、;、&&、||、换行）的段首命令词命中 map 的 key → deny。
 * 白名单：① 引号内字符串字面量（先剥离）② 参数值（只判段首 token）③ 文件路径（含分隔符或以 . 开头）。
 */
export function hardCheck(cmd, map, warn, cwd) {
  // cwd 缺省时落回 readEnvMap 的 process.cwd()。DSH Desktop 的进程 cwd 是应用安装目录
  // （E:\DSH\DSH Desktop），不是工作区，故调用点必须传会话 cwd，否则工作区里的
  // .ai/env-fingerprint.json 永远读不到 → 本层等于没开（fail-open）。
  const m = map || readEnvMap(warn, cwd)
  if (!m) return null
  const stripped = String(cmd || '').replace(/'[^']*'|"[^"]*"/g, ' ')
  for (const seg of stripped.split(/\|\||&&|[|;\n]/)) {
    const first = seg.trim().split(/\s+/)[0]
    if (!first) continue
    if (/[\\/]/.test(first) || first.startsWith('.')) continue
    if (Object.prototype.hasOwnProperty.call(m, first)) {
      return { kind: 'deny', reason: `本机环境：用 ${m[first]} 替代 ${first}。命令：${String(cmd).slice(0, 120)}` }
    }
  }
  return null
}

/** pre-execute 阶段：段首命令词命中替代表 → 拒绝；异常 fail-open 继续。 */
export async function hardCheckStage(ctx) {
  const { exec, warn, cmd } = ctx
  if (!cmd) return null
  try {
    const hard = hardCheck(cmd, null, warn, cwdOf(exec))
    if (hard) {
      warn('硬校验拦截：', hard.reason)
      auditDeny(exec, cmd, { trigger: 'env-substitute', level: 2 })
      return hard
    }
  } catch (error) {
    warn('硬校验异常，fail-open 放行：', (error && error.message) || error)
  }
  return null
}
