/**
 * 【私有工具】读 .ai/output/library-*，产物落 .ai/output/——私有面，不入库、不随 npm 分发。
 * 见 .git/info/exclude 与 privacy:gate。
 *
 * 把派生积木拼成一本**单文件 HTML 书**（2026-10-30）
 *
 * 为什么是单文件：用户要「双击一个文件就打开」，不能起服务器。
 * file:// 下 fetch 本地文件会被 CORS 拦，所以内容必须**内嵌**进 HTML。
 *
 * 分工（对齐 .ai/library/README.md 的分层）：
 *   - 本脚本是**工具**，进版本库；
 *   - 产物落在 .ai/ 下（gitignore），因为积木内容是用户花 token 总结的私有资料。
 *
 * 用法：
 *   node packages/core/tools/library-book.mjs [--src .ai/output/library] [--out <file>]
 *                                             [--label <书名>] [--unit <量词>]
 *   同一份资料可以有两种切法（library-build 的默认 / --by-file），各自成书：
 *     --src .ai/output/library           --label 资料书（卡片）  --unit 块
 *     --src .ai/output/library-by-file   --label 资料书（章节）  --unit 章
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BOOK_CSS } from './lib/book-style.mjs'
import { mdToHtml } from './lib/markdown.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const SRC = arg('--src', '.ai/output/library')
const OUT = arg('--out', join(SRC, 'book.html'))
const LABEL = arg('--label', '资料书')
const UNIT = arg('--unit', '块')

// ── markdown ──────────────────────────────────────────────────────────────
// 2026-11-19：渲染器移到 `lib/markdown.mjs`，与「全仓文档书」（`docs-book.mjs`）共用。
// 原先这里有一份只认卡片语法的实现；做第二本书时如果再抄一份，两份迟早对同一段
// markdown 给出不同结果，而且没有任何判据会发现。卡片体例靠 `cardClasses` 选项保留。
// 顺带补上表格与代码围栏——积木里没有，但共用件必须有。
export { mdToHtml }

/** frontmatter + 正文；没有 frontmatter 就整体当正文。 */
export function parseBlock(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]] = kv[2]
  }
  return { meta, body: text.slice(m[0].length) }
}

/** 从 INDEX.md 的表格里取 id → 组名（分组只作导航，不参与判定）。 */
export function parseGroups(indexText) {
  const map = new Map()
  let group = '未分组'
  for (const line of String(indexText).split('\n')) {
    const h = /^###\s+(.+?)（\d+\s*块）/.exec(line)
    if (h) {
      group = h[1]
      continue
    }
    const row = /^\|\s*(B\d+)\s*\|/.exec(line)
    if (row) map.set(row[1], group)
  }
  return map
}

function load() {
  if (!existsSync(SRC)) {
    console.error(`找不到目录：${SRC}`)
    process.exit(1)
  }
  const files = readdirSync(SRC).filter((f) => f.endsWith('.md') && !f.startsWith('INDEX'))
  const indexFile = join(SRC, 'INDEX.md')
  const groups = existsSync(indexFile) ? parseGroups(readFileSync(indexFile, 'utf8')) : new Map()
  const blocks = files.map((f) => {
    const { meta, body } = parseBlock(readFileSync(join(SRC, f), 'utf8'))
    return {
      id: meta.id || basename(f, '.md'),
      title: meta.title || basename(f, '.md'),
      source: meta.source || '',
      built: meta.built || '',
      group: groups.get(meta.id) || '未分组',
      chars: body.trim().length,
      html: mdToHtml(body.trim()),
    }
  })
  blocks.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return blocks
}

// 只在被当脚本跑时读目录与落盘；被 import（测试 mdToHtml / parseBlock）时全程空转。
// 为什么不包成 main()：整本书的模板有 100 多行，包进函数会把 main 撑到 153 行，
// 直接顶破结构预算（阈值 80）。模板留在模块级，守卫只圈住"读"和"写"两个动作。
const IS_MAIN = Boolean(process.argv[1] && process.argv[1].endsWith('library-book.mjs'))

