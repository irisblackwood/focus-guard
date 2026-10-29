/**
 * 会话落盘读取（2026-10-29）
 *
 * `prefix-audit` 与 `prefix-drift` 都要读 DSH 的 `session.v4.jsonl.zstd`：
 * 递归找文件、按 zstd 帧边界解压、按行 parse。原先两个工具各抄一份 `walk` + `decode`
 * ——重复块检测（`smells.mjs`）当场报了 44 > 41，这是它第一次抓到"新代码抄旧代码"。
 *
 * 只做读取与切段，不含任何口径判断：口径留在各自工具里，免得共享层偷偷替人做决定。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 递归找会话落盘文件（按 mtime 由新到旧）。找不到目录返回空数组，不抛错。 */
export function walkSessionFiles(dir, out = []) {
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walkSessionFiles(p, out)
    else if (e === 'session.v4.jsonl.zstd') out.push({ f: p, m: st.mtimeMs, size: st.size })
  }
  return out.sort((a, b) => b.m - a.m)
}

/**
 * 解压并解析成行对象。
 * zstd 帧用魔数 `28 B5 2F FD` 定位——一个文件里可能拼了多帧，整块解压会失败。
 */
export function decodeSession(file) {
  const buf = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
    } catch {
      /* 坏帧跳过 */
    }
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** 只取消息本体：外层 `data` 还挂着 `{turn, step}` 记账编号，那不是提示内容。 */
export function textOfMessage(line) {
  const d = line && line.data
  return JSON.stringify((d && (d.message || d.content)) || d || '')
}

/** 第一个分歧字符位；完全相同返回 -1。 */
export function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}
