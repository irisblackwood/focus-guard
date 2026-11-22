/**
 * Markdown → HTML（tools/lib/markdown.mjs，2026-11-19）
 *
 * 零依赖，只覆盖本仓文档实际用到的语法：标题 / 列表 / 表格 / 代码围栏 /
 * 引用 / 分隔线 / 粗体 / 行内代码 / 链接。
 *
 * ## 为什么单独一份，而不是各工具各写
 *
 * 这个渲染器原先长在 `library-book.mjs` 里，只服务「资料书」的卡片体例
 * （`.h` / `.act` / `.ref` 三层）。2026-11-19 要做「全仓文档书」时，
 * 第一反应是再写一份——**那正是重复的开始**：两份渲染器迟早对同一段
 * markdown 给出不同结果，而没有任何判据会发现。
 *
 * 所以抽到这里，`library-book` 与 `docs-book` 共用同一份实现。
 * 卡片体例通过 `opts.cardClasses` 保留，不是靠第二份代码。
 *
 * ## 刻意不做
 *
 * - **不引 marked / markdown-it**：本仓零依赖是硬约束，而实际语法面很窄。
 * - **不解析 HTML 块**：文档里的 HTML 注释（豁免标记）整行跳过即可，
 *   当普通段落渲染反而会漏出一串转义乱码。
 * - **不建嵌套列表的树**：本仓排版规矩第四条明确「层级最多两层」，
 *   缩进不进 `<ul>` 内层，够读即可。
 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * 行内渲染。
 *
 * 先切行内代码再处理其余语法——否则代码里的星号会被当成粗体，
 * 而它明明在代码里。旧实现（esc → 粗体 → 代码）就有这个毛病。
 */
function inline(s) {
  return esc(s)
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return `<code>${part.slice(1, -1)}</code>`
      return part
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    })
    .join('')
}

/** `| a | b |` → ['a','b']（去首尾竖线，单元格各自行内渲染）。 */
function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => inline(c.trim()))
}

/**
 * 若第 `i` 行起是一张表，返回 `{html, end}`；否则 null。
 *
 * 判据是「本行 `|…|` **且** 下一行是分隔行」——只认单个 `|` 开头会把
 * 正文里以竖线起头的句子误判成表格。
 */
function tableAt(lines, i) {
  if (!/^\s*\|/.test(lines[i])) return null
  if (i + 1 >= lines.length || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) return null
  const head = splitRow(lines[i])
  const rows = []
  let j = i + 2
  while (j < lines.length && /^\s*\|/.test(lines[j])) {
    rows.push(splitRow(lines[j]))
    j += 1
  }
  const th = head.map((c) => `<th>${c}</th>`).join('')
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
  return { html: `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`, end: j - 1 }
}

/** 卡片体例（仅资料书）：整行只有一句粗体的 → 小标题；`→ …` → 动作行；`出处：…` → 出处行。 */
function cardClassOf(html, line) {
  if (/^<strong>[\s\S]*<\/strong>$/.test(html) && (html.match(/<strong>/g) || []).length === 1) return ' class="h"'
  if (line.startsWith('→')) return ' class="act"'
  if (/^出处[：:]/.test(line)) return ' class="ref"'
  return ''
}

/**
 * 收尾/续接三件套拆到函数外：它们只碰 `st`（`{out, list, quote}`），
 * 留在 `mdToHtml` 里会把那个函数顶过 80 行上限（结构异味闸门）。
 */
function closeList(st) {
  if (!st.list) return
  st.out.push(`<${st.list.tag}>${st.list.items.map((i) => `<li>${i}</li>`).join('')}</${st.list.tag}>`)
  st.list = null
}

function flushState(st) {
  closeList(st)
  if (st.quote) {
    st.out.push(`<blockquote>${st.quote.map((i) => `<p>${i}</p>`).join('')}</blockquote>`)
    st.quote = null
  }
}

function pushItem(st, tag, text) {
  if (!st.list || st.list.tag !== tag) {
    flushState(st)
    st.list = { tag, items: [] }
  }
  st.list.items.push(text)
}

/** 认出本行属于哪种块级元素；认不出返回 null（交给段落处理）。 */
function blockAt(line, bare) {
  if (/^#{1,6}\s/.test(line)) return { t: 'h', m: /^(#{1,6})\s+(.*)$/.exec(line) }
  // 分隔线要在列表之前判，否则 `---` 会被当成空的列表项。
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(bare)) return { t: 'hr' }
  const bq = /^>\s?(.*)$/.exec(line)
  if (bq) return { t: 'bq', m: bq }
  const ul = /^[-*]\s+(.*)$/.exec(line)
  if (ul) return { t: 'ul', m: ul }
  const ol = /^\d+\.\s+(.*)$/.exec(line)
  if (ol) return { t: 'ol', m: ol }
  return null
}

/**
 * @param {string} md
 * @param {{hShift?: number, cardClasses?: boolean}} [opts]
 *   hShift      标题降级层数（默认 1，供「书本」把 `#` 压到 `<h2>`；文档书传 0）
 *   cardClasses 是否输出 `.h` / `.act` / `.ref` 三层卡片体例（默认 true，仅 library-book 需要）
 */
export function mdToHtml(md, opts = {}) {
  const hShift = opts.hShift ?? 1
  const cardClasses = opts.cardClasses !== false
  const st = { out: [], list: null, quote: null }
  let fence = null

  const lines = String(md).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const line = raw.trimEnd()
    const bare = line.trim()

    // 代码围栏优先：围栏内的 `#` `|` `-` 都是内容，不是语法。
    const open = /^```(\S*)\s*$/.exec(bare)
    if (open) {
      if (fence === null) {
        flushState(st)
        fence = { lang: open[1], buf: [] }
      } else {
        st.out.push(`<pre><code${fence.lang ? ` class="lang-${fence.lang}"` : ''}>${esc(fence.buf.join('\n'))}</code></pre>`)
        fence = null
      }
      continue
    }
    if (fence) {
      fence.buf.push(raw)
      continue
    }

    if (!bare) {
      flushState(st)
      continue
    }
    // 纯 HTML 注释行（豁免标记）整行跳过：转义后当正文会漏出一串乱码。
    if (/^<!--[\s\S]*-->$/.test(bare)) continue

    const tbl = tableAt(lines, i)
    if (tbl) {
      flushState(st)
      st.out.push(tbl.html)
      i = tbl.end
      continue
    }

    const blk = blockAt(line, bare)
    if (blk) {
      if (blk.t === 'h') {
        flushState(st)
        const lv = Math.min(6, blk.m[1].length + hShift)
        st.out.push(`<h${lv}>${inline(blk.m[2])}</h${lv}>`)
      } else if (blk.t === 'hr') {
        flushState(st)
        st.out.push('<hr>')
      } else if (blk.t === 'bq') {
        closeList(st)
        if (!st.quote) st.quote = []
        st.quote.push(inline(blk.m[1]))
      } else {
        pushItem(st, blk.t, inline(blk.m[1]))
      }
      continue
    }

    flushState(st)
    const html = inline(line)
    st.out.push(`<p${cardClasses ? cardClassOf(html, line) : ''}>${html}</p>`)
  }
  flushState(st)
  if (fence) st.out.push(`<pre><code>${esc(fence.buf.join('\n'))}</code></pre>`)
  return st.out.join('\n')
}

