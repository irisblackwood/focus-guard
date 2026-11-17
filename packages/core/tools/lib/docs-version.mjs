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
 * - **适用版本**（状态头）：该文最后核对时对应的版本，是**滞后标记**，允许落后——
 *   但不得落后于已推送版本（`checkReadmeVersionFace` 兜这一层）。强行拉平到在飞版本
 *   同样是逼文档宣称没做过的核对，那是旧判据逼文档说谎的老毛病。
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

/** 对外展示的三份 README：根门面 + npm 包页（英文 / 中文）。 */
const README_FACE_FILES = ['README.md', 'packages/core/README.md', 'packages/core/README.zh-CN.md']

/** 树里的版本（`packages/core/package.json`）；读不到返回 null——不假红。 */
function treeVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).version || null
  } catch {
    return null
  }
}

/**
 * 对外展示的版本号必须是**当下真值之一**：已推送（`PUBLISHED_MAX`）或树里的清单版本。
 *
 * **为什么不是一个值**：根 README 是门面，盯已推送；包 README 是 npm 页，描述树里这份代码，
 * 允许写清单版本。两者都合理，但都必须是当下的号——落后两版以上的号既不是"已发布"，
 * 也不是"在飞"，只说明这份文件没人看过。
 *
 * **为什么扩到包 README（2026-11-17）**：此前只读根 `README.md`，于是
 * `packages/core/README.md` 的「运行面增量」一直写着「版本号仍记 `3.0.6`」——
 * 实际已到 3.5.0，差 9 个版本，无人发现。**最该被检查的那份（npm 页）恰好没进判据。**
 */
export function checkReadmeVersionFace(root, published = publishedMax(root)) {
  if (!published) return []
  const tree = treeVersion(root)
  const allowed = new Set([published, tree].filter(Boolean))
  const findings = []
  for (const rel of README_FACE_FILES) {
    let text = ''
    try {
      text = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    const shown = []
    const badge = text.match(/badge\/version-(\d+\.\d+\.\d+)/)
    if (badge) shown.push({ where: `${rel} badge`, value: badge[1] })
    const head = text.match(/适用版本\s*(\d+\.\d+\.\d+)/)
    if (head) shown.push({ where: `${rel} 状态头`, value: head[1] })
    for (const s of shown) {
      if (allowed.has(s.value)) continue
      findings.push({
        rule: 'version-face-stale',
        file: s.where,
        line: 1,
        detail: `${s.value} 既非已推送 ${published}，也非清单 ${tree ?? '(读不到)'}`,
      })
    }
  }
  return findings
}
