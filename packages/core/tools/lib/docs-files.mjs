/**
 * 「哪些 Markdown 算文档」——单一出处（2026-11-26 从 `docs-core.mjs` 拆出）。
 *
 * 拆出来的直接原因：`docs-core.mjs` 已 418 行，越过 `smells` 的 400 行阈值。
 * 按本仓的既有判断（见 `docs-version.mjs` / `docs-status.mjs` 的头注释），
 * 越过阈值时**不许抬阈值**，只许拆——抬阈值等于把尺子锯短。
 *
 * 更实质的原因是：这个函数是**所有文档闸门的输入口**（`docs-lint` / `docs-status` /
 * `docs-version` / `docs-ack` / `docs-book` 都从它拿文件清单）。输入少几个文件，
 * 判据再对也等于没看。`gate-inputs.mjs` 记过同一类事故：
 * 「同一根目录、同一个 listMarkdownFiles，差 6 个文件；两次的问题条数都是 5 条，闸门一路绿。」
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// `HANDOFF.md` 是本机私有备忘（在 .git/info/exclude 里），不属于公开文档面，
// 混进来会让"文档口径"这个数字同时反映私有文件——口径不纯。
// 2026-11-26：`.workbuddy/` 同理——它是会话记忆目录（未跟踪），里面的 `memory/*.md`
// 一度被扫进 `docs/STATUS.md`（46 份里多出 1 份本机私货），换台机器就少一份。
const SKIP_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.focus-guard',
  '.ai',
  '.workbuddy',
  'self-improvement',
  'archived',
  'archive',
  'backup',
  'HANDOFF.md',
])
// 2026-10-31（3.4 D3）：`docs/archive/` 是历史证据，链接按旧路径原样保留才不失真，
// 因此归档文档整体不进 lint（不查链接/状态头）；INDEX 仍负责列出它们。

/** 遍历仓库内 Markdown（排除运行产物与归档）。 */
export function listMarkdownFiles(root) {
  // **枚举入库文件，而不是枚举磁盘上的文件**（2026-11-26）。
  //
  // `docs/STATUS.md` 是**入库的生成物**：它由本函数的输出渲染而成，又随代码一起提交。
  // 若输入是「磁盘上有什么」，本机多出的私有文档就会进表，而 CI 上的树没有它们——
  // 同一份 `STATUS.md` 在两台机器上算出两个指纹，`status-table-stale` 于 CI 必红、本地全绿。
  // 3.5.3 的发布闸正是这么红的：本地 46 份 / CI 39 份，差的 7 份全是未入库的 `docs/vault-notes/vendors/*`。
  // 判据：**生成物的输入必须可复现**——换了机器还能重算出同一张表，否则「本地绿」不保证「发得出去」。
  const tracked = trackedMarkdown(root)
  if (tracked) return tracked
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (SKIP_SEGMENTS.has(entry.name)) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.name.toLowerCase().endsWith('.md')) out.push(full)
    }
  }
  walk(root)
  return out
}

/** 入库的 Markdown；非 git 目录（`mutate` 副本、打包后的树）返回 null，交由磁盘遍历兜底。 */
function trackedMarkdown(root) {
  try {
    const raw = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return raw
      .split('\u0000')
      .filter(Boolean)
      .filter((rel) => !rel.split('/').some((seg) => SKIP_SEGMENTS.has(seg)))
      .map((rel) => join(root, rel))
      .filter((abs) => existsSync(abs))
  } catch {
    return null
  }
}
