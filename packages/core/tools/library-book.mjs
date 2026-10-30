/**
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

const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const SRC = arg('--src', '.ai/output/library')
const OUT = arg('--out', join(SRC, 'book.html'))
const LABEL = arg('--label', '资料书')
const UNIT = arg('--unit', '块')

// ── markdown：只覆盖积木实际用到的语法 ────────────────────────────────────
// 实测（28 块 5.7 万字）：无序列表 728、有序列表 60、### 小标题 23、粗体 164；
// 表格 0、代码块 0。所以不引依赖，写这几种就够。
// 2026-10-30 补 `>` 引用与 `---` 分隔线：按文件切（章节版）会保留每份资料开头的
// 来源说明，那几行正是 `>` 引用；卡片版按 `##` 切时整段被丢掉，所以以前没暴露。
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

export function mdToHtml(md) {
  const out = []
  let list = null
  let quote = null
  const flush = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`)
      list = null
    }
    if (quote) {
      out.push(`<blockquote>${quote.map((i) => `<p>${i}</p>`).join('')}</blockquote>`)
      quote = null
    }
  }
  for (const raw of String(md).split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flush()
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      const lv = Math.min(6, h[1].length + 1)
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`)
      continue
    }
    // 分隔线：必须在列表之前判，否则 `---` 会被当成空的列表项
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flush()
      out.push('<hr>')
      continue
    }
    const bq = /^>\s?(.*)$/.exec(line)
    if (bq) {
      if (list) {
        out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`)
        list = null
      }
      if (!quote) quote = []
      quote.push(inline(bq[1]))
      continue
    }
    const ul = /^[-*]\s+(.*)$/.exec(line)
    if (ul) {
      if (!list || list.tag !== 'ul') {
        flush()
        list = { tag: 'ul', items: [] }
      }
      list.items.push(inline(ul[1]))
      continue
    }
    const ol = /^\d+\.\s+(.*)$/.exec(line)
    if (ol) {
      if (!list || list.tag !== 'ol') {
        flush()
        list = { tag: 'ol', items: [] }
      }
      list.items.push(inline(ol[1]))
      continue
    }
    flush()
    out.push(`<p>${inline(line)}</p>`)
  }
  flush()
  return out.join('\n')
}

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
<style>
  :root{--bg:#faf9f7;--panel:#f3f1ec;--ink:#242220;--dim:#6b6660;--line:#e2ded6;--accent:#8a5a2b;--mark:#fff3d6}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{display:flex;background:var(--bg);color:var(--ink);
    font:16px/1.85 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  aside{width:300px;flex:none;height:100vh;overflow:auto;background:var(--panel);
    border-right:1px solid var(--line);padding:18px 14px 60px}
  aside h1{font-size:15px;margin:0 0 4px;letter-spacing:.02em}
  aside .meta{font-size:12px;color:var(--dim);margin-bottom:14px;line-height:1.6}
  #q{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;
    background:#fff;font:inherit;font-size:13px;margin-bottom:14px}
  #q:focus{outline:2px solid #d9c9ad;border-color:#d9c9ad}
  .grp{font-size:12px;color:var(--dim);margin:16px 0 6px;letter-spacing:.06em;
    text-transform:uppercase;font-weight:600}
  .item{display:block;padding:5px 8px;border-radius:5px;color:var(--ink);text-decoration:none;
    font-size:13.5px;line-height:1.45;cursor:pointer;border-left:2px solid transparent}
  .item:hover{background:#eae6dd}
  .item.on{background:#e6dfd0;border-left-color:var(--accent);font-weight:600}
  .item .n{color:var(--dim);font-variant-numeric:tabular-nums;margin-right:6px;font-size:11.5px}
  main{flex:1;height:100vh;overflow:auto;scroll-behavior:smooth}
  .wrap{max-width:760px;margin:0 auto;padding:48px 40px 140px}
  article{padding:26px 0 34px;border-bottom:1px solid var(--line);scroll-margin-top:24px}
  article:last-child{border-bottom:0}
  article h2{font-size:21px;margin:0 0 6px;letter-spacing:.01em}
  .src{font-size:11.5px;color:var(--dim);margin-bottom:16px;word-break:break-all}
  article h3{font-size:17px;margin:26px 0 10px;color:#3a342e}
  article h4{font-size:15px;margin:20px 0 8px;color:#4a443d}
  article blockquote{margin:0 0 16px;padding:2px 0 2px 14px;border-left:3px solid #d9c9ad;
    color:#5a544c;font-size:14.5px;line-height:1.7}
  article blockquote p{margin:0 0 6px}
  article hr{border:0;border-top:1px solid var(--line);margin:22px 0}
  article p{margin:0 0 12px}
  article ul,article ol{margin:0 0 14px;padding-left:22px}
  article li{margin:0 0 7px}
  article strong{color:#1c1a18}
  code{background:#efece5;padding:1px 5px;border-radius:4px;font-size:.9em;
    font-family:ui-monospace,Consolas,monospace}
  .long{font-size:12px;color:var(--accent);margin-bottom:10px}
  details summary{cursor:pointer;font-size:13px;color:var(--accent);margin-bottom:12px}
  mark{background:var(--mark);padding:0 2px}
  .hint{position:fixed;right:20px;bottom:16px;font-size:12px;color:var(--dim);
    background:#fff;border:1px solid var(--line);border-radius:20px;padding:6px 14px}
  @media(max-width:860px){aside{display:none}.wrap{padding:28px 20px 100px}}
</style>
</head>
<body>
<aside>
  <h1>${LABEL}</h1>
  <div class="meta">${blocks.length} ${UNIT} · ${(totalChars / 10000).toFixed(1)} 万字<br>${grouped.length} 个主题</div>
  <input id="q" placeholder="搜索标题…" autocomplete="off">
  <nav id="tree"></nav>
</aside>
<main><div class="wrap" id="book"></div></main>
<div class="hint">← 点目录翻页 · 滚轮连续读</div>
<script>
const DATA = ${JSON.stringify(grouped).replace(/</g, '\\u003c')};
const LONG = 6000;
// 标题与出处来自 frontmatter，理论上可能含 <，拼 innerHTML 前必须转义。
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const tree = document.getElementById('tree');
const book = document.getElementById('book');
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
    a.innerHTML = '<span class="n">' + String(n).padStart(2, '0') + '</span>' + esc(b.title);
    a.onclick = () => {
      document.getElementById('blk-' + b.id).scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    tree.appendChild(a);

    const art = document.createElement('article');
    art.id = 'blk-' + b.id;
    art.innerHTML =
      '<h2>' + esc(b.title) + '</h2>' +
      '<div class="src">' + esc(b.id) + (b.source ? ' · ' + esc(b.source) : '') + ' · ' + b.chars + ' 字</div>' +
      (b.chars > LONG
        ? '<details><summary>这块很长（' + b.chars + ' 字），点击展开</summary>' + b.html + '</details>'
        : b.html);
    book.appendChild(art);
  }
}

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
