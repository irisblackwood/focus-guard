/**
 * 仓根副本（2026-11-27，3.5.4 从 tools/mutate.mjs 抽出）。
 *
 * 抽出的理由：mutate.mjs 撞 400 行阈值；这段只做「复制」，与变异逻辑无关。
 */
import { cpSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * 副本黑名单（2026-11-27，3.5.4）。
 *
 * 原先是白名单：只复制 `packages/` 与 `package.json`。代价是**每新增一个顶层目录就静默漏一次**。
 * 测试一旦引用仓根的东西（`docs/` 下的法典、`CHANGELOG.md`、`.git` 历史），基线就红，
 * 而红的原因只报「基线测试未通过」——看不出是副本缺文件。实测 `core/risk.mjs` 因此 30 条用例失败。
 *
 * 改黑名单：除下列目录外全复制。新增顶层目录自动进副本，不需要回来改这里。
 * 排除的都是「本机状态」或「体积大且与判定无关」：`node_modules` 可由包自身解析，
 * `.focus-guard` / `.ai` 是运行时会写的东西，复制进去只会让隔离测试互相污染。
 */
const COPY_SKIP = new Set(['node_modules', '.focus-guard', '.ai', '.archify', 'coverage', 'dist', '.vs'])

/**
 * 把仓根复制成临时副本。逐顶层条目复制而不是 `cpSync(REPO, work)`——
 * 后者在目标目录已存在时的落点规则依赖实现细节，不如显式列出来得可靠。
 *
 * `repo` 可传：用例要拿一个受控夹具证明「新增顶层目录自动进副本」，
 * 而模块级的 `REPO` 是常量，不参数化就只能去改真实仓库来测。**能指到别处才测得了。**
 */
export function copyRepo(repo, dest) {
  for (const entry of readdirSync(repo, { withFileTypes: true })) {
    if (COPY_SKIP.has(entry.name)) continue
    cpSync(join(repo, entry.name), join(dest, entry.name), { recursive: true })
  }
}
