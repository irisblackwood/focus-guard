/**
 * 文档扫描范围（2026-11-27）
 *
 * `docs:drift` 与 `docs:refs` 必须扫**同一份清单**：一个查「文档里写死的命令/路径是否真实」，
 * 一个查「文档里的交叉引用是否指得到」。口径一旦分叉，同一份文档会出现
 * 「drift 说没问题、refs 说有问题」——两边都自称权威，读者不知道该信谁。
 *
 * 所以清单只在这里定义一次。谁再抄一份，`smells` 的重复块棘轮会当场报出来。
 */
import { readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 本文件在 `packages/core/tools/lib/`，比 `tools/*.mjs` 深一层——少一级就指到 `packages/core`，
// 扫描面当场变空，闸门却照样报绿（「扫描 0 份文档 → 问题 0 条」）。
export const ROOT = resolve(HERE, '..', '..', '..', '..')

/** 递归收集 md：归档与 vault 笔记是历史材料，不受当前事实约束。 */
export function walkDocs(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'archive' || e.name === 'vault-notes' || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walkDocs(p, out)
    else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}

/** 扫描面：docs 树 + 四份入口文档；`HANDOFF-*` 是过程台账，不参与当前事实判定。 */
export function docScope() {
  return [
    ...walkDocs(join(ROOT, 'docs')),
    ...walkDocs(join(ROOT, 'packages/core/docs')),
    join(ROOT, 'README.md'),
    join(ROOT, 'INSTALL.md'),
    join(ROOT, 'packages/core/README.md'),
    join(ROOT, 'packages/core/README.zh-CN.md'),
  ].filter((f) => existsSync(f) && !/HANDOFF-/.test(f))
}