const blocks = IS_MAIN ? load() : []
const grouped = []
for (const b of blocks) {
  const last = grouped[grouped.length - 1]
  if (last && last.name === b.group) last.blocks.push(b)
  else grouped.push({ name: b.group, blocks: [b] })
}
const totalChars = blocks.reduce((a, b) => a + b.chars, 0)

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${LABEL} · ${blocks.length} ${UNIT}</title>
<style>${BOOK_CSS}</style>
</head>
<body>
<aside>
  <div class="brand">
    <div class="kicker">Library</div>
    <h1>${LABEL}</h1>
    <div class="meta">${blocks.length} ${UNIT} · ${(totalChars / 10000).toFixed(1)} 万字 · ${grouped.length} 个主题</div>
  </div>
  <div class="search"><input id="q" placeholder="搜索标题或编号" autocomplete="off"></div>
  <nav id="tree"></nav>
  <div class="aside-foot">点目录跳章<br>滚轮连续读</div>
</aside>
<main><div id="bar"><i></i></div><div class="wrap" id="book"></div></main>
<script>
const DATA = ${JSON.stringify(grouped).replace(/</g, '\\u003c')};
const LONG = 6000;
// 标题与出处来自 frontmatter，理论上可能含 <，拼 innerHTML 前必须转义。
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const tree = document.getElementById('tree');
const book = document.getElementById('book');
const TOTAL = DATA.reduce((a, g) => a + g.blocks.length, 0);
let n = 0;
for (const g of DATA) {
  const h = document.createElement('div');
  h.className = 'grp';
  h.textContent = g.name;
  tree.appendChild(h);
  for (const b of g.blocks) {
    n += 1;
    const a = document.createElement('a');
    a.className = 'item';
    a.dataset.id = b.id;
    a.dataset.title = (b.title + ' ' + b.id).toLowerCase();
    a.innerHTML = '<span class="n">' + String(n).padStart(2, '0') + '</span><span class="t">' + esc(b.title) + '</span>';
    a.onclick = () => {
      document.getElementById('blk-' + b.id).scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    tree.appendChild(a);

    const art = document.createElement('article');
    art.id = 'blk-' + b.id;
    art.innerHTML =
      '<header class="ch">' +
        '<div class="no">' + String(n).padStart(2, '0') + ' / ' + String(TOTAL).padStart(2, '0') + '</div>' +
        '<h2>' + esc(b.title) + '</h2>' +
        '<div class="src">' + esc(b.id) +
          (b.source ? ' · ' + esc(String(b.source).split('#')[0]) : '') +
          ' · ' + b.chars + ' 字</div>' +
      '</header>' +
      '<div class="body">' +
        (b.chars > LONG
          ? '<details><summary>' + b.chars + ' 字</summary>' + b.html + '</details>'
          : b.html) +
      '</div>';
    book.appendChild(art);
  }
}

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

// 目录高亮：用 IntersectionObserver，比 scroll 事件省。
const links = new Map([...document.querySelectorAll('.item')].map((a) => [a.dataset.id, a]));
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of links.values()) a.classList.remove('on');
      const a = links.get(e.target.id.replace('blk-', ''));
      if (a) {
        a.classList.add('on');
        a.scrollIntoView({ block: 'nearest' });
      }
    }
  },
  { root: document.querySelector('main'), rootMargin: '0px 0px -70% 0px' },
);
document.querySelectorAll('article').forEach((el) => io.observe(el));

// 搜索：只过滤目录，不隐藏正文（免得读到一半东西消失）。
document.getElementById('q').oninput = (ev) => {
  const q = ev.target.value.trim().toLowerCase();
  for (const a of document.querySelectorAll('.item')) {
    a.style.display = !q || a.dataset.title.includes(q) ? '' : 'none';
  }
  for (const h of document.querySelectorAll('.grp')) {
    let s = h.nextElementSibling;
    let any = false;
    while (s && s.classList.contains('item')) {
      if (s.style.display !== 'none') any = true;
      s = s.nextElementSibling;
    }
    h.style.display = any ? '' : 'none';
  }
};
</script>
</body>
</html>
`

if (IS_MAIN) {
  writeFileSync(OUT, HTML)
  console.log(`已生成：${OUT}`)
  console.log(`${LABEL} · ${blocks.length} ${UNIT} · 组 ${grouped.length} · 正文 ${totalChars} 字 · 文件 ${(HTML.length / 1024).toFixed(0)} KB`)
  console.log(`双击打开即可（无需服务器）。长${UNIT}（>${6000} 字）默认折叠。`)
}
