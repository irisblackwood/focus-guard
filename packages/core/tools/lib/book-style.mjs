/**
 * 资料书的版式（2026-10-30）
 *
 * 为什么单独一个文件：这是**排版**，不是取数也不是渲染。混在 library-book.mjs 里会把
 * 那个文件顶过 400 行上限（结构异味闸门），而版式本身又确实有一百多行。
 *
 * 设计取舍：
 *   · 正文用衬线（Noto Serif / 思源宋 / 宋体），界面用无衬线——书是拿来读的，
 *     长段中文用宋体更接近纸书；目录、出处、按钮这些"零件"用黑体，界限分明。
 *   · 行长 38em ≈ 38 个汉字，比网页默认窄。中文一行超过 45 字，眼睛回行会丢行。
 *   · 三种文字颜色各司其职：正文 --ink、说明 --ink2、标注 --dim。不要多，多了就花。
 *   · 认笔记自己的三层体例（条目名 .h / 动作行 .act / 出处行 .ref）。不认的话，
 *     每条都摊成四段同样大小的字，读起来一片平——这就是"生硬"的来源。
 *   · 深色模式跟随系统，不另设开关：书是长时间看的，跟随系统才不用每次手动切。
 *
 * 这个字符串里没有反引号也没有 `${`，可以安全内嵌进 library-book 的模板。
 */
