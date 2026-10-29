/**
 * 费用对比与面板对账（2026-10-29 从 prefix-drift.mjs 抽出，纯搬运）。
 *
 * 口径两条，别混：
 *  - est4（字符/4）：只是估算，用来比较"改前 vs 改后"的相对差；
 *  - 面板实测（panel-runs.json）：真实 token 与命中率，`collect-panel.mjs` 产出，带 session id。
 * 能按 sid 匹配到本地会话时，用 `实测/est4` 给出校准系数，避免把估算当账单。
 */
import { basename, dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { decodeSession, textOfMessage, walkSessionFiles } from './sessionDump.mjs'
import { calcCost } from '../../src/peak-cost.mjs'

/**
 * 费用对比：改前 vs 改后。
 *
 * 机制前提（实测）：宿主 `systemPromptUpdate: "in-history"`——系统提示一变，就**追加一条完整的
 * system 消息**（约 10,280 字），此后每一步都背着它。所以 FG 抖 480 字，代价是 21 倍放大的整份提示。
 */
export function runCost({ sessionsDir, limit = 8 } = {}) {
  const TOK = (chars) => Math.round(chars / 4)
  const rows = []
  for (const cand of walkSessionFiles(sessionsDir)
    .filter((x) => x.size < 3 * 1024 * 1024)
    .slice(0, limit)) {
    let lines
    try {
      lines = decodeSession(cand.f)
    } catch {
      continue
    }
    const steps = []
    let cur = null
    let prefixChars = 0
    for (const l of lines) {
      if (l.type === 'request/header') {
        const hd = (l.data && (l.data.header || l.data)) || {}
        if (Array.isArray(hd.tools)) prefixChars += JSON.stringify(hd.tools).length
        continue
      }
      if (l.type === 'step/start') {
        cur = { msgs: 0, sysChars: 0, sysCount: 0 }
        steps.push(cur)
        continue
      }
      if (!cur) continue
      if (l.type === 'system/message') {
        const t = textOfMessage(l)
        cur.sysChars += t.length
        cur.sysCount += 1
        prefixChars += t.length
      } else if (l.type === 'user/message' || l.type === 'assistant/message' || l.type === 'tool/result') {
        cur.msgs += textOfMessage(l).length
      }
    }
    if (steps.length < 5) continue
    const sysSteps = []
    for (let i = 0; i < steps.length; i += 1) if (steps[i].sysCount > 0) sysSteps.push(i)
    let cum = 0
    let totalChars = 0
    for (const s of steps) {
      cum += s.msgs
      totalChars += prefixChars + cum
    }
    const sysChars = steps[sysSteps[0]].sysChars
    const appends = Math.max(0, sysSteps.length - 1)
    const carried = appends ? steps.length - sysSteps[1] : 0
    const totalTok = TOK(totalChars)
    const extraTok = TOK(sysChars * appends * carried)
    const missTok = TOK(sysChars * appends)
    const before = calcCost('deepseek-flash', { input: missTok, cacheRead: extraTok - missTok, output: 0 }, false)
    const afterTok = totalTok - extraTok
    const after = calcCost('deepseek-flash', { input: 0, cacheRead: afterTok, output: 0 }, false)
    if (before === null || after === null) continue
    rows.push({
      sid: basename(dirname(cand.f)).replace('session-', '').slice(0, 8),
      steps: steps.length,
      appends,
      totalTok,
      extraTok,
      before,
      after,
      beforeTotal: before + after,
      afterTotal: after,
    })
  }
  return rows
}

/**
 * 面板实测对账：把 `panel-runs.json`（带 sid 的真实 token）按前 8 位 sid 匹配到本次扫描的会话，
 * 给每行补 `real = {total, cacheRead, uncached, output, hit, factor}`。
 * `factor = 实测/est4`：<1 表示 est4 高估，>1 表示低估。
 */
export function attachPanel(rows, panelFile) {
  let panel = []
  try {
    panel = JSON.parse(readFileSync(panelFile, 'utf8'))
  } catch {
    panel = []
  }
  const bySid = new Map(rows.map((r) => [r.sid, r]))
  let matched = 0
  for (const p of Array.isArray(panel) ? panel : []) {
    const r = bySid.get(String((p && p.sid) || '').slice(0, 8))
    if (!r) continue
    matched += 1
    const total = Number(p.total) || 0
    r.real = {
      total,
      cacheRead: Number(p.cacheRead) || 0,
      uncached: Number(p.uncached) || 0,
      output: Number(p.output) || 0,
      hit: total ? (Number(p.cacheRead) || 0) / total : null,
      factor: r.totalTok ? total / r.totalTok : null,
    }
  }
  return { panelFile, matched }
}
