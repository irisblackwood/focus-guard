/**
 * DSH 适配层的会话标识（2026-11-25）。
 *
 * 为什么这个文件存在、且为什么在 `adapters/dsh/` 而不是 `dsh/`：
 *   1. 哨兵值 `'dsh-native'` 是**宿主专属标识**，写进 `src/core/` 会被 `layering-audit`
 *      的 HOST_MARKS 判为母版泄漏；
 *   2. 而适配层（`src/adapters/`）**不得依赖宿主缝**（`src/dsh/`，`layering.test.mjs` 锁着方向）。
 *   所以唯一能同时被两边引用的位置，是适配层自己；缝层反过来引用它（seam → adapter 合法）。
 *
 * 收口记录：此前 7 个模块各写一份 `|| 'dsh-native'`，合计 15 处。分叉的代价是真实的——
 * `audit-writer` 把缺省值改成 'unknown' 时只有两处跟着改；而 `eligibility-gate` 那份
 * **连 `agent.session.header.id` 都没读**，于是红线豁免凭据在会话之间共用一个桶。
 */
import { resolveSid } from '../../core/session.mjs'

/** 会话标识取不到时的哨兵值。它不是真会话，是一句「不知道」。 */
export const UNKNOWN_SESSION = 'dsh-native'

/** 会话标识：header.id > sessionId > id > exec.sessionId > 哨兵。 */
export function sidOf(exec) {
  return resolveSid(exec, UNKNOWN_SESSION)
}