export const BOOK_CSS = `
  :root{
    --side:320px;
    --paper:#fcfaf6;--panel:#f5f1e8;--ink:#221f1c;--ink2:#4b443b;--dim:#8b8378;
    --line:#e7e0d2;--accent:#9a6a3c;--soft:#f1e7d7;
    --sans:ui-sans-serif,-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
    --serif:"Noto Serif SC","Source Han Serif SC","Songti SC",SimSun,Georgia,serif;
    --mono:ui-monospace,Consolas,"Courier New",monospace;
  }
  @media(prefers-color-scheme:dark){
    :root{--paper:#1c1a17;--panel:#161411;--ink:#eae4d9;--ink2:#c2bab0;--dim:#9a9186;
      --line:#312c25;--accent:#cc9b6b;--soft:#282219}
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{display:grid;grid-template-columns:var(--side) 1fr;background:var(--panel);color:var(--ink);
    font:17px/1.9 var(--serif);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  ::selection{background:var(--soft);color:var(--ink)}

  /* 左侧目录：书脊 */
  aside{height:100vh;overflow:auto;border-right:1px solid var(--line);
    padding:32px 0 48px;font-family:var(--sans);
    scrollbar-width:thin;scrollbar-color:var(--line) transparent}
  aside::-webkit-scrollbar{width:8px}
  aside::-webkit-scrollbar-thumb{background:var(--line);border-radius:8px}
  aside::-webkit-scrollbar-track{background:transparent}
  .brand{padding:0 26px 22px}
  .kicker{font-size:10.5px;letter-spacing:.3em;color:var(--accent);
    text-transform:uppercase;margin-bottom:10px}
  .brand h1{font-family:var(--serif);font-size:21px;line-height:1.4;margin:0 0 10px;font-weight:700}
  .brand .meta{font-size:12px;color:var(--dim);line-height:1.7}
  .search{padding:0 20px 4px}
  #q{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:8px;
    background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:13px}
  #q::placeholder{color:var(--dim)}
  #q:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--soft)}
  .grp{font-size:10.5px;color:var(--dim);margin:22px 26px 8px;letter-spacing:.18em;
    font-weight:600;display:flex;align-items:center;gap:10px}
  .grp::after{content:"";flex:1;height:1px;background:var(--line)}
  .item{display:flex;gap:10px;align-items:baseline;padding:9px 26px 9px 23px;
    color:var(--ink2);text-decoration:none;font-size:13.5px;line-height:1.5;cursor:pointer;
    border-left:3px solid transparent;transition:background .12s,color .12s}
  .item:hover{background:var(--paper);color:var(--ink)}
  .item.on{background:var(--soft);border-left-color:var(--accent);color:var(--ink);font-weight:600}
  .item .n{flex:none;width:1.7em;text-align:right;color:var(--dim);
    font:500 11px/1.7 var(--mono);font-variant-numeric:tabular-nums}
  .item.on .n{color:var(--accent)}
  /* 长标题最多两行，否则目录会被一条超长条目撑得参差不齐 */
  .item .t{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
    overflow:hidden;text-overflow:ellipsis}
  .aside-foot{margin:26px 26px 0;padding-top:16px;border-top:1px solid var(--line);
    font-size:11.5px;color:var(--dim);line-height:1.8}

  /* 右侧正文：书页 */
  main{height:100vh;overflow:auto;scroll-behavior:smooth;background:var(--paper);position:relative}
  #bar{position:fixed;top:0;left:var(--side);right:0;height:2px;z-index:20;pointer-events:none}
  #bar i{display:block;height:100%;width:0;background:var(--accent);opacity:.5;
    transition:width .12s linear}
  .wrap{max-width:38em;margin:0 auto;padding:78px 46px 180px}
  article+article{margin-top:78px;padding-top:64px;border-top:1px solid var(--line)}
  .ch{margin-bottom:30px}
  .ch .no{font:600 11px/1 var(--mono);letter-spacing:.24em;color:var(--accent);margin-bottom:14px}
  .ch h2{font-family:var(--sans);font-size:27px;line-height:1.35;margin:0 0 14px;
    font-weight:700;color:var(--ink)}
  .ch .src{font-family:var(--sans);font-size:12px;color:var(--dim);line-height:1.7;
    word-break:break-all}
  .body{text-align:justify;text-justify:inter-ideograph}
  .body p{margin:0 0 .95em}
  /* 三层体例：条目名 / 动作行 / 出处行。间距刻意不同，让一条一条能分开 */
  .body p.h{font-family:var(--sans);font-size:15.5px;line-height:1.6;font-weight:700;
    margin:2em 0 .6em;color:var(--ink)}
  .body p.act{margin:.1em 0 .35em;padding-left:1.2em;text-indent:-1.2em;color:var(--ink2)}
  .body p.ref{margin:.3em 0 1.9em;font-family:var(--sans);font-size:12px;color:var(--dim);
    letter-spacing:.01em;text-align:left}
  .body h3{font-family:var(--sans);font-size:19px;line-height:1.5;margin:2.1em 0 .8em;
    font-weight:700;color:var(--ink)}
  .body h4{font-family:var(--sans);font-size:16px;line-height:1.5;margin:1.7em 0 .6em;
    font-weight:600;color:var(--ink2)}
  .body ul,.body ol{margin:0 0 1.15em;padding-left:1.5em}
  .body li{margin:.34em 0}
  .body li::marker{color:var(--accent)}
  .body strong{font-weight:700;color:var(--ink)}
  .body blockquote{margin:1.3em 0;padding:14px 18px;background:var(--soft);border-radius:10px;
    border-left:3px solid var(--accent);color:var(--ink2);font-size:.93em;line-height:1.8;
    text-align:left}
  .body blockquote p{margin:0 0 .4em}
  .body blockquote p:last-child{margin:0}
  .body hr{border:0;width:52%;margin:2.4em auto;border-top:1px solid var(--line)}
  code{font-family:var(--mono);font-size:.86em;background:var(--soft);color:var(--ink2);
    padding:.12em .42em;border-radius:5px}
  details summary{list-style:none;display:inline-flex;align-items:center;gap:9px;cursor:pointer;
    font-family:var(--sans);font-size:12.5px;color:var(--accent);background:var(--soft);
    border:1px solid var(--line);border-radius:999px;padding:7px 16px;margin-bottom:22px;
    transition:background .12s}
  details summary:hover{background:var(--panel)}
  details summary::-webkit-details-marker{display:none}
  details summary::before{content:"展开";font-size:11px;letter-spacing:.1em;opacity:.75}
  details[open] summary::before{content:"收起"}

  /* 窄屏：目录收起，正文占满（手机上侧栏没地方放） */
  @media(max-width:900px){
    :root{--side:0px}
    body{grid-template-columns:1fr}
    aside{display:none}
    #bar{left:0}
    .wrap{padding:44px 22px 120px}
    .ch h2{font-size:23px}
  }
  /* 打印：书本来就该能打印。目录与进度条去掉，每章另起一页 */
  @media print{
    aside,#bar,#q{display:none}
    body{display:block;background:#fff}
    main{height:auto;overflow:visible}
    .wrap{max-width:none;padding:0}
    article+article{page-break-before:always;border-top:0}
  }
`
