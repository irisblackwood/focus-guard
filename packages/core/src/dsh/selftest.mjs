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

console.warn('== 测试 A：拦截 ==')
{
  const gate = await run({ name: 'bash', arguments: { command: 'rm -rf ./test-dir' } })
  check('rm -rf 被拒', gate.kind === 'deny', JSON.stringify(gate))
  check('理由模型可见且含 focus-guard', typeof gate.reason === 'string' && gate.reason.includes('focus-guard'))
}
{
  const gate = await run({ name: 'bash', arguments: { command: 'cd /tmp && rm -fr build/' } })
  check('rm -fr 变体被拒', gate.kind === 'deny')
}
{
  const gate = await run({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force ./x' } })
  check('非 rm 命令不受本插件管辖（阶段一范围外，交 guard.mjs 特征库）', gate.kind === 'allow')
}

console.warn('== 测试 B：放行 ==')
{
  const gate = await run({ name: 'bash', arguments: { command: 'ls -la' } })
  check('ls -la 零打扰放行', gate.kind === 'allow')
}
{
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
