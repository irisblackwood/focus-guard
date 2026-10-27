#!/usr/bin/env node
/**
 * 条款口径审计（2026-10-27）——查「法条写了、引擎没实现、文档也没申报」的空头条款。
 *
 * 病根（2026-10-27 建，同日清完）：
 *   `RULES.md` 增补章（第十五章之一/二/三）立条 18 条，只有 4 条进了第三部分「技术映射明细」，
 *   而「未机械化条款清单」——它自称"以本表为唯一状态记载，避免空头条款被误读为已落地"
 *   ——一条也没收。14 条法条写了、技能写了、引擎零实现、清单没申报。
 *   验收用例 `acceptance:文档-实现口径对齐` 对此只断言"清单存在 + 含第六十一条"，
 *   从不检查清单是否漏报 → 漏报可以永久存在。
 *
 *   2026-10-27 逐条核实后处置完毕：5 条补映射（第七十四 / 七十六 / 七十八 / 八十 / 八十六条，
 *   其中七十八、八十条注明"仅部分款机械化"），9 条进未机械化清单（第七十七 / 七十九 /
 *   八十一 / 八十五 / 八十七 / 八十八 / 八十九 / 九十 / 九十一条）。**当前 0 条未交代。**
 *   本工具的价值从此转为**防回归**：新增条款忘了登记，它会立刻报出来。
 *
 * 本工具只报事实，不做判定（与 gate-audit 同纪律：只读、不改判定）。
 *   「未交代」= 映射表无对应 + 未机械化清单也未收。它有两种可能，方向相反：
 *     (a) 引擎确无实现 → 空头条款；(b) 引擎已实现但映射表漏写 → 文档滞后。
 *   分辨靠人，工具不猜。
 *
 * 为什么不覆盖全部条款：老条款大量属"模型行为条款"（诚实信用、保密、履职原则），
 *   引擎本就不该管，全量报会把真问题淹掉。增补章是后加的、读者最可能误以为已落地，故只查它。
 *
 * 变异测试（测试强度）**不在这里**——那件事交给 Stryker（`npm run quality:mutate`）：
 *   实测单文件 6 秒生成 51 个变异体，比手写 9 个变异体强得多。本仓保持零依赖，
 *   Stryker 经 npx 按需拉取，不进 `dependencies` / `devDependencies`。
 *
 * 用法：
 *   node packages/core/tools/quality-audit.mjs            # 明细表
 *   node packages/core/tools/quality-audit.mjs --brief    # 一行汇总（供 npm run check）
 *   node packages/core/tools/quality-audit.mjs --json
 *   node packages/core/tools/quality-audit.mjs --strict   # 有未交代时 exit 1（门禁用）
 *   node packages/core/tools/quality-audit.mjs --rules <路径>   # 对指定文件对账（测试夹具用）
 *
 * 退出码：默认恒 0（只报不改）；`--strict` 时发现未交代条款 exit 1。
 */

import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = resolve(HERE, '..')

const argv = process.argv.slice(2)

/**
 * `--rules <path>`（2026-10-27 加）：把对账对象从固定的 `docs/RULES.md` 换成任意文件。
 *
 * 起因：本工具原先只能对活文档跑，于是它的**检出用例只能断言活文档的当前状态**
 * （"这 5 条必须被报出来"）。一旦那 5 条真的被处置掉，用例就从"验证工具能检出"
 * 变成"验证文档还没修完"——两件事混在一起，改文档就会误伤测试。
 * 加这个开关后，检出用例改用夹具，活文档只留一条"全部已交代"的结论断言。
 */
const iRules = argv.indexOf('--rules')
const RULES = iRules >= 0 && argv[iRules + 1] ? resolve(argv[iRules + 1]) : join(CORE, 'docs/RULES.md')

const AS_JSON = argv.includes('--json')
/**
 * 薄输出（2026-10-27 人类判据「做个比较薄的不抢占主内容就行」）。
 * 明细表对人是好事，但接进 `npm run check` 后每次多 18 行，模型读 check 输出时全进上下文。
 * `--brief` 只给一行汇总；要定位另跑不带 brief。
 */
const BRIEF = argv.includes('--brief')
/**
 * 默认不阻断（与 gate-audit 同纪律：只报不改）。
 * `--strict` 才 exit 1——用于清完存量后开成门禁。
 * 现在开成默认阻断会让 `npm run check` 永久红：14 条未交代是修法层面的事，
 * 不该由工具替人类决定何时必须修完。
 */
const STRICT = argv.includes('--strict')

const CN = '一二三四五六七八九十百'
const CLAUSE_RE = new RegExp(`第[${CN}]+条`, 'g')
const uniqClauses = (s) => [...new Set(s.match(CLAUSE_RE) || [])]

