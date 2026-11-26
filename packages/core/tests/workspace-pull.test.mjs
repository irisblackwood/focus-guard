/**
 * 卷宗从 system 前缀改 pull（2026-11-21）：fg_workspace 工具能取到卷宗文本，并已注册。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { buildWorkspaceTool, registerGateTools } = await import('../src/dsh/tools.mjs')
const { workspaceHash } = await import('../src/memory/workspace.mjs')

function workspaceFor(dir, record) {
  const hash = workspaceHash(dir)
  mkdirSync(join(dir, '.focus-guard'), { recursive: true })
  const file = join(dir, '.focus-guard', 'workspace.json')
  writeFileSync(file, JSON.stringify({ workspace_hash: hash, ...record }))
  return file
}

// 2026-11-26：记忆未竣工这件事必须让模型看见（它不读 MEMORY-4.5-PLAN）。
// 这条锁住描述里的三句边界，防止下次改文案时被顺手删掉。
test('fg_workspace 描述声明「未竣工 / 只作线索 / 需重新取证」', () => {
  const { description } = buildWorkspaceTool()
  assert.match(description, /未竣工/, description)
  assert.match(description, /只作线索/, description)
  assert.match(description, /重新取证/, description)
})

test('fg_workspace 工具返回本工作区卷宗文本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-ws-pull-'))
  try {
    const file = workspaceFor(dir, {
      // decisions 留在夹具里当**存量脏数据**：用它验证「下架后不再注入」，
      // 比删掉它更有价值（旧 workspace.json 就是这样带着一堆问句的）。
      decisions: ['本轮：把卷宗移出 system'],
      constraints: ['不要改判定'],
    })
    const prev = process.env.FG_WORKSPACE_FILE
    process.env.FG_WORKSPACE_FILE = file
    const tool = buildWorkspaceTool()
    const out = tool.execute({}, { agent: { session: { header: { cwd: dir } } } })
    assert.match(out.text, /\[FG-WORKSPACE\]/)
    assert.match(out.text, /不要改判定/)
    assert.doesNotMatch(out.text, /把卷宗移出 system/, '决策已下架（2026-11-26），存量不得注入')
    if (prev === undefined) delete process.env.FG_WORKSPACE_FILE
    else process.env.FG_WORKSPACE_FILE = prev
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('registerGateTools 注册表包含 fg_workspace', () => {
  const names = []
  const ctx = { tools: { register: (t) => names.push(t.name) } }
  const done = registerGateTools(ctx)
  assert.ok(done.includes('fg_workspace'))
  assert.ok(names.includes('fg_workspace'))
})
