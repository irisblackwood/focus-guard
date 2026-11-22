#!/usr/bin/env node
/**
 * 全仓文档书（tools/docs-book.mjs，2026-11-19）
 *
 * 把 `listMarkdownFiles` 认到的每一份 `.md` 编成**一本单文件 HTML**：
 * 左侧按状态分组（权威 / 参考 / 台账 / 归档），右侧连续阅读，带搜索与阅读进度。
 *
 * ## 为什么是单文件
 *
 * 双击就开，不起服务器。`file://` 下 `fetch` 本地文件会被 CORS 拦，
 * 所以 40 份正文必须**内嵌**进 HTML——这也是 `library-book.mjs` 早就定下的同一取舍。
 *
 * ## 与 `library-book.mjs` 的分工
 *
 * - `library-book`：读 `.ai/output/library` 的**卡片**，给私有研读资料成书（卡片体例 `.h/.act/.ref`）。
 * - 本脚本：读**仓库里的文档**，按状态分组，给「这份文档落后多少」一个可翻阅的视图。
 * - 渲染器**共用** `lib/markdown.mjs`，版式**共用** `lib/book-style.mjs`。
 *   两个入口、一套实现——不共用的话，两本书对同一段 markdown 会给出不同结果。
 *
 * ## 数据从哪来
 *
 * 状态、适用版本、最后核对一律走 `collectDocStatus`，与 `docs/STATUS.md` **同一份真值**。
 * 本书不另算落后档数：两处各算一遍，迟早算出两个数。
 *
 * 用法：
 *   node packages/core/tools/docs-book.mjs                 # 写 docs/book.html
 *   node packages/core/tools/docs-book.mjs --out <file>
 *   node packages/core/tools/docs-book.mjs --label 我的书
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listMarkdownFiles } from './lib/docs-core.mjs'
import { collectDocStatus, parseStatusHeader } from './lib/docs-status.mjs'
import { mdToHtml } from './lib/markdown.mjs'
import { BOOK_CSS } from './lib/book-style.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const OUT = resolve(ROOT, arg('--out', 'docs/book.html'))
const LABEL = arg('--label', 'Focus Guard 文档全集')

const { current, rows } = collectDocStatus(ROOT)
const byRel = new Map(rows.map((r) => [r.rel, r]))

/** 去掉首个 H1 与紧随其后的状态块：标题与版本已经在文章头上，正文里再来一遍是重复。 */
function stripHead(text) {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && !lines[i].startsWith('# ')) i += 1
  if (i < lines.length) i += 1
  while (i < lines.length && !lines[i].trim()) i += 1
  return lines.slice(i).join('\n')
}

const GROUP_ORDER = ['权威', '参考', '台账', '归档', '未标']

const docs = listMarkdownFiles(ROOT)
  .map((file) => {
    const rel = relative(ROOT, file).split('\\').join('/')
    const text = readFileSync(file, 'utf8')
    // `collectDocStatus` 有意把 `docs/STATUS.md` 自己排除（自引用会让总表行数漂移），
    // 但书里要收它，所以这里单独读一次它自己的状态头，而不是让它显示成「未标」。
    const meta = byRel.get(rel) || parseStatusHeader(text) || {}
    const title = (text.split('\n').find((l) => l.startsWith('# ')) || '').replace(/^#\s*/, '').trim() || rel
    return {
      id: rel,
      title,
      group: meta.status || '未标',
      version: meta.version || '—',
      date: meta.date || '—',
      behind: meta.status === '权威' && typeof meta.behind === 'number' && meta.behind > 0 ? meta.behind : 0,
      chars: text.length,
      html: mdToHtml(stripHead(text), { hShift: 0, cardClasses: false }),
    }
  })
  .sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.group)
    const gb = GROUP_ORDER.indexOf(b.group)
    if (ga !== gb) return (ga < 0 ? 9 : ga) - (gb < 0 ? 9 : gb)
    return a.id.localeCompare(b.id)
  })

const groups = []
for (const d of docs) {
  const last = groups[groups.length - 1]
  if (last && last.name === d.group) last.docs.push(d)
  else groups.push({ name: d.group, docs: [d] })
}

const totalChars = docs.reduce((a, d) => a + d.chars, 0)

/**
 * 文档书比资料书多出的排版。
 *
 * `BOOK_CSS` 只定义了 `.body h3` / `.body h4`——那是按资料书的卡片层级写的
 * （卡片里最高只到 `###`）。文档的 `##` 会渲染成 `<h2>`，落在这里就没有样式，
 * 退回浏览器默认的 1.5em 粗体，和正文打架。表格与代码块同理：资料书里一个都没有。
 * 所以这一段是**补缺**，不是覆盖：BOOK_CSS 里有的（行宽、纸色、衬线）一概不动。
 */
