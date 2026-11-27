import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countTasks, indexHeadings } from '../tools/docs-refs.mjs'

/**
 * 这两条判据各自错过一次，都是首跑就报出来的假数字，所以钉在这里。
 * 不写「可能错」的输入（比如空文档、畸形表格）——那不是发生过的错。
 */

test('countTasks：层级归并认标题层级，不认编号深度', () => {
  // `### 1.7.1` 下面挂 `#### 3.5.4` 是另一套编号。按编号深度出栈会把 1.7.1 弹掉，
  // 于是「§1.7 声明 42 条，实际 0 条」——首跑的原样错误。
  const lines = [
    '### 1.7 测试债务',
    '| 1 | 3.5.4 | 先让尺子能用 |', // 定档表：长得像任务行，但不是
    '### 1.7.1 每档任务拆解',
    '#### 3.5.4 · 先让尺子能用',
    '| 1 | 甲 |',
    '| 2 | 乙 |',
    '#### 3.5.5 · 补零覆盖',
    '| 1 | 丙 |',
  ]
  const counts = countTasks(lines)
  // §1.7 与 §1.7.1 说的是同一批任务，两处都必须答 3；
  // §1.7 那张定档表不算任务，算进去就是 4。
  assert.equal(counts.get('1.7'), 3)
  assert.equal(counts.get('1.7.1'), 3)
})

test('indexHeadings：`2A.` 这种带字母的节号也进编号集', () => {
  // INSTALL.md 用 `### 2A. 原生插件`，README 写 `[INSTALL.md](INSTALL.md) §2A`。
  // 不认字母就会被报成「INSTALL.md 里没有 §2」。
  const { ids } = indexHeadings(['### 2A. 原生插件（推荐）', '### 2B. 官方桥'])
  assert.ok(ids.has('2A'))
  assert.ok(ids.has('2B'))
})