/**
 * 重复行检测（2026-10-27 加）。
 *
 * 起因：未机械化清单里 `第四十八条` 曾**整行重复两遍**（同一句话、同一状态、同一原因）。
 * 对账工具用 `new Set` 去重，所以它永远看不见这类问题——清单看起来"收全了"，
 * 实际有一行是复制粘贴的垃圾。重复行会让读者以为两个不同事项，也会让条数统计虚高。
 *
 * 判据只看**表格首列**（`| 第X条 |`）。第一版按全文数条款号，结果把"原因"列里的
 * 交叉引用（如第八十一条那行写"可由第八条锚点规则间接约束"）误判成重复——同一类错
 * 本仓已犯过多次：**关键词计数不等于结构判定**。
 */
const ROW_CLAUSE_RE = new RegExp(`^\\|\\s*(第[${CN}]+条)`)
const countRowClauses = (s) => {
  const m = new Map()
  for (const line of s.split('\n')) {
    const hit = line.match(ROW_CLAUSE_RE)
    if (!hit) continue
    m.set(hit[1], (m.get(hit[1]) || 0) + 1)
  }
  return m
}

function clauseLedger() {
  const src = readFileSync(RULES, 'utf8')
  const iMap = src.indexOf('## 第三部分：技术映射明细')
  const iInject = src.indexOf('## 第四部分：常驻提示词')
  const iList = src.indexOf('**未机械化条款清单**（诚实申报')
  if (iMap < 0 || iInject < 0 || iList < 0) {
    throw new Error('RULES.md 结构锚点缺失（第三部分 / 第四部分 / 未机械化清单），无法对账')
  }
  const law = src.slice(0, iMap)
  const inMap = uniqClauses(src.slice(iMap, iInject))
  const inList = uniqClauses(src.slice(iList))

  const iAdd = law.indexOf('### 第十五章之一')
  if (iAdd < 0) throw new Error('未找到增补章起点（### 第十五章之一）')
  const added = law.slice(iAdd)

  // 逐条抓正文：**第X条** 开头，正文续到下一个条文或空行/标题
  const blocks = [
    ...added.matchAll(
      /^\s*[-*]\s*\*\*(第[一二三四五六七八九十百]+条)\*\*([\s\S]*?)(?=^\s*[-*]\s*\*\*第|^\s*$|^#{2,3}\s)/gm,
    ),
  ]
  const rows = blocks.map((m) => {
    const no = m[1]
    const body = m[2].replace(/\s+/g, ' ').trim()
    return { no, title: body.split('。')[0].slice(0, 40), mapped: inMap.includes(no), listed: inList.includes(no) }
  })
  const holes = rows.filter((r) => !r.mapped && !r.listed)
  // 清单里同一条款出现多次 = 重复行（映射表允许多行，故只查清单）
  const dupInList = [...countRowClauses(src.slice(iList))].filter(([, n]) => n > 1).map(([no, n]) => `${no}×${n}`)
  return { total: rows.length, rows, holes, dupInList, inMapCount: inMap.length, inListCount: inList.length }
}

const ledger = clauseLedger()

if (AS_JSON) {
  console.log(JSON.stringify(ledger, null, 2))
} else if (BRIEF) {
  // 一行给门禁。条款号不列——列了就是 14 个词，等于把细节搬回上下文
  console.log(
    `口径对账：增补章 ${ledger.total} 条，已映射 ${ledger.rows.filter((r) => r.mapped).length}，` +
      `未交代 ${ledger.holes.length}（详见 npm run quality:audit）`,
  )
} else {
  console.log(
    `增补章条款 ${ledger.total} 条；第三部分映射表提及 ${ledger.inMapCount} 个条款号；未机械化清单提及 ${ledger.inListCount} 个\n`,
  )
  console.log(`条款\t\t映射表\t未机械化清单\t状态`)
  for (const r of ledger.rows) {
    const st = r.mapped ? '已映射' : r.listed ? '已申报未机械化' : '★ 未交代'
    console.log(`${r.no}\t${r.mapped ? '✓' : '✗'}\t${r.listed ? '✓' : '✗'}\t\t${st}  ${r.title}`)
  }
  if (ledger.holes.length) {
    console.log(`\n★ 未交代 ${ledger.holes.length} 条：技术映射表无对应，未机械化清单（自称"唯一状态记载"）也未收。`)
    console.log(`  两种可能，本工具不做判定，须人工核实：`)
    console.log(`    (a) 引擎确无实现 → 空头条款，读者会误认为已自动执行；`)
    console.log(`    (b) 引擎已实现但映射表漏写 → 文档滞后，读者找不到对应实现。`)
    console.log(`  两种都要处置，但方向相反：(a) 补实现或补进清单或废止；(b) 补映射行。属修法，须批示。`)
  } else {
    console.log('\n增补章条款全部已交代。')
  }
  if (ledger.dupInList.length) {
    console.log(`\n★ 未机械化清单有重复行：${ledger.dupInList.join('、')}`)
    console.log(`  同一条款占两行，读者会误以为是两件事，条数统计也虚高。删掉多余那行。`)
  }
}
process.exit(STRICT && (ledger.holes.length > 0 || ledger.dupInList.length > 0) ? 1 : 0)