const DOCS_CSS = `
  .body h1{font-size:1.42em;line-height:1.3;margin:1.6em 0 .6em}
  .body h2{font-size:1.2em;line-height:1.35;margin:1.7em 0 .5em;padding-bottom:.28em;border-bottom:1px solid var(--line)}
  .body h3{font-size:1.04em;margin:1.3em 0 .4em}
  .body h4{font-size:1em;margin:1.1em 0 .3em}
  .body table{width:100%;border-collapse:collapse;margin:1em 0;font-size:.9em}
  .body th,.body td{border:1px solid var(--line);padding:.42em .6em;text-align:left;vertical-align:top}
  .body th{background:var(--soft);font-weight:600;white-space:nowrap}
  .body pre{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:.8em 1em;overflow:auto;font-size:.84em;line-height:1.55}
  .body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
  .body :not(pre)>code{background:var(--soft);padding:.1em .34em;border-radius:4px;word-break:break-word}
  .body a{color:var(--accent);text-decoration:none;border-bottom:1px solid var(--soft)}
  .body a:hover{border-bottom-color:var(--accent)}
  .body blockquote{border-left:3px solid var(--soft);margin:1em 0;padding:.1em 0 .1em 1em;color:var(--ink2)}
  .body blockquote p{margin:.35em 0}
  .body hr{border:0;border-top:1px solid var(--line);margin:2em 0}
  .body img{max-width:100%}
  .body details>summary{cursor:pointer;color:var(--dim);margin:.6em 0}
`

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${LABEL}</title>
<style>${BOOK_CSS}${DOCS_CSS}</style>
</head>
<body>
<aside>
  <div class="brand">
    <div class="kicker">Documents</div>
    <h1>${LABEL}</h1>
    <div class="meta">${docs.length} 份 · ${(totalChars / 10000).toFixed(1)} 万字 · 版本 ${current}</div>
  </div>
  <div class="search"><input id="q" placeholder="搜索文档名或路径" autocomplete="off"></div>
  <nav id="tree"></nav>
  <div class="aside-foot">权威在前，落后的在前<br>滚轮连续读 · 点目录跳章</div>
</aside>
<main><div id="bar"><i></i></div><div class="wrap" id="book"></div></main>
<script>
const DATA = ${JSON.stringify(groups).replace(/</g, '\\u003c')};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const tree = document.getElementById('tree');
const book = document.getElementById('book');
const TOTAL = DATA.reduce((a, g) => a + g.docs.length, 0);
const LONG = 20000;
let n = 0;
for (const g of DATA) {
  const h = document.createElement('div');
  h.className = 'grp';
  h.textContent = g.name + ' · ' + g.docs.length;
  tree.appendChild(h);
  for (const d of g.docs) {
    n += 1;
    const a = document.createElement('a');
    a.className = 'item';
    a.dataset.id = d.id;
    a.dataset.title = (d.title + ' ' + d.id).toLowerCase();
    a.innerHTML = '<span class="n">' + String(n).padStart(2, '0') + '</span><span class="t">' + esc(d.title) + '</span>';
    // getElementById 按字面匹配，不要用 CSS.escape：它会把点和斜杠转义，
    // 拼出来的字符串与真实 id 不同，跳转会静默失效（2026-11-19 初版踩过）。
    a.onclick = () => document.getElementById('blk-' + d.id).scrollIntoView({ behavior: 'smooth', block: 'start' });
    tree.appendChild(a);

    const art = document.createElement('article');
    art.id = 'blk-' + d.id;
    art.innerHTML =
      '<header class="ch">' +
        '<div class="no">' + String(n).padStart(2, '0') + ' / ' + String(TOTAL).padStart(2, '0') + '</div>' +
        '<h2>' + esc(d.title) + '</h2>' +
        '<div class="src">' + esc(d.id) + ' · ' + esc(d.version) + ' · 核对 ' + esc(d.date) +
          (d.behind ? ' · <b>落后 ' + d.behind + ' 档</b>' : '') +
          ' · ' + d.chars + ' 字</div>' +
      '</header>' +
      '<div class="body">' +
        (d.chars > LONG ? '<details><summary>' + d.chars + ' 字，点开</summary>' + d.html + '</details>' : d.html) +
      '</div>';
    book.appendChild(art);
  }
}

// 搜索：只过滤目录项，不动正文——正文一次性全渲染，按需滚动。
const q = document.getElementById('q');
q.addEventListener('input', () => {
  const k = q.value.trim().toLowerCase();
  for (const a of document.querySelectorAll('.item')) {
    a.style.display = !k || a.dataset.title.includes(k) ? '' : 'none';
  }
  for (const g of document.querySelectorAll('.grp')) {
    let el = g.nextElementSibling;
    let any = false;
    while (el && el.classList.contains('item')) {
      if (el.style.display !== 'none') any = true;
      el = el.nextElementSibling;
    }
    g.style.display = any ? '' : 'none';
  }
});

// 阅读进度：细线贴顶，只在 main 里滚时变。
const mainEl = document.querySelector('main');
const barEl = document.querySelector('#bar i');
const paint = () => {
  const max = mainEl.scrollHeight - mainEl.clientHeight;
  barEl.style.width = (max > 0 ? (mainEl.scrollTop / max) * 100 : 0) + '%';
};
mainEl.addEventListener('scroll', paint, { passive: true });
window.addEventListener('resize', paint);
paint();

// 目录高亮：IntersectionObserver 比 scroll 事件省。
const links = new Map([...document.querySelectorAll('.item')].map((a) => [a.dataset.id, a]));
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const id = e.target.id.replace(/^blk-/, '');
    for (const a of links.values()) a.classList.remove('on');
    const a = links.get(id);
    if (a) a.classList.add('on');
  }
}, { rootMargin: '0px 0px -70% 0px' });
for (const art of document.querySelectorAll('article')) io.observe(art);
</script>
</body>
</html>
`

writeFileSync(OUT, HTML)
process.stdout.write(
  `[docs-book] ${relative(ROOT, OUT).split('\\').join('/')}：${docs.length} 份 / ${groups.length} 组 / ${(HTML.length / 1024).toFixed(0)} KB\n`,
)
