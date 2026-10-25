/**
 * 重复被拦 → 换策略提示（2026-10-22，人类反馈"工作流没做好"）
 *
 * 实测浪费：8 任务那轮被拦 7 条后，模型仍**重试同一条调用**，多出 4 个 step（每 step 都重读全上下文）。
 * 现有理由只写"请先读/请补 include"，没告诉它"同一条重试多少次都不会放行"。
 *
 * 本模块只做两件事：
 *   ① 按「会话 + 工具 + 参数」计数被拦次数；
 *   ② 第 2 次起改写理由：明确"重试无效"，并按闸的类型给出**换法**（不是重复原话）。
 * 不改任何判定（allow/deny 不变），只改模型看到的文字。
 */

const MAX_TRACK = 200
import { detectSearchBackends, retrievalHint } from './search-hints.mjs'
const counts = new Map()
// 会话级被拦总数：≥5 次时给一句"先停手"的提示（实测被拦后越试越乱）。
const sessionDenies = new Map()
const SESSION_HINT_AT = 5

function sidOf(exec) {
  return String((exec && (exec.sessionId || (exec.agent && (exec.agent.sessionId || exec.agent.id)))) || '-')
}

function keyOf(exec) {
  const tool = String((exec && exec.name) || '')
  let args = ''
  try {
    args = JSON.stringify((exec && exec.arguments) || {})
  } catch {
    args = ''
  }
  const sid = (exec && (exec.sessionId || (exec.agent && (exec.agent.sessionId || exec.agent.id)))) || '-'
  return `${sid}::${tool}::${args.length > 500 ? args.slice(0, 500) : args}`
}

/** 按闸的类型给"换法"——必须是**另一条路**，不是同一句话再说一遍。 */
export function altHint(reason) {
  const r = String(reason || '')
  // 整读类：提示按本机可用的检索后端给（xerj→rg→fd→无）。
  if (/整文件闸|整读/.test(r)) return retrievalHint(detectSearchBackends())
  if (/Grep 未收窄|体积刺客/.test(r)) return 'Grep 补 `include`（如 `**/*.mjs`）收窄，或先按文件名定位再读指定文件。'
  if (/取证|未读/.test(r)) return '先用 read 读目标文件（或它所在目录的清单），再重试改动；不要连着改多个没读过的文件。'
  if (/fg_apply|申请授权/.test(r)) return '调用 `fg_apply`（purpose/scope 必填）一次性申请；同一条命令直接重试只会再次被拒。'
  if (/委托池用尽/.test(r)) return '委托额度已用尽：主会话自己收敛，或请人类批示『追加额度』。'
  if (/不可逆|人类批准/.test(r)) return '等人类在审批卡片上点批准；或改用可逆做法（先备份/小范围）。'
  if (/绝对红线/.test(r)) return '红线不接受重试：换等价的安全做法；若确认是误判（危险片段只是被引用的数据），用 `fg_appeal` 提交反例锚点。'
  return '换一条路径：先取证/收窄范围，或改工具（同一条调用重复提交不会放行）。'
}

/**
 * 判定返回 deny 时调用：返回改写后的 decision（或原样返回）。
 * @param {object} exec 工具执行上下文
 * @param {object} decision {kind, reason}
 * @param {(msg: string) => void} [warn]
 */
export function augmentDeny(exec, decision, warn) {
  if (!decision || decision.kind !== 'deny') return decision
  const key = keyOf(exec)
  const n = (counts.get(key) || 0) + 1
  if (counts.size > MAX_TRACK && !counts.has(key)) counts.clear()
  counts.set(key, n)

  const sid = sidOf(exec)
  const total = (sessionDenies.get(sid) || 0) + 1
  sessionDenies.set(sid, total)

  let out = decision
  if (n >= 2) {
    const base = String(decision.reason || '')
    if (!base.includes('[重复被拦')) {
      const text = `[重复被拦 ×${n}] 同一条调用不会因为重试而放行。换法：${altHint(base)}\n—— 原始理由：${base}`
      try {
        warn?.(`重复被拦 ×${n}：${String((exec && exec.name) || '')}`)
      } catch {
        /* 日志失败不影响判定 */
      }
      out = { ...decision, reason: text, repeat: n }
    } else {
      out = { ...decision, repeat: n }
    }
  }
  // 会话级：拦得多说明方向错了，给一句"先停手"（只加提示，不改变判定）。
  if (total >= SESSION_HINT_AT && !String(out.reason || '').includes('[本回合被拦')) {
    const reason = `${String(out.reason || '')}\n[本回合已被拦 ${total} 次] 先停手：用一段话总结现状（已确认的事实 / 卡在哪 / 下一步），再继续；不要靠连续试错推进。`
    out = { ...out, reason }
  }
  return out
}

/** 测试用：清空计数。 */
export function resetRepeatCounts() {
  counts.clear()
}
