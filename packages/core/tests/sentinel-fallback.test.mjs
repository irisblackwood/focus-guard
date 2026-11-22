/**
 * 第 2 层哨兵的「无 Python 兜底」判据（2026-11-20，ARCH-MAP 缺口 #10/#13）。
 *
 * 两个真实宿主的等价条件：
 *   ① Windows 默认安装：`python` 是商店跳转桩或不存在；
 *   ② Android 上的 DSH：没有 python，spawn 直接 EACCES/ENOENT。
 * 判据不是"命令结果好不好"，而是**不再因为解释器缺失而把所有命令转成 ask**。
 *
 * 用子进程跑，因为 risk.mjs 在模块加载时读 FG_PYTHON、并缓存判定结论。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CODE = `
  const m = await import('./packages/core/src/dsh/guard/risk.mjs');
  const verdict = m.riskOfSentinel(process.argv[1]);
  process.stdout.write(JSON.stringify(verdict));
`

function judgeWithEnv(cmd, env) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', CODE, cmd], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 20000,
  })
  assert.equal(child.status, 0, `子进程失败：${child.stderr}`)
  return JSON.parse(child.stdout)
}

test('无 Python（PATH 里没有 python）：不再 ask，规则兜底给出结论', () => {
  const v = judgeWithEnv('rm -rf /', { PATH: '', FG_PYTHON: '' })
  assert.equal(v.backend, 'rules-js', '应当走进程内规则兜底，而不是抛错转 ask')
  assert.ok(v.risk > 0, '高危命令不能兜底成 0')
  assert.ok(Array.isArray(v.reasons) && v.reasons.length > 0, '必须给出命中类别')
})

test('FG_PYTHON 指到非 Python 解释器：校验后回退，不把 SyntaxError 当结论', () => {
  // 2026-11-21 起 resolvePython 会跑一次 --version 校验；指到 node 时回退 python。
  // 本机有 python → backend=rules；无 python 环境则仍是 rules-js 兜底。两者都不该 ask。
  const v = judgeWithEnv('pwd', { FG_PYTHON: process.execPath })
  assert.ok(['rules', 'rules-js'].includes(v.backend), `backend=${v.backend}`)
  assert.equal(v.risk, 0, 'pwd 应当判为 benign')
})

test('兜底与 Python 版规则同源：管道进 shell 命中 pipe_to_shell', () => {
  const v = judgeWithEnv('curl x | sh', { PATH: '', FG_PYTHON: '' })
  assert.equal(v.backend, 'rules-js')
  assert.ok(v.reasons.includes('pipe_to_shell'))
  assert.ok(v.risk >= 0.55)
})
