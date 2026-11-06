/**
 * 版本断言句的判据：正文里「当前是哪个版本」必须等于已发布版本。
 *
 * 为什么单列一个文件：`docs-core.mjs` 已到 392 行（阈值 400），
 * 再塞一条规则就破线；而破线之后最容易做的事就是抬阈值，那是把尺子锯短。
 * 拆出来的代价只有一行 import，收益是这条规则以后能单独改、单独测。
 *
 * 起因：根 `README.md` 开头已改成 3.3.2，结尾仍写着「当前 **v3.2.1**」；
 * `packages/core/README*.md` 整份停在 3.0.8，还附一句「repo is 3.0.8, not yet released」。
 * 旧判据只盯 badge 与状态头，管不到正文——**门牌改了，屋里没改**。
 *
 * 与「适用版本」的区别，别混为一谈：
 * - **当前版本**（本规则）：读者据此决定装哪个版本，必须等于已发布版本。
 * - **适用版本**（状态头）：该文最后核对时对应的版本，是**滞后标记**，允许落后。
 *   强行拉平等于逼文档宣称没做过的核对——那正是旧判据逼文档说谎的老毛病。
 *
 * 不含 `CHANGELOG.md`：历史条目里的「当前」指当时，改写历史等于篡改证据。
 * 含 `SKILL.md`：那份文件是喂给模型的，写错版本比 README 写错更危险。
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { listMarkdownFiles, publishedMax } from './docs-core.mjs'

const VERSION_CLAIM_RES = [
  [/当前(?:版本)?\s*[*`]*v?(\d+\.\d+\.\d+)/g, '当前'],
  [/Currently\s*[`*]*(\d+\.\d+\.\d+)/g, 'Currently'],
  [/(?:repo is|本仓为)\s*[`*]*(\d+\.\d+\.\d+)/g, '本仓'],
]

/** 扫描面：仓库门面、各包 README、技能正文、`docs/`（排除归档与外部摘录）。 */
function inScope(rel) {
  if (rel === 'README.md') return true
  if (/^packages\/[^/]+\/README[^/]*\.md$/.test(rel)) return true
  if (/^packages\/[^/]+\/skills\/.+\.md$/.test(rel)) return true
  if (!rel.startsWith('docs/')) return false
  return !rel.startsWith('docs/archive/') && !rel.startsWith('docs/vault-notes/')
}

export function checkVersionClaims(root, published = publishedMax(root)) {
  const findings = []
  if (!published) return findings
  for (const abs of listMarkdownFiles(root)) {
    const rel = relative(root, abs).split('\\').join('/')
    if (!inScope(rel)) continue
    let text = ''
    try {
      text = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    text.split(/\r?\n/).forEach((line, i) => {
      for (const [re, label] of VERSION_CLAIM_RES) {
        for (const m of line.matchAll(re)) {
          if (m[1] === published) continue
          findings.push({
            rule: 'version-claim-stale',
            file: rel,
            line: i + 1,
            detail: `${label} ${m[1]} ≠ 已发布 ${published}`,
          })
        }
      }
    })
  }
  return findings
}
