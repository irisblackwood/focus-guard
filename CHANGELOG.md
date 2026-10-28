# 变更记录（CHANGELOG）

> **受众口径**（2026-10-27 人类批示，全文见 `docs/RELEASE-POLICY.md` 第一节）
> - 本文件是**发布记录**。`fix(...)` 前缀只表示「这一条改的是缺陷」，**不表示用户已受影响**。
> - 「修复」二字仅用于**已对外分发版本**里的缺陷。开发期发现并处理掉的缺陷，正文写「某某改为…／收敛为…／加固…」，不写「修复某某问题」——那会让读者去核对一个自己不可能踩到的坑。
> - 段首标 `影响面：开发期` 的版本段，表示该段全部条目都没有已发布用户。
> - 内部台账 `docs/HANDOFF-*.md` 不受此限，「修复」照写（那是开发过程记录，抹掉就等于丢失教训）。

## 3.2.1 · 2026-10-28

> 版本策略：3.2.0 之后 fix/feat 累计 **1 条** → 未满 10，走补丁号。
> 本版主题：**插件工具只读口修复 + 结构债清理 + 文档排版归一**。
> 发布状态：**未推送**（GitHub `main` 停在 `3.2.0`，2026-10-27）；npm 未发布、未打 tag。
> 影响面：`plugin_manager` 只读调用被拦是 **3.2.0 已发布**的行为；其余两条是内部结构与文档，不改判定。

### 闸门行为

- fix(gate): **`plugin_manager` 只读动作不再被当成"改动类无路径"**
  - **病根**：`list_plugins` 没有 `file_path`，被取证闸按"改动类无可解析路径"挡死；`install_bundle` 的 `target`（包名）被当文件路径，反而放行。
  - **改法**：母版加动作级只读注册（`registerReadOnlyActions` / `isReadOnlyCall`），适配层登记三个 `list_*`；取证链改用 `isMutatingInvocation(tool, args)`。
  - **测试**：`mutation-classify` +2 条；selftest 抓回一处 fail-open 回归（`exec.arguments` 是抛错 getter 时异常逃出判定链）。

### 结构

- refactor(dsh): **结构异味 27 → 8，健康分 79 → 93**〔开发期〕
  - **拆分**：`seams` 498 → 137 行（拆 4 个模块）、`preGuard`/`stopGuard` 分段 helper、`volume`/`runtime`/`evidence`/`postProgress`/`compactionWatch` 抽函数。
  - **工具**：`source-text` 拆 `scanQuoted`/`scanRegex`/`blankSpan`；`library-build` 拆 `buildTable`/`renderIndex`。
  - **棘轮**：`smells` 28 → 8、`health` 79 → 93，只许降不许升。
  - **验证**：`npm run check` exit 0、524/524；`health`/`smells`/`lint` 的 `--strict` 均 exit 0。

### 文档

- docs(changelog): **全 21 段重排，并修掉 16 段从未被审计的盲区**〔开发期〕
  - **改前**：235 条里 134 条 >120 字，条目均 275、最长 529；段内把背景/原因/改动/测试揉成一段。
  - **改后**：一条结论 + `**标签**：` 子项；235 条全部 ≤120，最长 120；子项 117 → 约 500。
  - **盲区**：`splitVersions` 要求标题带日期，而 3.0.6 及更早的 16 段没有日期 → 从未被解析，"零违规/棘轮"一直空转；改为日期可选后 21 段全审，棘轮 753 → 120。
- docs: 三处失效的 `../CHANGELOG.md` 相对链接改为 `../../../CHANGELOG.md`；README / ARCH-MAP 的锚点随拆分归一。

## 3.2.0 · 2026-10-27

> 版本策略：3.1.0 之后累计 **17 条** fix/feat → 远超阈值，升次版本。
> 本版主题：**质量门自证 + 工具链内置化**（先把尺子量准，再量代码）。
>
> 发布状态：**已推送 GitHub `main`**（`32887bf`，2026-10-27）；npm 未发布、未打 tag。
> 标 `〔开发期〕` 的条目，缺陷只存在于当天新造的工具/测试，读者无需核对自己是否受影响；
> 未标的条目修的是**已发布版本**里的问题。

### 闸门行为

- fix(gate): **抽查B 默认只留痕，不再打断**
  - **原因**：拒绝理由原文是「重试即放行」——不核对内容、不要求声明，模型最理性的反应就是原样重试。
  - **代价**：每拒一次多一次工具往返（≥15k 前缀 + 输出），收益为 0。
  - **依据**：审计 10-06~10-26 共 6230 行，`random-fuse` 命中 61 次，全集中在 1 个长会话。
  - **改动**：保留 `fuseOps`/`fuseNextAt` 计数、post 侧审计行、`randomFusePending` 状态；pre-execute 只清 pending。
  - **回退**：`FG_RANDOM_FUSE_BLOCK=1` 恢复旧语义。
  - **测试**：`random-fuse.test.mjs` r3 双断言（默认放行 / 开关下拒一次）。
- fix(gate): **熔断只活一步 + 对模型不可见**（两个缺陷同源）
  - **缺陷①**：`agent/pre-step` 每步都触发，而回合重置无条件写 `fused: stopOrdered`，熔断下一步就被清掉。
  - **实测**：turn 128 在 step 19 熔断，step 20 起 `eff` 仍 200→206、`inv` 787→793，白走 **16 步**；turn 130 白走 18 步。
  - **改法①**：只在 `turn` 变化时重置 `fused`（`lastTurn` 记回合号）；其余字段仍按步重置，`lastSig`/`lastInput` 不动以免放大停滞误判。
  - **缺陷②**：熔断理由只进 `warn()`，模型要等自己尝试写才被拒——熔断对它完全隐形。
  - **改法②**：新增 `constants.FUSE_NOTICE`，`index.js` 装配缝在熔断期间追加 `focus-guard-fuse` 段（固定文案 → 前缀只变一次，不抖动）。
  - **测试**：`fuse-lifecycle.test.mjs` 4 条（同回合不清 / 换回合才清 / 停止令仍生效 / 提示段只在该出现时出现）。
  - **未改法典**：① 是恢复「熔断只读放行」的本意（原先根本没生效），② 是让模型看见既有判定。
- fix(audit): **熔断审计重复记账**
  - **症状**：`stallVerdict` 判 `stalledStreak >= 3`，而熔断后 `stalledStreak` 不清零 → 越线后每次无效调用都再写一条 `stall-fuse`。
  - **实测**：10-18 07:58:25~07:59:01 **一秒内写了 17 条**（连续 3/4/5/…/19 次），1 次熔断记成 17 次；硬上限那条同会话写了 61 条。
  - **改动**：只在「从未熔断 → 熔断」的跃迁点记账，重复期间静默。判定与执法行为不变，只修日志。
  - **测试**：`postProgress.test.mjs` 2 条（6 次调用 → 1 行；硬上限 4 次调用 → 1 行）。
  - **影响**：此前「87 次熔断」这类口径需按新口径重算（虚高）；「61 次抽查B」是真实拒绝，不受影响。
- fix(gate): 〔开发期〕**变异测试闸门 `break: null` → `80`**（推翻当天上午的判断）
  - 原理由是「分数低不阻断，用存活变异体清单人工判断」。当天判定站不住：**一个永不阻断的闸门等于没有闸门**，正是「质量门没用」的同一个病。
  - 测试断言同步从 `assert.equal(break, null)` 改为「必须是 `[low, high]` 区间内的数字，否则闸门永远不响」。
- docs(rules): **抽查B 条款与实现对齐**
  - `RULES.md` 第 91 行（第三十五条(二)）删「命中后对下一次变更型调用拒一次」，改为「消费时不打断，只清挂起标记」，并写明理由。
  - 第 289 行技术映射表同步。**这是纠错不是立法**——文档描述的机制已不存在。

### 工具链内置化（零依赖）

- feat(tools): **内置四件，完成「无依赖」**
  - **先查准缺口**：`dependencies`/`devDependencies` 本来就全空、无 `node_modules`，依赖层面早已零依赖。真正要换的只有两处——`quality:mutate` 走 `npx` 拉 Stryker、三个第三方审计工具只在临时目录跑过从未进仓。
  - **新增**：`tools/lint.mjs`（5 条房规规则，替代 ESLint）、`tools/smells.mjs`（文件/函数/嵌套三指标）、`tools/health.mjs`（四维加权健康分）、`tools/mutate.mjs`（抽样变异）。
  - **共用件**：判定逻辑抽到 `tools/lib/`——`health-core.mjs`（分层/可达性分类/加权计分）、`import-graph.mjs`（import 图，health 与 mutate 共用）。同一段逻辑写两遍必然分叉，本仓已栽过一次。
  - **首跑数字**：房规 131 文件 54 条（**全在已封存 `hooks/`**，活跃层 0）、结构源文件 28 条（`pipeline.mjs` 1243 行居首）、健康分 **79/100**（唯一扣分项是结构维）。
  - **测试**：新增 30 条，回归 499/499。
- fix(tools): 〔开发期〕**健康分三处口径失真**
  - ① 首版把全部 66 条房规按 −1/条扣，健康分跌到 34，可 54 条在已封存的 `hooks/`：**已封存代码的债务不是当前债务**，算进去与 `dsh-code-check` 的 0/100 同病 → 改为 src 活跃层计分、`hooks/` 只报不计。
  - ② 测试维只扫**直接** import，把 `core/audit.mjs` 判成「零测试引用」（它被 `postProgress`/`seams` 引，那两者测得很厚）→ 改传递闭包，不可达 14 → 2。
  - ③ `dsh/status.mjs` 仍被判不可达——`status-cli.test.mjs` 用 `fileURLToPath(new URL(...))` 引它，**跑 CLI 的测试只拼路径不 import**，补第三种引用形态后 2 → 1。
  - ④ 最后剩 `core/approval.mjs` 四个导出只被已封存 `hooks/guard.mjs` 引（原生侧已由 `eligibility-gate.mjs` 替代）→ 分三态 `active`/`frozenOnly`/`orphan`，**只有 orphan 扣分**。
- fix(gate): 〔开发期〕**`--strict` 从「有问题就红」改为债务上限棘轮**
  - **原状**：三个新工具的 `--strict` 首版都是「有任何一条即 exit 1」，而存量（房规 54 / 结构 28）短期清不到零，**闸门永远红**。永久红会训练人忽略告警（`schema:verify` 上踩过同一个坑）。
  - 改为：房规只数活跃层（上限 0）、结构上限 28、健康分下限 79，**只许降不许升**，修好了手工下调。
  - 上线当场抓到作者自己的两次回归（新测试文件的死 import、`mutate.mjs` 的 `main()` 148 行撞阈值），证明闸门不是摆设。
- feat(tools): **抽样变异 `tools/mutate.mjs`**
  - **关键不是变异算法，是测试选择**：手写版输给 Stryker 不是因为算法差，是每个变异体都跑全量。本工具用 import 图选出「触达该模块的测试文件」，`postProgress` 从「跑 499 条」降到「跑 4 个文件」。
  - **算子**：6 类（比较/相等/布尔/布尔字面量/空值合并/取反）。
  - **安全**：跑在 `packages/` 的临时副本里，真实源码永不被改。否决了「原地变异 + finally 还原」——进程被强杀就留下脏源码，而这个仓的源码是安全闸门本体。
  - **首测**：`postProgress` 145 变异体 → 杀 41 / 存活 104（28.3%），存活集中在 `sidOf`/`projDirOf`/`trackReadSet` 的 `&&`/`||` 回退链——测试只断言吐出的 `reason`，不断言 state 记账。
  - **局限**：算子只 6 类（无 AST 级变异）、粒度是文件、存活混着等价变异体，**28.3% 不可与 Stryker 的 89.58% 直接比**；完整度量仍用 `quality:mutate`。
  - **两道可信度闸**：变异前跑两次基线（一次红即拒绝）、变异后再验一次（红则标「不可信」而不报数字）。没有事后复验，假分数会直接进报告（实测 `toolName` 首跑 2/2 全杀、复跑 0/2 全存活）。
- fix(mutate): 〔开发期〕**`negation` 算子漏捕获组 → 整条算子静默失效**
  - **原因**：正则 `/(?<![!=<>])!(?!=)/g` 没有捕获组，`m[1]` 是 `undefined`，`op.flip[undefined]` 也是 `undefined` 于是 `continue`：**一个变异体都不产，而 CLI 照常打印「跑了 N 个」**。
  - 是 `mutate.test.mjs` 抓出来的。**教训：自己写的尺子也会犯「看起来跑了」的错。**
- feat(tools): **`quality-audit` 三处改造**
  - ① 新增 `--rules <路径>`，对账对象可换。动机是**测试设计**：原先检出用例只能断言活文档当前状态，文档一修好，用例就从「验证工具能检出」变成「验证文档还没修完」。现改为夹具验检出、活文档只留结论断言。
  - ② 新增 `dupInList` 重复行检测，**只看表格首列**——第一版按全文数条款号，把「原因」列里的交叉引用误判成重复。同类错本仓已犯过多次：关键词计数 ≠ 结构判定。
  - ③ 头注释从「14 条未交代」改为「已清完，价值转为防回归」。
  - **测试** 6 → 9 条，含**结构锚点缺失必须报错而不是静默算 0 条**——这是最危险的失败模式，它会伪装成「全部已交代」。

### 测试基础设施

- feat(test): **测试强度交给 Stryker（npx 按需，不进依赖）**
  - **对比实测**：手写版 9 个变异体 / 跑 5 分钟 / 只覆盖 4 个判定函数；Stryker 单文件 **6 秒生成 51 个变异体**、Mutation score **89.58%**、平均每个变异体只跑 **0.94 个测试**。
  - **Stryker 当场找出 5 个手写版完全没覆盖的存活变异体**：`CAT_RE` 的 `\s*`→`\s`、`turnPrompt` 与 `command` 的默认参数。手写版一个都没碰到。
  - **零依赖守住了**：Stryker 有 **27 个直接依赖**，装进 `devDependencies` 会打破本仓零依赖。改为 `npx --yes --package …@10.1.1` 按需拉取，两个依赖字段仍为空——已由测试断言锁死。
  - **配置** `stryker.config.json`：默认只变异 6 个判定模块（共 945 个变异体，8 并发约 1 分 40 秒）；全量 18 模块 2749 个变异体实测 8 分钟以上跑不完，不设为默认。
  - **局限**：AI 执行环境里 945 个变异体中 820 个报 `RuntimeError`，原因是执行环境的**批量删除保护**拦住了 Stryker 清理 `stryker-output-*.json`。
  - **这不是 FG 的缺陷，也不是 Stryker 的缺陷。**单文件（51 变异体）可跑通。**请在本机终端复验 `npm run quality:mutate`。**
  - **`constants.mjs` 曾不在变异范围**：`acceptance` 有 3 处用正则读它的源码文本，而 Stryker 会对变异范围内的文件插桩，文本匹配必然失败。「读源码文本」与「插桩」天然互斥——已由下方 `test(acceptance)` 那条解开。
- test(acceptance): **三处「正则读源码文本」改 import 运行时值**
  - `ENGINE_VERSION` 两处（版本一致性 / 版本追赶）改读 import。
  - **改法**：`PARDON_DECL_RE` 那处从 `consts.includes("PARDON_DECL_RE = /【授权识别】/")` 改为 `PARDON_DECL_RE.test("【授权识别】")`。
  - **是升级不是等价替换**——原先断言「源码里有这行字」，现在断言「这个正则真能匹配」。
  - **连带解锁**：`constants.mjs` 已进 `stryker.config.json` 的 `mutate` 范围，并在 `quality-audit.test.mjs` 加断言锁死，防止被悄悄挪回去静默降低覆盖。
- refactor(dsh): **`postProgress` 监听器按段拆分**
  - **原状**：单个 **320 行**闭包按段落堆放 7 个互不相干的职责（预算 / 上下文污染 / 巨量输出追责 / 子代理摘要 / 强制委派 KPI / 抽查A / 抽查B），共用 `reason` 一个短路变量，改任一职责都要读完全部前序短路条件。
  - **改法**：抽成 **9 个命名函数**，前半为 `settleForcedInvestigate` / `trackReadSet` / `judgeBudgetPools` / `detectCtxPollution` / `scoldDump`。
  - **后半**：`checkDelegateSummary` / `detectForcedDelegation` / `spotCheckA` / `spotCheckB`。监听器退化为顺序调用 + `||` 短路，**单函数 320 → 46 行**。
  - **效果**：监听器退化为顺序调用 + `||` 短路，**单函数 320 → 46 行**。
  - **如实申报**：文件总行数从 427 涨到 502（+75），涨的是段落注释与函数签名；纯装饰分隔线已删 18 行。收益是可读性与可测性，不是总量。
  - **刻意保留两处原语义**（没有「顺手改对」）：① 侦查池超限会覆盖同一次调用里已产生的续杯/熔断 `reason`；② `scoldDump` 不看 `isFail`。二者原实现如此，改动即行为变更。
- fix(test): 〔开发期〕**`NODE_TEST_CONTEXT` 让嵌套 `node --test` 恒 exit 0**（本版最值钱的一条）
  - **发现方式**：写受控夹具的端到端用例时，同一夹具在终端跑出「1 杀 1 活」，在测试里跑出「2 个全存活」。
  - **根因**：`node --test` 会往环境塞 `NODE_TEST_CONTEXT=child-v8`，子进程继承后**无论测试是否失败都 exit 0**。
  - **后果**：任何「在测试里 spawn `node --test` 并看退出码」的逻辑全部静默失效——变异工具因此把所有变异体判成「存活」，得分全假且看不出来。
  - **修法**：子进程环境 `delete env.NODE_TEST_CONTEXT`，`audit-isolation.mjs` 一并补上。
  - **判据**：跑测试的子进程，环境必须和终端一致，否则测的不是被测对象。
- fix(test): 〔开发期〕**`preGuard.test.mjs` 偶发红的根因：状态文件没隔离**
  - **症状**：「异常一律不阻塞」那条时红时绿（3 红 → 6 绿 → 8 次全量里 1 次）。
  - **根因**：`statePath(id)` 是 `join(tmpdir(), 'focus-guard-' + id + '.json')`，**不带 pid**。
  - **触发条件**：该用例传 `exec = null` 时 `sidOf` 回落到常量 `'dsh-native'`，读的是**真实会话正在写的状态文件**。
  - **所以它取决于「跑测试时真实会话在干什么」，重试治不好。**
  - **修法**：把该测试文件的 `TEMP`/`TMP` 整体重定向到独立沙箱（`os.tmpdir()` 每次调用都读环境变量）。
  - **验证方式**：不是「多跑几次绿了」，而是**在真实 tmpdir 里写一个熔断态**再跑——修前必红、修后 15/15 全绿；另加一条断言把隔离钉死。
- fix(test): 〔开发期〕**`npm run eval` 往真实审计日志写 62 行**
  - **根因**：`threat-eval.mjs` 用裸 `execFileSync`，子进程继承宿主的 `CLAUDE_PROJECT_DIR`，`guard.mjs` 据此把审计写进**真实工作区** `.focus-guard/AUDIT.log`。
  - **为什么没被拦住**：`audit-isolation` 只守住了 `test:all`，守不住 `eval`。
  - **修法**：按 `acceptance` 同款纪律——子进程显式置空 `ZCODE_PROJECT_DIR`/`CLAUDE_PROJECT_DIR`/`FG_PROJECT_DIR`/`FG_SHELL`，`FG_AUDIT_FILE` 指向 tmpdir 独立文件。
  - **结果**：实测 Δ 0，61/61 与 34/34 仍满分。
- fix(test): 〔开发期〕**审计隔离守卫只包住了一环**
  - **缺口一**：`audit-isolation.mjs` 是「跑测试前后拍快照」，而 `check` 链里 eval / selftest / bridges 都在它**外面**，这正是上一条能潜伏的原因。
  - **修法**：新增 `--wrap "<命令>"` 模式，`check` 改为 `audit-isolation --wrap "npm run check:inner"`，现在整条链都在快照内。
  - **缺口二（假阳性）**：只比行数会把**宿主进程在跑 check 期间自己写的那几行**算成测试污染。
  - **实测**：报 Δ 3 行，逐条核对是 `compaction-watch-ready`（pid 22660，ts 与 `status.json` 的 `started_at` 差 1ms）加两条 `handover-inspect`。
  - **为什么假阳性更糟**：它会训练人用 `FG_ALLOW_AUDIT_GROWTH=1` 绕过，闸门就废了。
  - **修法**：`audit()` 落一行 `run` 字段（取 `FG_RUN_ID`，宿主没有这个变量 → `null`），守卫给子进程注入批次号，**只把带本批次号的行算作「测试链写的」**，其余如实报为「宿主并发写入，不计」。
  - **测试**：`audit-run-tag.test.mjs` 3 条锁住 run 字段契约；`audit-isolation-branches.test.mjs` 2 条用沙箱副本验证两个分支（宿主行 → PASS 且报数；本批次行 → FAIL）。
  - **「分得开」不能只是说法，得是断言。**
  - **教训**：**「隔离」必须包住整条链，只包住自己那一环等于没包。**

### 文档与口径

- docs(writing): **定「排版」规矩，并按它重排 3.2.0 段**
  - **起因**：人类两次批示「讲一点格式啊，排版一点没有」「你这乱的，都要丢给模型才能读明白」。
  - **先量再定**：237 条条目平均 **220 字**、97 条超 200、35 条超 400、最长 **865**——一条 bullet 就是一篇短文。
  - **规矩**：新增 `docs/WRITING-STYLE.md` 七条（首句结论 / 条目 ≤120 / 子项带标签 ≤150、裸写 ≤80 / 层级 ≤2 / 三件以上上表 / 论证进 HANDOFF / 段标题信息不重复）。
  - **根因**：`CHANGELOG` 回答「变了什么」，`HANDOFF` 回答「为什么」。混写就是 865 字 bullet 的来源。
  - **重排**：3.2.0 段 29 条平铺 → 25 条分 5 组；条目平均 **220 → 51 字**，最长 865 → 120 字内；子项 117 条 **0 违规**。
  - **测试**：`tests/changelog-format.test.mjs` 8 条（最新段严格 / 全文件棘轮 753 / 结构锚点 / 4 条夹具）；2026-10-27 晚改为**全 21 段严格**、棘轮 **120**。
  - **不自欺**：规矩第一版写「子项 ≤4 条、≤80 字」，实测 117 条里 60 条超限——**判据是拍的，不是量的**。改成看形式（有标签 ≤150、裸写 ≤80）后归零。
  - **误报一次**：日期重复检查把 `HANDOFF-2026-10-27.md` 这个**文件名**当成日期标注判红。判据收紧为「（日期」形态后通过。
- docs: 同步 `ARCH-MAP.md` L5 状态行与缺口 #4；`constants.mjs` 的「默认关闭」陈旧注释改正（代码与审计均证实**默认开启**）。
- docs(rules): **增补章 14 条未交代全部交代，归零**
  - **有实现、只是映射表漏写（5 条）→ 补映射行**：第七十四、七十六、七十八（**仅(三)**）、八十（**仅(一)(五)**）、八十六条。第七十八、八十条在映射行里显式标注「仅某款机械化」——写「已映射」不等于全条落地。
  - **确属模型行为（9 条）→ 进未机械化清单**：第七十七 / 七十九 / 八十一 / 八十五 / 八十七 / 八十八 / 八十九 / 九十 / 九十一条，每条写明「为什么机械不了」。
  - **关键判据**：**「有代码」和「能机械判定」是两件事**。第八十八条要求「独立 oracle」——引擎能校验锚点**格式**（第八条），校验不了「这个 oracle 是否独立于被测假设」；硬算成已落地就是空头条款的另一种写法。
  - **顺带修**：清单里 `第四十八条` 曾整行重复两遍，而对账工具用 `new Set` 去重永远看不见。已去重。
- docs(release): **「修复」的定义与受众口径**
  - **定义**：对外文档的「修复」默认指「**修复用户可能已经遇到的问题**」。开发期发现并处理掉的缺陷不称「修复」，改写为「某某改为…／收敛为…／加固…」。
  - **判据三条**（缺陷存在于已发布版本 / 用户有路径真的遇到 / 修完对外可见行为变了）与处置表写进 `docs/RELEASE-POLICY.md` 第一节。
  - **两条轴**：「**前缀 = 技术性质**」（`fix(...)` 只表示改的是缺陷，供计数与检索）与「**措辞 = 受众**」（决定能不能出现「修复」二字）必须拆开——否则为了对外好看，会把内部记录改得查不到缺陷。
  - **标注分两级**：**段级** `> **影响面：开发期**`（整段同质时用）与**条目级** `〔开发期〕`（段内混合时逐条标）。
  - **判据是缺陷的暴露面，不是修它的版本何时发出**——缺陷在已发布版本里存在过，用户就可能已遇到，对外可称「修复」，哪怕修它的版本还没发。
  - **渠道要查全**：npm 只到 `3.0.6`/`3.0.7`，但 GitHub `main`（公开源码，clone 即得）已到 **`3.1.0`**（`5f0e7e5`，2026-10-26），tags 止于 `v3.0.4`；取最高者 → 对外已分发 **3.1.0**。
  - **当日自查纠错**：第一版只查了 npm 就断言「3.0.8 起未对外分发」，把三个已发布段落标成了开发期——**npm 是最窄的渠道，不是默认渠道**。
- test(release): **受众口径机械校验**
  - **新增** `tests/changelog-audience.test.mjs` 10 条：活文档零违规 / 顶部口径声明不得被删 / **`PUBLISHED_MAX` 必须等于 `origin/main` 上的版本**（「渠道查全」的机械盯梢；无远端引用时 skip 而不是假红）。
  - **结构锚点**：解析必须真看见各段；3.2.0 段 `〔开发期〕` 标记 ≥5 条；**反向锚点**——修已发布版本缺陷的「抽查B / 熔断只活一步 / 审计重复记账」三条不得被误标成开发期，误标会把真实影响面藏起来。
  - **6 条夹具**：段级开发期段写「修复」必须报 / 条目级 `〔开发期〕` 同样受限 / 未推送段一处标注都没有必须报 / 已发布段标整段开发期必须报 / 已发布段写「修复」是允许的 / 引用「修复」二字不算违规。
  - **引号约定**：写 `「修复」` = 在谈论这个词，不算违规；不加引号 = 在宣称修了东西。
  - **夹具不是装饰**：这条规则上线当场报了两处——先把我自己写本规则的两条条目判红（在谈论这个词，于是补了引号例外），后是结构锚点用例自己红了一次（`dev.sort()` 按字符串序把 `3.0.10` 排到 `3.0.9` 前）。**尺子先量到了造尺子的人。**

### 代码卫生

- chore(review): **第三方工具三连跑 + 88 个死符号清理**（人类指令「选择合适的都跑一遍」，完整台账见 `docs/HANDOFF-2026-10-27.md`）
  - **可用 3 个**：`dsh-refactor-insight` / `brooks-lint` / `dsh-code-check`。
  - **不可用 4 个**：`dsh-lens` 依赖 DSH 私有包；`dsh-plugin-review@0.0.1` 全文是 `// Placeholder`。
  - **另两个**：`dsh-code-smell` 与 `dsh-skill-ponytail` npm 404；`dsh-lens-lite` 是 post-edit 钩子不是审计工具。
  - **brooks-lint 91/100**（Code 94 / Arch 90 / Debt 89 / Test 89）。
  - **自写 Tarjan SCC 补扫**确认零循环依赖（67 模块 / 111 条内部边 / 强连通分量全为 1），母版反向依赖适配层 0 处。
  - **真问题 5 条**：单监听器承担 7 职责、`pipeline.mjs` 1241 行、增补章 14 条口径悬空、`RULES.md` 抽查B 条款与实现矛盾、`SESSION_RULES_FULL` 无消费者。
  - **`dsh-code-check` 的评分对 FG 失效**：线性模型 `100 − errors×8 − warnings×3` 代入 681 warnings 得 **0/100**。
  - **归零原因**：`curly` 586 条——FG 房规「单语句块不加括号」vs ESLint 默认 `curly: all`，**是配置错配，不是缺陷**。关掉后同批代码 95 warnings。
  - **仍可用的是明细**：`no-unused-vars` 174 → **86**、`no-duplicate-imports` 2 → **0**。
  - **清理落地**：`src/core/{risk,approval,env,audit,backup,state}.mjs` 删 82 个死 import（从 `guard.mjs` 拆母版时整块复制 import 头部的残留），本轮再清 6 个。剩余 86 条中 54 条在已封存层，不动。
- chore(review): **`dsh-refactor-insight` 57 条硬事实逐类判死**
  - `long-function` 32 条大半是测试文件（测试函数长 ≠ 认知负荷高）。
  - **判死**：`todo-density` 8 条**全部不是债务**——`reasoningWatch`/`emotionFilter` 已由 `profileLoader.mjs:50-51` 登记为 `'no engine implementation, TODO'`。
  - **证据**：`profile.test.mjs:107-112` 把该申报本身锁成断言，属**诚实的空头申报**。工具只看 `TODO` 三个字母，分不出「已申报」与「已遗忘」。
  - **不修**：`deep-nesting` 最深 7 层在已封存的 `guard.mjs:193`；`hooks/guard.mjs` 1168 行**不修**（已封存的 ZCode 兼容层）。
- refactor(layers): **`pipeline.mjs` 拆到 `src/dsh/guard/`，1242 → 106 行**
  - **口径**：纯搬运——判定逻辑、阈值、审计字段、理由文案零改动；14 个导出名逐一比对不变。
  - **切法**：按层拆 10 个模块（tooling/evidence/redline/superpowers/wholeFile/hardCheck/authz/volume/risk/runtime），`pipeline.mjs` 只留编排。
  - **测试**：`npm run check` exit 0、**522/522**；测试文件只改 1 处（见下条）。
  - **如实申报**：健康分仍 **79**——结构维被 27 条存量异味压在下限 30；本刀买的是可读性与改动局部化，不是分数。
- test(fixtures): **真实夹具重放改为「按前提重算期望」**
  - **起因**：3 条样本是「read `pipeline.mjs` 被整文件闸拦」，而该闸的触发前提是目标文件 >300 行。
  - **缺陷**：拆分后 `pipeline.mjs` 只剩 106 行，同一条 read 理应放行，旧断言却要求继续 deny——把「文件缩水」误判成「漏拦回归」。
  - **改法**：整文件闸样本按当前行数重算期望；前提成立 → 仍须 deny，前提已不成立 → 必须 allow（同时防「过时的拦」）。
  - **另加过滤**：目标文件已不存在的样本不可重放（文件系统是前提，不是判定）。

### 回归

- 全链 **exit 0**，九项验收：

| 项 | 结果 |
|---|---|
| 测试 | **522/522**（+54） |
| eval | 61/61 · 34/34 |
| selftest | PASS |
| bridges | 3/3 |
| 口径对账 | **0 未交代** |
| 房规 `lint:gate` | 活跃层 0/0 |
| 结构 `smells:gate` | 27/28（上限不变，实际降 1） |
| 健康分 | 79/100 |
| 整链审计 | **Δ 0 行 / Δ 0 字节** |

## 3.1.0 · 2026-10-24

> 版本策略：3.0.9 起累计 **10 条**（3.0.10 的 7 条 + 本版 3 条）→ 达阈值，升次版本。
> 本版主题：**按需注入 + 策略可达性自检 + 结果准入**（成本侧三件）。
> 发布状态：源码已推 GitHub `main`（`5f0e7e5`，2026-10-26）；npm 未发布（npm 最新 `3.0.7`）。

- feat(prompt): **按需注入（Lazy Rules）**：常驻 425 → 222 字，省约 51 tok/步
  - **做法**：只留"行为会因此改变"的硬线（取证 / 锚点 / 整读禁令 / 熔断 / 批示）；完整条文存 `SESSION_RULES_FULL`，不注入。
  - **引用**：细则改由 deny 理由按需引用；`RULES.md` 第四部分镜像与 `INSTALL.md` 验证判据同步更新。
- feat(audit): **策略可达性自检**：启动时抽参数键，与真实 schema 求差
  - **新增**：`src/dsh/policy-audit.mjs`，挂 `agent/created`；不可达键只 warn 不改。
  - **来历**：把 2026-10-22 手工发现的「三条死闸」固化成自检；`npm run gate:audit` 覆盖同一判据。
- feat(gate): **结果准入预算**：中等体积整读不再靠单次阈值漏过
  - **规则**：超过 `FG_RESULT_ADMIT_BYTES`（默认 32KB）的整读每次 -1，默认 3 次（`FG_RESULT_ADMIT_BUDGET`，0=关闭）。
  - **用尽**：即拒并指向分段读/检索；**压缩完成后额度自动恢复**。
- test: 新增 `tests/policy-audit.test.mjs` 5 条、`result-admit.test.mjs` 4 条；回归 419/419
- feat(hints): **检索后端探测**：整读闸不再写死 `xerj`，按本机可用给换法
  - **背景**：没装 XERJ 的用户照抄提示必然失败，与"死闸"同类。
  - **实现**：`src/dsh/search-hints.mjs` 探测 `xerj`→`rg`→`fd`→降级 glob+分段读；全无时每会话提醒一次安装。
  - **协调**：`FG_SEARCH_TOOL` / `FG_SEARCH_BIN_DIR` 可指定；本机 rg/fd 可用，xerj 未入 PATH。
  - **测试**：`tests/search-hints.test.mjs` 5 条；回归 424/424。
- 结论（不实施）：**不内置 XERJ**，按需下载方案保留
  - **代价**：单平台二进制 126.1 MB、三平台约 378 MB，另需守护进程 / 索引生命周期 / 许可证核查。
  - **收益**：仅省一步安装 → 不值；需要时改 `focusguard setup:search` 按需下载（未实现）。
- refactor(layers): **进度/预算判定搬进母版（阶段 2 第一刀）**
  - **新增**：`src/core/progressPolicy.mjs`——`budgetVerdict`（达硬上限→fuse；达预算→refill 且封顶）、`stallVerdict`、`invPoolOverLimit`。
  - **缝只保留**：落状态 + 写审计 + 给提示；边界 `≥ cap` 即熔断、refill 不越 cap、侦查池 `>` 才算超限。
  - **测试**：`progress-policy.test.mjs` 4 条；回归 449/449。`hooks/guard.mjs` 三处留待阶段 2 第二刀。
- refactor(layers): **收尾判定搬进母版（阶段 1）**
  - **判据**：人类原话"母版是逻辑，适配只做翻译"。
  - **原状**：`needsDowngrade` / `needsAccount` / `needsAnchorCheck` / `declaresFuse` / `hasAnchor` 在两个宿主缝各写一份。
  - **现**：统一到 `src/core/stopPolicy.mjs`（纯函数），缝只保留"取结果 → 打回/提示/写审计"。
  - **等价**：`guard.mjs` 仍打回、`stopGuard.mjs` 仍只审计（DSH 无 stop 拦截口）；5 条用例，回归 445/445。
- test(core): **母版层 API 形态锁定 + 探针教训**
  - **形态**：`judgeReadGate` 字符串三态 / `judgeGrepGate` 对象 / `judgeCatGate` 字符串二态；轮转返回路径或 `null`。
  - **教训**：探针写错三处（`turnCalls` 当 `turnCount`、对象传给位置参数、`{bare}` 传给收字符串的函数）。
  - **锁定**：`core-api-shapes.test.mjs` 4 条。
- 实跑结论（不改代码）：母版六模块逐项核对通过
  - `redlines` 12/12；`risk` 分类正确（`pwsh` + 危险命令才算 mutating）。
  - `approvals` 一次性语义成立（二次消费 false、改命令即失效）。
  - `state` 原子写无 `.tmp` 残片、坏 JSON 回退并 stderr 告警。
  - **结论**：`checkEligibility` 未取证改动 → `needApproval`（layer 3）；`audit-writer` 轮转 24.5KB→5KB 生效。
- test(dsh): **L5 收尾打回补 DSH 专用用例**
  - **缺口**：`stopGuard.mjs` 259 行但 DSH 无专用用例；探测用错字段（`turnCalls`）差点误判"不会拦"。
  - **锁定**：本回合调用 ≥5 且收尾无 `[文件:行号]` 锚点 → 写 `violation-no-anchor` 并提示；带锚点不触发。
  - **语义**：DSH 无 stop 拦截口，只审计+提示、不阻断停止（阻断会卡死人）；`stop-guard.test.mjs` 2 条。
- 审计结论（不改）：`env.mjs` 3 处空 catch 均为环境探测降级
  - 分别对应 bash 缺失 / chcp 失败 / realpath 探测失败，不涉及数据丢失；`hooks/guard.mjs` 12 处保持现状。
- chore(slim): **瘦身与伪公开清理**：删 2 个死模块 + 38 处伪公开 export
  - **删除**：`fg-apply-tool.mjs` / `fg-appeal-tool.mjs`（早期 `defineTool` 版，生产路径在 `src/dsh/tools.mjs`，零 import）。
  - **降级**：38 处只在自身文件内使用的 export 降为内部符号（`DROP_DB`、`semanticOf`、`readEnvMap` 等）。
  - **结果**：死导出候选 84 → 44；模块总行数 7325；回归 434/434。
- 审计结论（不改）：`audit.mjs` 3 处空 catch 是三级兜底
  - **性质**：工作区→临时目录→stderr，不是静默丢数据；`saveState` 失败走 `noteFail`，其余为 `.tmp` 清理。
  - **未动**：`hooks/guard.mjs` 12 处留待封存层单独处理。
- fix(status): **`status.mjs` 不显示 KPI/委托**：补读并追加到一行输出
  - **原状**：`kpi` / `delegate_budget` 已写进 `status.json`，CLI 只渲染心跳与模块数。
  - **现**：追加 `KPI -640  委托 19`（字段缺失兼容）；`status-cli.test.mjs` 2 条。
- chore(modules): **给两个死重复模块加"未使用"横幅**
  - 两个 `defineTool` 早期版本全仓无 import；横幅标明"改了不影响线上行为"，避免改错文件造成漂移。
- feat(tools): **模块体检三件套**：行数 / 导出 / TODO / 空 catch / 审计分布
  - **三件**：`module-audit.mjs`（行数/导出/TODO/空 catch/console）、`log-audit.mjs`（动作分布/可疑 evidence/时间断层/近 24h）、`dead-export.mjs`。
  - **首跑**：AUDIT.log 5535 行 0 坏行 / 0 条可疑 evidence；`blast-radius` 未触发（需重启加载）。
- feat(gate): **改动面闸（Blast-Radius Gate）**：新建敏感文件 / 加依赖先回三行
  - **触发**：`src/`、`packages/` 下不存在的文件，或 `npm|pnpm|yarn|bun|pip|poetry|uv install/add`。
  - **要求**：收益（说不清就是小彩灯）/ 改动面（文件数、是否跨层）/ 替代（更小做法）；只拒一次。
  - **豁免**：人类指令已声明收益（≥10 字且含"收益/可测/减少/避免"）；`FG_VALUE_GATE=0` 可关。
  - **口径**：判改动面 × 收益量级，不预测 token/金额（不可测的 ROI 一律不写）；5 条用例，回归 429/429。
- feat(report): **改动面收尾报告**：回合末把"小彩灯"暴露出来
  - **统计**：`agent/turn-stopping` 读 `state.editedFiles`，≥`FG_BLAST_REPORT`（默认 6，0=关）写 `blast-radius` 审计行。
  - **挂徽标**：下次徽标带 `blast:N`；位置必须在 KPI 零增量提前 return **之前**，否则报不出来。
  - **测试**：`blast-radius-report.test.mjs` 3 条；回归 432/432。

## 3.0.10 · 2026-10-22

> 版本策略（2026-10-22）：每 10 次修复 = 一次变更（x.x.0），其余补丁号递增；细则见 `docs/RELEASE-POLICY.md`。
> 本版含 3.0.9 之后的 **7 项修复/特性**（未满 10，故走补丁号）。
> 发布状态：源码已推 GitHub `main`；npm 未发布（npm 最新 `3.0.7`）。

- fix(gate): **人工审批改走宿主 `ask` 缝（GUI 审批卡片）**
  - **原状**：不可逆类别只写 `pending_request.json` 并把 `focusguard approve <id>` 塞进理由；人类在 GUI 里既收不到提示也执行不了 CLI。
  - **现**：`gateToolCall` 返回 `{kind:'ask', displayReason}` → 宿主弹审批卡片；批准=一次性放行，拒绝/取消/无通道各有可区分理由。
  - **兜底**：CLI 通道保留给 headless（`FG_APPROVAL_SEAM=cli` 退回旧行为）。
  - **测试**：`approval-ask-seam.test.mjs` 3 条；三套 CLI 用例显式置 cli；`ptc` / `selftest` 断言改为"不得 pass，转人工审批"。
- feat(kpi): **KPI 可见化**：只做展示、不动判定
  - **查证**：全仓 `state.kpi` 只有写入（`postProgress`）与结算（`seams`），无读取做判定，也没有输出面。
  - **展示**：结算后 `setKpiSnapshot` → `status.json` 新增 `kpi` / `delegate_budget` / `kpi_at`；`livenessBadge()` 追加 `；KPI −640 · 委托 19`。
  - **出现位置**：只在拦截理由、`fg_apply` 结果、压缩事件三处（"FG 说话的时候"）。
  - **测试**：`kpi-visibility.test.mjs` 4 条，含"KPI 高低不改变判定"。
- feat(l4): **跨会话快速交接**：卷宗加快照与注入
  - **快照**：`{at, sid, toolCalls, denies, kpi, delegateBudget}`，覆盖式保存，只存 FG 亲自数得出的量。
  - **注入**：`shouldInjectHandoff()` 仅当快照来自**别的**会话时注入一行「上次会话：…」；同会话不重复。
  - **CLI**：`npm run handoff` 打印 hash、快照、最近 5 条决策/约束（各 90 字）与注入预览。
  - **测试**：`handoff-quick.test.mjs` 5 条。
- fix(workspace): **卷宗只留最新 + 指令质量筛选**
  - **原状**：`clean()` 满 10 条即 break，保留的其实是最早 10 条，最近的进不来。
  - **现**：取尾部（最新）再反转回正序；`pickDecisionText()` 过滤表格 / 代码块 / 终端报错 / 子代理回执，短于 4 或长于 120 字不记。
  - **清理**：本工作区被污染的 `decisions` 已清理（备份 `.focus-guard/archive/workspace.bak-*.json`）。
  - **测试**：`workspace-quality.test.mjs` 3 条。
- feat(workflow): **重复被拦 → 换策略提示**：只改文案，不改判定
  - **背景**：8 任务那轮被拦 7 条后仍重试同一条，多出 4 个 step；旧理由只写"请先读"，没告诉它重试无效。
  - **做法**：`src/dsh/repeatGuard.mjs` 按「会话+工具+参数」计数；第 2 次起改写成「[重复被拦 ×N]…」并按闸类型给另一条路。
  - **换法表**：整文件→`xerj` 或 offset/limit；Grep→补 `include`；取证→先 read；资格闸→`fg_apply`；红线→等价做法或 `fg_appeal`。
  - **停手提示**：同会话累计 ≥5 次被拦追加一句"先停手：总结现状"；`repeat-deny.test.mjs` 4 条。
- feat(tools): **面板采集处理器** `tools/collect-panel.mjs`
  - **校验**：「未缓存 + 缓存读取 + 输出 == 总 token」。
  - **解析**：从会话记录取 `steps` / `denies` / 耗时（多帧 zstd 按魔数分帧）。
  - **复算**：按官方价目核成本（峰谷自动判定：工作日 09-12 / 14-18 峰 ×2）。
  - **输出**：每轮表 + 中位数 + `n<5` 告警；`--init` 生成 `panel-runs.json`；P0 协议改为"一条命令出表"。
- fix(tools): **面板成本单位是人民币**：按汇率换算后再核对
  - **原状**：面板显示 ¥，脚本拿 USD/1M 直接比 → 误报不符。
  - **现**：按 `FG_USD_CNY`（默认 7.1）换算，差额 >¥0.002 才告警；实测 R2 复算 ¥0.0493 vs 面板 ¥0.0500。

## 3.0.9 · 2026-10-22

> v3.0.8 - Implemented Lazy Liveness to reduce prompt token overhead; Relicensed under AGPLv3

> 版本策略（人类批示 2026-10-22）：**每 10 次修复合为一次变更（x.x.0）**，其余按补丁号递增；细则见 `docs/RELEASE-POLICY.md`。
> 3.0.8（2026-10-19，未发布 npm）内容：v3.0.8 - Implemented Lazy Liveness to reduce prompt token overhead; Relicensed under AGPLv3；本版在其上继续累积。
>
> 发布状态：npm 未发布（npm 最新 `3.0.7`，MIT 授权、不可撤销）；**源码已推 GitHub `main`，属已对外分发**。
> 本条目已并入 2026-10-19 起累积的全部改动（原「未发版」区已合并，不再单列）；含 AGPLv3 切换与按需自证。

- fix(gate): **改动类工具分类补齐 MCP 与迁移工具**——准入判据从"8 个名字"扩到显式清单 + MCP 动词前缀。
  - **原状**：取证闸/授权闸/批量待批全靠 `MUTATING_TOOL`，而它只认 8 个名字。
  - **漏检一**：`mcp__cities2-mcp__write_project_file`（写项目文件）、`build_project`/`package_project`（跑构建、打包）被判"非改动"。
  - **漏检二**：`plugin_manager`（装删插件，会执行 npm 构建脚本）、`move_run`（写 AGENTS.md）、`import_claude`/`claude_export`（写会话文件）同样免检。
  - **做法**：新增 `isMutatingTool()`（显式清单 + MCP 动词前缀；只读类不误判）、`pathOfTool()` 支持 MCP `{project_dir, relative_path}`。
  - **收紧**：改动类解析不出路径时不再放行，改为要求 `fg_apply` 一次授权（`FG_MUTATION_UNMAPPED=allow` 退回旧行为）。
  - **母版**：`core/risk.mjs::isMutating` 同步支持小写与 MCP；新增 `tests/mutation-classify.test.mjs` 6 条。
- feat(tools): **死闸审计** `tools/gate-audit.mjs`（`npm run gate:audit`）——源码参数键与真实工具 schema 对账。
  - **做法**：把源码引用的参数键与真实会话 `request/header` 的工具 schema 对账。
  - **输出**：「引用了但 schema 没有的键」（死闸嫌疑）与「既不算只读/改动/shell 的工具」（分类盲区）。
  - **首跑**：11 会话 / 254 工具，只剩 `cmd`（兼容回退）、`head_limit`（ZCode 遗留）、`pages`（已删）三个无害键。
- feat(gate): **委派闸补 DSH 原生委派面（A 项）**——`RE_AGENT` 此前只认 `agent|subagent`，其余委派全部绕过子代理闸。
  - **漏检**：`subagent_fork`、`spawn_teammate`（Agent Teams）、`summon_expert(s)` / `summon_expert_team`（Agency 专家团）。
  - **后果**：委托池（默认 20）从不扣、熔断期也能起团队、KPI 奖惩空转。
  - **做法**：全部纳入 → 扣委托池 + `/dN` 因果子链 + 熔断期拒绝 + 48 条留痕。
  - **测试**：新增 `tests/delegation-pool.test.mjs` 8 条（5 个委派工具各扣 1 次 / 熔断期拒 / 池尽拒 / 只读不误伤）。
- feat(test): **防"先射箭再画靶子"四件套**——针对"合成参数测试全绿、线上全漏"。
  - **schema 指纹**：`tools/schema-fingerprint.mjs` + `docs/TOOL-SCHEMA.json` 把被测 schema 固定成哈希。
  - **指纹行为**：漂移即 `exit 1`；已接进 `npm run check`（无会话时自动跳过）；基线 `hash=988ac78c05d054a9 / 254 工具 / 18 会话`。
  - **真实调用夹具**：`tools/capture-fixtures.mjs` → `tests/fixtures/real-calls/`，从真实会话导出 `(工具名, 参数, 判定结果)`，测试只准读夹具。
  - **参数口径**：参数**不得截断**（截断会让重放失真）；判定必须"结果首块以 `Error` 开头"，否则成功结果里的"整文件闸"字样会被误判为拦截（本轮实测两次）。
  - **真实夹具回归**：`tests/real-fixtures.test.mjs` 23 条确定性 deny 样本重放必须仍 deny（依赖会话状态的样本显式跳过）。
  - **等变矩阵**：`tests/invariance.test.mjs` 同一危险动作换 4–6 种写法，判定必须一致。
  - **写法清单**：绝对/相对路径、`read`/`Read`/`read_file`、`Add-Content`/`Set-Content`/`Out-File`/`Tee-Object`/`>`、psql/mysql、npm/yarn/pnpm。
  - **首跑缺口**：**`sqlite3 DROP TABLE` 不拦**（红线只到 `DROP DATABASE`），已钉成"已知缺口"用例。
  - **决策-执行一致性** `tests/decision-execution.test.mjs`：deny ⇒ 执行器不得被调用、目标文件字节不变；allow ⇒ 确实改变。

- fix(guard): **KPI 重复结算**（ΣΣ）——旧实现把会话累计值当"本任务 KPI"，每回合重复累加、重复扣池。
  - **根因**：`state.kpi` 是会话累计值，而 `agent/turn-stopping` 每回合都跑。
  - **实测**：`kpiCarry` 记成 `-8900` 对真值 `-290`，膨胀 30 倍；委托池也被重复扣。
  - **做法**：改为按增量结算（`kpiNow = 累计 - kpiSettled`），无增量零动作、不记 `kpi-settle`。
- fix(guard): **成本台账静默停摆**——`postExecuteListener` 拿不到 `usage` 时旧实现无 `else`，整条核算失效。
  - **后果**：台账 10-08 起零新增，无人发现。
  - **做法**：连续 5 次缺失 `warn` 一次，成功调用清零重计。
- feat(tools): **卷宗【三】路径自检**——新增 `packages/core/tools/verify-case-paths.mjs`（只读核查，不删不改）。
  - **用法**：`--json` 可机器读。
  - **实测**：81 行 / 有效 75 / 失效 6（均为 monorepo 迁移前布局，待人类批准后归档）。
- refactor(layers): **消除三处分层越界**并固化断言——三处越界逐一归位，方向由用例锁死。
  - **协议**：`protocol.mjs` 移入 `hooks/`（去掉 `zcode → adapter`）。
  - **母版下沉**：审计写入器下沉 `src/core/audit-writer.mjs`、绝对红线表下沉 `src/core/redlines.mjs`（去掉 `adapter → seam`，`pipeline.mjs` 保留 re-export）。
  - **工具归位**：自检脚本移入 `tools/selftest.mjs`（工具不再放生产目录）。
  - **断言**：新增 `tests/layering.test.mjs` 锁死 `core → adapter → seam` 单向，禁止 `zcode → 适配层/宿主缝`，并显式承认组装根 `seam → adapter` 合法。
- feat(bench): **判定基准** `tests/decision-bench.mjs`——14 用例 × 10 轮 = 140 次真实 `preExecuteListener` 调用。
  - **输出**：准确率 / 误伤率 / p50-p95 / max；基线落 `docs/BENCH-BASELINE.json`（`--update` 覆盖，掉点即 exit 1）。
  - **首跑结论**：**Bash 类命令每次约 60ms**（第 2 层语义判定调 python 哨兵），非 Bash 工具 p95 < 3ms。
- feat(bench): **成本基准** `tools/bench-cost.mjs`——不跑模型，只汇总 `.ai/CASE_FILE.md`【五】成本台账与 `AUDIT.log`。
  - **汇总项**：token/USD、按模型分布、拦截数、`trigger` 分布、误伤比（`appeal-granted / deny`）；支持 `--since` / `--json`。
  - **附**：A/B 对照协议（FG 开/关各 5 次取中位数）。
- fix(ci): **`test:all` 改为发现式**——原为硬编码 11 文件清单，新测试漏在清单外，会出现"CI 全绿但没测"。
  - **原状**：`casePaths` / `layering` 测试不在其中。
  - **做法**：统一走 `tests/audit-isolation.mjs`（自动发现 + 真实审计零增长守卫）。
- docs: 新增 `packages/core/docs/BENCH.md`（四类基准的跑法与已知热路径成本），README 命令表补 `bench:decision` / `bench:cost`。
- perf(gate): **哨兵结论缓存**——同一命令在会话里反复出现，而每次都要付约 60ms python 冷启动。
  - **做法**：`riskOfSentinel` 按命令原文缓存**成功结论**（LRU 500，`FG_SENTINEL_CACHE=0` 关闭、`FG_SENTINEL_CACHE_SIZE` 调容量）。
  - **不缓存**：失败（超时/缺 python/解析失败）一律不缓存，不把错误固化成判定。
  - **实测**：**p95 61.19ms → 2.37ms**，p50 0.58ms → 0.36ms；每条新命令首次仍付约 60ms（常驻进程方案未做）。
- test(bench): **任务测试 50 组**（`tests/task-bench.mjs` + `task-suite.json`）——组 = 一串真实调用（读→改→跑→查），任一环被错拦整组失败。
  - **覆盖**：只读/改代码/命令/高危/资格/边界六类。
  - **用法**：`--group` 单跑、`--json` 机器读，零 API 花费。
  - **战绩**：首轮 46/50，修掉下列四个真问题后 **50/50**。
- fix(gate): **引号豁免射程过宽**（漏拦）——引号内容会被**真正执行**的命令，旧实现按"被引用的数据"豁免放过。
  - **样本**：`psql -c 'DROP DATABASE prod'`、`node -e '…'`。
  - **做法**：`redlineExempt` 增加执行型参数判据（`psql/mysql/sqlite3/node/python/ruby/perl/bash/pwsh… -c|-e|--command|--eval` 的实参不豁免）。
  - **仍豁免**：`git log --grep 'drop database'` 这类真数据。
- fix(gate): **`rm -rf` 一刀切要 fg_apply**（误伤）——`rm -rf ./dist`、`rm -rf /tmp/...` 属常规构建清理。
  - **矛盾点**：第 2 层已按 `destructiveApiWeight` 分级（TEMP 0.2 / 递归系统 0.9）。
  - **做法**：可重建目录（`dist/build/out/output/target/coverage/.cache/.next/node_modules`）与 TEMP 目标不进门槛清单，交回第 2 层按风险裁决。
- fix(gate): **`Write`/`Edit` 写系统路径未被拦**（漏拦）——资格闸原来只在 `if (cmd)` 时执行，写入型工具的 `file_path` 从未被检查。
  - **后果**：`C:\Windows\...` 之类的目标长期漏检。
  - **做法**：闸按"命令或 `file_path` 任一存在"触发，`gatedReasonOf(tool, command, filePath)` 对写入型工具查 `SYSTEM_PATH_RE`。
- fix(gate): **shell 写文件绕过取证闸**（漏拦）——代理用 `pwsh Add-Content` 而非 Edit，旧实现只管 `MUTATING_TOOL`，**盲改被放行**。
  - **实测**：A/B 会话对照 B 组，要求"不读就改 README"。
  - **做法**：新增 `shellWriteTargets()` 从命令里提取写目标（`>`/`>>`、`Set-Content`/`Add-Content`/`Out-File`/`Tee-Object`、`tee`、`sed -i`、`perl -pi`）。
  - **判据**：对**已存在且本会话未读**的目标同样拒一次；新建文件与 `NUL`/句柄复制不误伤。
  - **降级**：参数惰性 getter 抛错时不做判定（不中断判定链）；新增 `tests/evidence-shell.test.mjs` 7 条。
- feat(bench): **`bench:ab` 会话成本对照**——解 `session.v4.jsonl.zstd` 结构指标，并取 `AUDIT.log` 拦截数。
  - **数据源**：`$DSH_HOME/.dsh/sessions` 的 `session.v4.jsonl.zstd`（turns/steps/工具调用分布/各类正文字符/时长），按会话 id 取 `AUDIT.log` 拦截数与理由分布。
  - **输出**：A/B 差值与性价比（每步 tokens、每次拦截 tokens）。
  - **坑**：多帧 zstd 需按魔数 0x28B52FFD 分帧解压，单帧 API 只解第一帧。
- fix(bench): **token 口径与台账退化值得以确认**——宿主会话记录**不含逐次 usage**，台账写入的是退化值。
  - **退化值**：`model=unknown`、1 token、cacheRead `undefined`。
  - **因应**：`bench:ab` 给两列估算（`est4 = chars/4`、`estCJK = chars/1.6`）并显式标注"不可当账单"。
  - **未完成**：真实 token 统计需另找宿主接口。
- fix(audit): **成本台账停止写假账**——`appendCostRow` 增加退化值守卫，不可信整条不写。
  - **守卫**：`usageLooksReal` 要求模型名不为 `unknown` 且输入+输出 > 2；不可信时每进程 warn 一次，指向"真实用量以宿主面板为准"。
  - **清理**：**清空卷宗【五】历史 42 行**（全为 1 token/未知价目的退化值），保留标题与表头并追加清空说明。
  - **备份**：清理前已双备份到 `%TEMP%\CASE_FILE.bak-*.md` 与 `.ai/archive/`。
- fix(gate): **`ttl` 真正生效（授权回收）**——`grants.mjs` 此前"ttl 只记录、不生效"，`fg_apply` 一次即**进程内永久放行**。
  - **turn 档**：在 `agent/turn-stopping` 回收（`sweepGrants(sid,'turn')`，放在监听器最前，避免 KPI 无增量的提前 return 跳过回收）。
  - **task / persist**：`task` 回收 turn+task、`persist` 只受会话寿命约束；硬上限 `TTL_MAX_MS`（turn 30min / task 4h / persist 24h）防僵尸授权。
  - **留痕**：回收写 `grants-swept`（trigger `ttl:turn`）。
  - **测试**：新增 `tests/grants-ttl.test.mjs` 5 条（含端到端：授权期内放行 → turn-stopping 后必须 deny）。
- feat(gate): **FGA-PTC 补全（默认只读 / 静默秒批 / 不可逆严格档）**——主图 L3 的核心语义此前只有"按需申请"，缺两个端点，且藏着一个口径漏洞。
  - **`FG_PTC_READONLY=1`**：默认只读。写入类工具（Write/Edit/MultiEdit/NotebookEdit/Delete/Move/Patch）未授权即拦。
  - **变更型 shell**：`ptcReasonOf()` 把 `isMutatingBashCmd` 命中的命令纳入门槛，未授权即拦；只读 shell 与 Read/Grep 不受影响。
  - **口径**：等价于"隐藏高危工具"的可执行替代（schema 在宿主层，FG 无法真正隐藏）。
  - **`FG_PTC_AUTO_GRANT=1`**：静默秒批。可逆类别（publish / global-install / chmod-wide）自动批准并留痕 `ptc-auto-grant`；不可逆类别不批。
  - **`FG_PTC_STRICT_IRREVERSIBLE=1`**：修口径漏洞——`applyOneEligibility` 审核期给的**临时授权**会让母版 L3 全部放行，`rm -rf ./src` 这类不可逆删除**自证自批**。
  - **严格档**：不可逆类别（rm-rf / format-volume / drop-database / git-push-force / write-system-path）申请返回 `needApproval`，不授予授权，留痕 `ptc-irreversible-blocked`。
- feat(gate): **人工闸门改为默认开（B 方案）+ 文件审批链路**——上面那条"严格档默认关"等于安全幻觉，人类批示改为默认拦截 `rm -rf`：
  - **拦截落盘**：写 `.focus-guard/approvals/pending_request.json`，`id = sha256(工具+命令) 前 12 位`（换一个字符即失效，防偷换）。
  - **理由可照抄**：理由里直接给出 `node packages/core/tools/focusguard.mjs approve <id>`。
  - **CLI**：新增 `tools/focusguard.mjs`，子命令 `pending` / `approve <id>` / `list` / `status`（`npm run focusguard -- approve <id>`）。
  - **一次性**：`consumeApproval()` 命中后删除批准文件与 pending，下一次同命令重新拦、重新申请；批错 id 一律失败。
  - **默认射程**：只严抓 `rm-rf`（format-volume / drop-database / git-push-force 已被绝对红线层直接拦，到不了申请通道）；逃生口 `FG_PTC_ALLOW_RM_RF=1`，扩展 `FG_PTC_STRICT_ALL=1`。
  - **测试**：新增 `core/approvals.mjs`、`tests/approval-seam.test.mjs` 5 条（请求生成与 id 绑定 / 批错无效 / CLI 真写状态 / 消费一次性 / 换命令原批准失效）。
  - **同步改**：`eligibility.test.mjs` 验收②（样本换成可逆类别 publish）与 `ptc.test.mjs` 人工闸门用例。
  - 三个开关默认全关（改变默认放行/拦截的主干语义，不能偷偷开）。新增 `tests/ptc.test.mjs` 7 条。
- fix(gate): **熔断/降权口径统一到 shell 变更型命令**——`layer3Check` 早退条件漏掉无重定向的变更型命令，第 3 层被整条跳过。
  - **铁证**：本会话被判熔断后 `write` 被拒，`Bash git commit` 却提交成功。
  - **做法**：`isMutatingBashCmd` 把"变更型 shell"并入同一判据——熔断期 `git commit` / `npm install` 一律拒（只读命令仍放行），未熔断时不误伤。
  - **测试**：新增 `tests/fuse-shell.test.mjs` 5 条。
- chore(license): **全面切换为 AGPLv3 + 商业双授权**——`LICENSE` 换为标准 GNU Affero GPL v3.0 全文（34.5KB，含版权头与商业授权说明）。
  - **连带**：三处 `package.json` 的 `license` 改为 `AGPL-3.0-only`，`NOTICE` 写清双授权与商标，README 顶部加显眼双授权声明、底部 License 节重写。
  - **相比 PolyForm NC**：AGPL 允许商用但强制开源网络服务，对"资本入场"的约束是**同化**而非**禁止**，同时保留商业授权通道。
- chore(license): **（已被上一条取代）曾改为 PolyForm Noncommercial 1.0.0**——`LICENSE` 当时整体替换。
  - **人类意图**：个人电脑部署与社区使用免费，但不允许盈利；Apache-2.0 与 MIT 都是商业友好的宽松许可，表达不了"非商业"。
  - **`LICENSE`**：PolyForm Noncommercial 1.0.0 原文（4,563 字节）+ `Required Notice` 行 + 中英双语商用授权说明。
  - **边界**：个人学习/研究/业余项目/非营利社区免费；企业内部生产、收费产品/服务、SaaS 转售一律禁止；商用需单独授权。
  - **同步**：`NOTICE` 同步；三处 `package.json` 的 `license` 改为 `PolyForm-Noncommercial-1.0.0`；三份 README 的许可行与徽章同步。
  - **口径**：**非 OSI 开源**（source-available）。已发布的 `focus-guard@3.0.7` 仍是 MIT，许可不可撤销、不追溯；本许可自下一个发布版本生效。上一版短暂的 Apache-2.0 从未发布，无对外影响。
  - **补强可执行性**：`NOTICE` 增加**商标保留**段（`FocusGuard` / `聚焦护栏` 及项目标识不得用于 fork 命名或背书）与非商业声明。
  - **README**：许可节补三条边界与商标说明。
  - **`CONTRIBUTING.md`**：包含**简版 CLA**（提交即授予作者"永久、免费、不可撤销、可再许可"的版权与专利许可，使作者能发放商业授权），以及提交前自检、会被拒的 5 类情况。
  - **动机**：没有这两项，非商业许可只是"纸面约束"。
  - **修不一致**：`packages/core/LICENSE` 此前仍是 MIT 文本（**npm 发布时带的正是这一份**），根目录已是 PolyForm。
  - **做法**：根 `LICENSE`/`NOTICE` 同步到 `packages/core` 与 `packages/extended`，两个子包的 `files` 显式加入 `NOTICE`。
  - **验证**：`npm pack --dry-run` 已确认 `LICENSE`、`NOTICE` 均入包。
- ci(publish): **发布工作流去抖动**——`npm@latest` 每次可能带进新的 2FA/GAT 策略，本仓库已因此红过两次。
  - **锁定**：`npm install -g npm@latest` 改为锁 `npm@11`，并显式校验 `npm >= 11.5.1`。
  - **其余**：`concurrency: publish-${ref}` 防并发撞上 "cannot publish over"；`Verify` 步骤显式 `shell: pwsh`（windows runner 默认 shell 行为差异）。
- ci(test): **CI 矩阵拆分，推送不再挂红叉**——非 Windows 必红，而 `continue-on-error` 只保证总结果绿，UI 上仍显示 ✗。
  - **原状**：矩阵 `windows-latest / ubuntu-latest / macos-latest` × 3 个 Node，用户视角是"老是不过"。
  - **原因**：验收套件含数条 Windows 专用断言，短期无法平台化。
  - **现拆分**：`push`/`pull_request` 只跑 `windows-latest × Node 18.20/20/22`（必过）；跨平台 `observe` 作业仅 `workflow_dispatch` 触发，保留需要时的可见性。
  - **另加**：`concurrency: ci-${ref}` 取消重复推送的旧运行。
- refactor(liveness): **按需自证（Lazy Liveness）**——存活状态不再进系统提示，改为三处局部附带。
  - **先纠正一个事实**：旧实现 `livenessNote()` 在全部模块报到时返回 `null`，`index.js` 里又有 `if (note)` 守卫，**正常态本来就没有注入**（真实节省为 0）。
  - **真正的浪费**：在**降级时**——缺模块后 `focus-guard-degraded` 段随每次装配重复进 Prompt（约 100+ 字/轮），且描述的是"启动那一刻"的快照，模型后续每轮都被提醒过期状态。
  - **做法**：改为 `livenessBadge()`——正常态 `[FG 存活 15/15]`（≈14 字），异常带 `；降级: <模块名>`，并支持 `事件: compaction` 这类一次性附注。
  - **兼容**：`livenessNote()` 仅保留为兼容别名。
  - **只在这三处出现**：① `tools/pre-execute` 返回 `deny`/`ask` 时给理由追加徽标（`index.js` 的 `withLivenessBadge` 包裹，两条执行缝都套）。
  - **②**：`fg_apply` 结果文本末尾（`src/dsh/tools.mjs`）。
  - **③**：压缩落定（`compactionWatch.mjs` 调 `noteLivenessEvent('compaction')`，下一次徽标带上 `事件: compaction` 后即清除）。
  - **移除**：系统提示装配里**彻底移除** `focus-guard-degraded` 段。
  - **降噪核对**：`heartbeat.mjs` 的 `beat()` 只做 `status.json` 的 tmp+rename 覆写，不含 `appendAudit`——心跳 10s 一次也不写 `AUDIT.log` 行。
  - **断言**：新增用例断言"跑一次心跳后 `AUDIT.log` 仍不存在"。
  - **测试**：新增 `tests/liveness-lazy.test.mjs` 5 条（正常态短徽标 / 事件一次性 / 降级带模块名 / 心跳不写审计 / 装配层不再含 degraded 段）。

> 本文件按版本倒序记录面向使用者的变更。版本号与**七处清单**（根 `package.json`、根 `marketplace.json`、
> `.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、
> `packages/core/package.json`、`packages/extended/package.json`）及引擎 `ENGINE_VERSION` **完全相同**
> （共 8 处版本点），且**必须等于本文件最新条目版本**——两条一致性均由验收用例锁定。
> 引擎头注释（`hooks/guard.mjs`）例外：该文件已封存、版本号独立，由断言锁定其"封存标注"而非版本相等。

### 2026-10-22 · 清除 guard.mjs 两处确定性假警报

- fix(guard): **42条 部署版本核验不再比对封存脚本自身**——候选表第一条正是封存脚本，每会话必然误报。
  - **根因**：`hooks/guard.mjs` 头注释是封存的 `v3.0.4`（版本独立、不随主版本更新）。
  - **症状**：每个会话命中「引擎 v3.0.8 ≠ 源码 v3.0.4」并注入约 89 字告警。
  - **做法**：读到的副本**带「已封存」标记即跳过**；未封存的历史部署副本仍照常核验（那才是真信号）。
- fix(guard): **ZCode 注册表部署漂移核验改为显式开启**（`FG_ZCODE_DEPLOY_CHECK=1`）——通道已退役，告警不可行动。
  - **原因**：`~/.zcode/cli/plugins/installed_plugins.json` 留着按版本号命名的旧安装路径（basename 恒为 `3.0.4`），每会话注入「引擎 v3.0.8 ≠ 注册表 v3.0.4，存在部署漂移」。
  - **判据**：没人会为消警去改旧注册表，且与"封存"语义矛盾。
- test: 新增「默认不注入部署漂移告警」用例；既有「注册表不一致应告警」用例补 `FG_ZCODE_DEPLOY_CHECK=1`（保持该分支仍有覆盖）。
- 验证：`npm run check` → `366/366`、eval PASS、bridges 3/3、审计隔离 Δ0；探针实测 `guard.mjs start` 输出已无「部署版本核验」字样。

### 2026-10-22 · 层序审查 + 基准重测

- refactor(layer): **体积闸判定内核下沉到母版**（新增 `src/core/outputGate.mjs`）——同一套架构里两个判定走两种做法，就是漂移的温床。
  - **原状**：体积闸此前在 `hooks/guard.mjs`（Claude Code / ZCode 路径）与 `src/dsh/pipeline.mjs`（DSH 路径）**各写一份判定**，而红线判定早已收敛在 `core/redlines.mjs` 一处。
  - **关键判断**：**不能简单合并**——两个宿主的 Grep schema 不同（Claude Code / ZCode 有 `output_mode`/`head_limit`，DSH 只有 `{pattern,path,include}`）。
  - **拆法**：「判定共享 + 参数提取各自」：内核只收语义布尔量（`broadDir` / `contentUnlimited`），翻译留在适配层。
  - **三闸收敛**：`judgeReadGate`（含审计任务豁免）/ `judgeGrepGate` / `judgeCatGate`；两条路径均改调内核。
  - **行为零变化**：`eval` 61/61 + 良性 34/34、`bench:decision` 100% / 误伤 0% 均不变。
  - **测试**：新增 `tests/outputGate.test.mjs` **16 条**（阈值边界 / 审计豁免仅超阈值时生效 / ENOENT 放行 / 两种 Grep 语义 / 裸 cat 与管道放行 / 命令中段 cat / 参数含 cat 字不误伤）。
- fix(layer): `src/core/approvals.mjs` 的 session 缺省值 `'dsh-native'` → `'unknown'`——母版层不该替宿主代言，真实 session 由适配层传入。
- docs: `src/core/env.mjs` 注释更正——原文写「② DSH 宿主直接判 powershell」，但实现里**从未有过该判断**（一直走 `opts.shell` 参数传递）。注释落后于实现，已按实际改写。
- docs: `src/core/decisionEngine.mjs` 补「接入状态」——实测生产路径**零调用**，当前仅 3 个测试使用。
  - **生产路径**：`pipeline.mjs` 直调 `gateToolCall`、`guard.mjs` 走自有判定链。
  - **结论**：保留而非删除；但**接入属行为变更**（改返回结构与审计 trace 字段），须单独评估。
- fix(test): **清掉给假测试续命的死分支**——`pipeline.mjs` 的 `grepContentNoLimit`（依赖真实 DSH 工具不存在的 `output_mode`）已删。
  - **暴露**：两条同类假用例 `gates.test.mjs:85` 与 `decision-bench.mjs:72`，均已改真实参数。
  - **补测**：各补一条「带 `include` 应放行」防误伤。
- fix(docs): 发布状态更正——`focus-guard` 在 npm 上**已发布（3.0.7）**，此前三处 README 误写「未发布 / 404」。
  - **误写位置**：`README.md`、`packages/core/README.md`、`packages/core/README.zh-CN.md`。
  - **extended**：`focus-guard-extended` 确未发布（registry 404），已加 `"private": true` 硬阻止误发（`npm publish` 现直接被拒），依赖由 `^3.0.4` 对齐到 `^3.0.8`。
- chore(bench): `BENCH-BASELINE.json` 同步到 **15 用例 / 150 调用**，但**延迟标尺刻意保留 2.37ms 未放宽**。
  - **原因**：新增两条走 `statSync` 的用例实测约 8ms，若一并放宽即等于把劣化合法化。
  - **说明**：加 `_latencyNote` 说明原委。
- docs: `BENCH.md` 第三节新增「四个注入体量数字辨析」，并标注 545 中约 89 字是版本核验假警报。
  - **四个数字**：**425** 静态 `SESSION_RULES` / **440** DSH 侧注入 / **545** `bench` 读数 / **3425** 场景加权。
  - **假警报**：545 中约 **89 字**来自 `guard.mjs` 版本核验（封存版 v3.0.4 vs 引擎 3.0.8，`seams.mjs` 已修、ZCode 侧未修）。
- docs: `README.md` 常驻注入表按 2026-10-22 实测更新，`RULES.md` 全角/半角分解同步更正。
  - **README**：SessionStart 531→**545**、高危审批闸 175→**推送闸 182**、合计 3404→**3425**。
  - **RULES**：全角/半角分解 260+165 → **246+179**。
- docs: `BENCH.md` A/B 协议重写为七节，并把两组历史 A/B 数据**标为作废**。
  - **七节**：两臂 / 开跑前体检 / 必记字段 / 主指标 / 判定规则 / 禁止清单 / 记账。
  - **作废理由**：10-18 步数不可比、10-19 带病测量；并声明该表为唯一数字源。

### 2026-10-19 · 画像与审计元数据

- feat(profile): **L1 画像包 `evasionRisk` 接线**（ARCH-MAP 主图 L1 第一件）——五份画像新增纯参数字段，解析收敛到唯一真源。
  - **字段**：`evasionRisk`（`high` / `low`，取值标 `TODO(实测)`，当前一律 `high` = 与 3.0.8 行为一致）。
  - **唯一真源**：`src/core/profileLoader.mjs` 的 `approvalScopeOf()`——显式 `approvalGate.scope` 优先，否则 `low` → `irreversible`、`high` / 缺省 / 非法 → `mutating`。
  - **同源**：`checkEligibility.profileScope()` 改为委托它，pre-execute 闸 `gateToolCall` 因此天然同源。
  - **安全边界**：不可逆类别（`rm-rf` / `format-volume` / `drop-database` / `git-push-force` / `write-system-path`）在**任何** scope 下都要审批。
  - **口径**：本字段只能把范围「收窄到不可逆」，永远放不掉它们；审批层仍不可被画像关闭（`FORCED_ON_SWITCHES`）。
  - **数据整理**：`deepseek-flash` / `deepseek-pro` / `glm` / `default` 去掉冗余的 `scope: 'mutating'`（= 派生默认值，行为不变）。
  - **`gpt-astra`**：保留显式 `scope: 'irreversible'`，并用例锁死「显式优先」。
  - **测试**：`tests/profile.test.mjs` 新增 g1-g4（五画像派生回归锁 / 派生三分支与显式优先 / low 放行 `publish` 但 `rm-rf` 仍转人工 / 闸与母版同源）。
  - **实测**：`node --test packages/core/tests/profile.test.mjs` **12/12** 通过。
- docs: `ARCH-MAP.md` 同步——L1 `evasionRisk` 由 ⬜ 改 ✅，缺口 #2 改为「剩余两件」，并新增缺口 #5「**缺 3.0.8 面板基线**」（本轮人类确认暂无面板数据，故不出环比表、不编造基线）。
- feat(docs): **P2 回流台账（伪 RLHF 最小闭环）**——新增 `packages/core/docs/PROFILE-TUNING.md`，**本轮可批的数值改动 = 0 条**。
  - **流程**：人工批准制四步（采数据 → 建议 → 人类批准 → 改画像再测）。
  - **快照-基准**：`bench:decision` 100% / 误伤 0 / p95 2.79ms；`bench:tasks --ab` 57/57 双向、介入 15 次应拦 15 误伤 0。
  - **快照-审计**：`AUDIT.log` 10-18~19 共 3,132 行、deny 139 行 / 13 会话及 trigger 分布，快照 `2026-10-19T20:17:18+08:00`。
  - **T1 / T4**：`evasionRisk` 保持 `high`、`approvalGate.scope` 保持派生。
  - **T2**：`budgetGate.ceiling` 已有初步数值但缺判据（`budget-extend` 19 行 / 3 会话，分母 53 会话 ≈ 5.7%）。
  - **T3**：`stalledFuse.threshold` 连指标都没有（缺 step 边界）。
  - **T5**：误伤口径扣除 `evidence-gate` / `gate:fg_apply`。
  - **口径修正**：`evidence-gate` 的 deny 是设计内「首次改动提醒」（拒一次、重试即放行），`bench:cost` 的 `falsePositiveRatio` 必须扣除它，否则高估误伤。
  - 边界：不做自动调参、不做无人批准的回写；自动化只允许只读汇总。
- docs: `ARCH-MAP.md` 同步——L6 闭塞项补「回流台账已建、本轮 0 条可批」，缺口 #3 改为「缺测量侧而非回流侧」。
- feat(audit): **审计行补 `turn`/`step` 元数据 + 熔断浪费按会话独立计数**（人类批示）——此前 `AUDIT.log` 只有 `seq`，"熔断后浪费了几步"算不出来。
  - **原状**：`seq` 是进程内序号，跨会话不可比，`stalledFuse.threshold` 无从校准（缺口 #3）。
  - **来源单一**：`{turn, step}` 取自 `agent/pre-step` 载荷（`dsh-agent-loop/lib/index.js:956`）。
  - **不由 exec 猜**：`tools/pre-execute` 的 exec 里没有这两个字段（`dsh-tools/lib/index.js:3239`），故由 `src/dsh/traceMeta.mjs` 记录。
  - **注入单点**：`src/core/audit-writer.mjs` 新增 `setTraceMetaProvider()`，所有写点自动带 `turn`/`step`。
  - **写点**：`auditDeny` / `auditEligibility` / `compactionWatch` / `preGuard` / `stopGuard` / `postProgress` / `seams`。
  - **口径**：行里已有值时以行为准；provider 抛错按"无元数据"处理，绝不阻断留痕。
  - **结算**：`agent/turn-stopping` 调 `recordFuseWaste()`，**只在本回合真熔断过时**写一行 `action:"fuse-waste"`。
  - **口径**：`wasted = 回合末 step − 熔断 step`（被拦也算一步）；换回合作废上一回合熔断点。
  - **按会话独立计数**：每会话 `step` 从 1 起，跨会话不可相加。
  - **`bench:cost`**：新增 `report.fuseWaste`（`stallFuse` / `withMeta` / `bySession`）；历史 57 次熔断无元数据 → 明确报"带元数据 0 次、无法回溯"，不假装能算。
  - **测试**：新增 `tests/trace-meta.test.mjs` 6 条（provider 注入 / 显式值优先 / 无 provider 不添加 / pre-step 记录 / fuse-waste 结算 / 换回合作废 / 两会话互不相加）。
  - 验证：`npm run check` → `337/337`，`audit-isolation` Δ 0 PASS。
- docs: `BENCH.md` 增「熔断浪费（fuse-waste）」小节（来源、口径、命令）。
  - **ARCH-MAP**：缺口 #3 改为「T3 指标已补、待样本」。
  - **PROFILE-TUNING**：T3 状态改为「指标已可达（待样本）」并补 `fuse-waste` 快照行。
- feat(gate): **反规避抽查B 参数化（不可预测检查点，人类批示）**——`ARCH-MAP` L5 的「2-5 次随机熔断」此前只有抽查A，两者混在一个参数里。
  - **原状**：抽查A 是确定性每 5 次全量审计。
  - **独立参数**：**与抽查A 完全独立**，**默认开**（人类批示；`FG_RANDOM_FUSE=0` 关闭）。
  - **间隔**：在 `[RANDOM_FUSE_MIN=2, RANDOM_FUSE_MAX=5]` 次写操作间**随机**（`core/constants.mjs`）；`FG_RANDOM_FUSE_EVERY=N` → 固定间隔（运维/测试用，优先级更高）。
  - **语义**：post-execute 只能"挂检查点"（那次写已经发生，无法回滚），由 pre-execute 第 3 层对**下一次**变更型调用**拒一次**。
  - **手感**：与取证闸一致——审计 `trigger:"random-fuse"`，重试即放行；状态回写失败时**不拒**（宁可不拦也不做永久死锁）。
  - **生命周期**：换回合作废检查点，写操作计数（会话级）保留。
  - **计数与留痕**：`fuseOps` 独立于抽查A 的 `writeOps`；命中写 `action:"random-fuse"`（含第几次写操作、间隔、超出阈值几次）。
  - **测试**：新增 `tests/random-fuse.test.mjs` 6 条（默认开启随机 2–5 / 固定间隔第 3 次命中 / 拒一次后放行且 trigger 正确 / 与抽查A 独立 / 换回合作废 / 随机间隔两端可达）。
  - 验证：`npm run check` → `346/346`，`audit-isolation` Δ 0 PASS。
- docs: `ARCH-MAP.md` L5「反规避 · 不可预测检查点」🟡 → ✅（**默认开**，`FG_RANDOM_FUSE=0` 关闭）。
  - **缺口 #4**：改为「已默认开 + RULES 条款已补」。
  - **版本路线**：新增该节（3.5 重置文档 / 4.0 剥离旧 hook 或升级用法）。
- docs(rules): **`RULES.md` 补第三十五条(二) 反规避抽查B**——技术映射表与实施差异备忘同步。
  - **条款口径**：默认开、2–5 随机、拒一次即放行、`random-fuse` 留痕、会话级计数。
  - **实施差异备忘**：新增 **v3.0.8 现状对齐**条目（收录 3.0.x 的按需自证/人工闸门/审计 turn·step/取证键归一化/evasionRisk/AGPL）。
- docs: `ARCH-MAP.md` L5「反规避 · 不可预测检查点」🟡 → ✅（默认关）。
  - **缺口 #4**：改为「默认关闭 + 未写入 RULES，待人类批示」。
- fix(gate): **取证闸「读过仍被拒一次」的真根因——取证键没归一化**——同一文件两种写法，查不到即判「未读」。
  - **原状**：读记录侧 `rememberReads` 存宿主给的**原始路径**（相对），查证侧存 `resolveToolPath()` 后的**绝对路径**（`join(cwd, rel)`，Windows 带反斜杠）。
  - **后果**：靠 `evidenceBlockedOnce` 的「拒一次」逃生阀放行，表现就是"每次首次改都要被拦一次"。
  - **修法**：新增 `evidenceKeyOf()`（绝对化 + 统一正斜杠）、`sameEvidenceKey()`（Windows 大小写不敏感）、`isReadRecorded()`（先查归一化键直命，再兼容历史/异形态键逐个解析比对）。
  - **接线**：`rememberReads` 改写归一化键，`layer3Check` 的 `known` 判定改用 `isReadRecorded`。
  - **未放宽闸门**：真没读过的文件仍拒一次（用例 e3 锁死）。
  - **回归**：新增 `tests/evidence-relative-path.test.mjs` 3 条（相对路径读后改应放行 / 跨正反斜杠形态应放行 / 未读就改仍拦）。
  - **同步修正**：`tests/state-ownership.test.mjs` 的 readSet 断言到归一化键。
  - 验证：`npm run check` → `346/346`，`audit-isolation` Δ 0 PASS。

## 3.0.7 · 2026-10-18（Trusted Publishing 首发）

> 本节记录 3.0.7 的增量。首次通过 GitHub Actions OIDC（Trusted Publishing）发布，包内容不含任何长期凭据。对应提交：`8f58bcf` / `861e9a7` / `cd7ad36` / `2d04d53`。

- feat(runtime): **心跳与存活确认**——`heartbeat.mjs` 每 10s 原子覆写 `.focus-guard/status.json`（tmp→rename），`unref()` 不拖住宿主。
  - **判活**：`status.mjs` 按需判活，exit `0` 全绿 / `2` 缺模块 / `3` STALE（>30s）/ `4` 文件缺失。
- feat(runtime): **11 模块启动自检**——10 条执法缝 + 心跳各自报到（`markModule`）；心跳首写延后一 tick，避免首帧少报自己。
  - **缺项**：写 `degraded`、宿主日志 warn、模型侧注入 `focus-guard-degraded` 段。
- feat(l4): **跨会话卷宗按路径哈希路由**——`workspace.mjs` 以 `sha256(realpath(cwd))` 前 16 位为身份，**hash 不符零注入**。
  - **存储**：`.focus-guard/workspace.json` 存决策/约束/下一步（各限 10 条、每条 200 字、注入 ≤1200 字）；改文件夹名即彻底屏蔽。
  - **写入**：回合结束（`agent/turn-stopping`）自动落账，只记 FG 亲眼看到的事实。
- feat(gate): **第 1.4 层整文件读取闸**——目标 >300 行且无 `offset`/`limit` 即 deny，提示改用 XERJ `search`/`def`。
  - **参数**：`FG_WHOLE_FILE_MAX_LINES` 可调；分块数换行、够数即停，不整文件读入内存。
- feat(gate): **第 1.3 层 Superpowers 动笔闸**——判据三件套（开发动词 + 模糊标记 + 无验收词）同中才触发。
  - **拦截**：首次改文件/写文件/破坏性 shell deny 一次，要求先加载 `brainstorming` / `writing-plans`。
  - **防死锁**：同条重试与已加载均放行。
- fix(gate): **破坏性 API 按目标分级**——旧实现只看动词、权重恒 0.6，清 TEMP 单文件与递归删系统目录同分。
  - **旧毛病**：`Remove-Item` + 任意重定向即 0.9 越线。
  - **现分级**：系统路径/递归 0.9（拦截）、TEMP 0.2、其他 0.4、重定向 0.15。
  - **回放**：历史 39 条误伤样本全部降到阈值下（最高 0.45）。
- fix(gate): **红线射程补两处**——长旗标写法 `rm --recursive --force X`（旧短簇正则认不出 `--force`）与系统顶层目录（`/usr` 等）；`/tmp` 刻意不收，避免误伤构建。
- fix(audit): **`FG_AUDIT_FILE` 优先**——`core/audit.mjs` 的 `auditTarget` 只认 `ZCODE_PROJECT_DIR`/`CLAUDE_PROJECT_DIR`。
  - **后果**：`risk.mjs` 的 `penalize()` 成为第四个写点、测试重定向对它失效（CHANGELOG 3.0.6 所称"零增长"实测不成立）。
- fix(audit): **deny 记录真实 trigger**——此前一律写 `high-risk-rm`，`ls -la` 也被记成强删。
  - **签名**：`auditDeny(exec, cmd, {trigger, level})`。
  - **10 处调用点**：`redline:<name>` / `env-substitute` / `gate:fg_apply` / `evidence-gate` / `whole-file:lines` / `volume:*`。
  - **其余**：`superpowers:writing-gate` / `risk:<category>`。
- fix(env): **执行体判定不再三方矛盾**——母版认显式 `FG_SHELL`，DSH 适配层在 `apply()` 声明执行体为 `powershell`。
  - **结果**：卷宗【一】/指纹/实际执行从此一致（实测 `powershell 5.1.26100.9444`）。
- fix(seams): **42 条版本核验退旧账**——封存版此前被"并入候选表"而非跳过，每会话误报一次部署漂移；改为 `SEALED` 命中即 skip。
- feat(watch): **压缩监察**——`compactionWatch.mjs` 只观察 `compaction/start|end|prune` 与 `agent/request-error` 撞窗并留痕。
  - **口径**：`action=compaction*`；不写 surface、不 cancel；压缩归 DSH 内置栈，第三方不再重复实现。
- fix(test): **审计零增长守卫**——`tests/audit-isolation.mjs` 跑测前后比对真实 `AUDIT.log`，有增长即 exit 1。
  - **接线**：`test`/`test:all` 改经守卫运行。
  - **双向验证**：干净 Δ0 PASS、故意污染 Δ1 FAIL。
- chore(audit): **历史测试夹具清理**——剔除 882 条 `deny`+`session=dsh-native` 历史污染（双备份 + 并发追加保护 + `audit-purge` 留痕），保留 71 条真实会话拦截。

## 勘误 · 历史 commit message 的行数口径（2026-10-09）

三条 `refactor(core)` 提交的 message 中，`guard.mjs` 行数与实际不符。**不改写历史**（不 force push），正确数字以下表为准：

| commit | message 声称 | 实际 | 差额 |
|---|---|---|---|
| `1f630c8` | 159 | **1707** | +1548（来源不明，疑为误抄） |
| `3aaf56d` | 1228 | **1348** | +120（≈ 该文件空行数） |
| `71199e7` | 1042 | **1142** | +100（≈ 该文件空行数） |

实测口径：已提交版本 `git grep -c '' <commit> -- packages/core/hooks/guard.mjs`；工作区版本 `(Get-Content <file>).Count`。父提交链 `1893 → 1707 → 1348 → 1142` 与三次拆分的 `git diff --numstat` 互相印证。

后两条差额与空行数吻合，说明当时用了**不数空行**的计数方式（如 `Measure-Object -Line`）。故立口径纪律：**`Measure-Object -Line` 禁止用于行数报告**（它漏数空行），一律用 `git grep -c ''`（已提交）或 `(Get-Content).Count`（工作区），改动量引用 `git diff --numstat`。

## 3.0.6 · 绝对红线上下文豁免与条款清理

- feat: **绝对红线上下文豁免**（HANDOFF §八）
  - **做法**：`core/redlines.mjs` 新增 `redlineExempt()`，三条判据。
  - **判据 1**：命中片段完整落在引号字面量内（`quotedSpans()` 解析 `'…'`/`"…"` 并处理反斜杠转义）。
  - **判据 2**：片段前有显式数据标记（`示例：`/`例如：`/`测试数据`/`prompt:`/`【假设】`/ 代码围栏），且命令非变更类（复用 `isMutatingBashCmd`）。
  - **判据 3**：首 token 属只读输出命令（已剥离 `sudo`/`env`/`xargs` 前缀）。
  - **口径**：豁免只把裁决**降级到第 2 层语义预判**，绝不直接放行。
  - **留痕**：`pipeline.mjs` pre-execute 豁免时写 `AUDIT.log`（`action:"redline-exempt"`、`trigger`、`basis`、`evidence`）后继续下传。
- fix: 豁免**排除执行外壳**
  - **原状**：`bash -c "rm -rf /"`、`node -e "…execSync('rm -rf /')"` 的危险内容同样在引号内，但那是真执行。
  - **做法**：`SHELL_EXEC_WRAPPER_RE` 命中即不豁免。
  - **范围**：shell `-c` / `cmd /c|/k` / `eval` / `exec` / `iex` / `Invoke-Expression` / 解释器 `node -e`·`python -c`·`perl -e`。
  - **口径**：与既有 R5-3 解释器黑名单一致。
- chore: `docs/RULES.md` 删除已废止条款正文及未机械化清单中的废止残留（条款 91→87，编号空缺保留以维持既有交叉引用不漂移）。
- docs: CHANGELOG 补勘误小节，记录历史三条 `refactor(core)` 提交的行数口径与正确数字（不改写历史）。
- feat: **误伤申辩程序**（司法救济通道，补齐外部审计指出的结构缺口）
  - **做法**：新增 `fg_appeal` 工具（`adapters/dsh/fg-appeal-tool.mjs`）与 `appealAsk` / `grantFromAppeal` / `hasRedlineGrant`。
  - **顺序**：`pipeline.mjs` 在**所有闸之前**处理申辩，否则申辩参数携带的被拦命令原文会被同一规则再拦一次，形成死锁。
  - **裁决**：返回 `{kind:"ask"}` 经 DSH approval seam 交人类**一次性裁决**。
  - **批准**：开通该工具一次授权（`ttl=turn`）+ 豁免本次命中红线（`redline:<name>` 凭据，红线层可查）。
  - **拒绝**：维持拦截；全程留痕 `appeal-filed` / `appeal-granted` / `appeal-denied`。
  - **条文**：见 `RULES.md` 第八十三条(四)——同时**更正**该条(三)「仍走第十二章」的条文错配（第十二章为「反规避与纪律审查」，非申请执行流程）。
- test: 画像链路端到端集成测试 `tests/integration.test.mjs`（16 用例）——验证 fg_apply→授权→闸放行闭环、画像跳层、红线豁免与资格闸的边界、授权回收与会话隔离。
- fix: **画像与豁免在真实入口失效**（集成测试挖出、逐条修复）
  - **① 形参**：`applyEligibility` 新增 `profile` / `modelId` 形参并透传，此前真实 fg_apply 路径 `profile=null`、画像全失效（差异只在 `decide()` 可达）。
  - **② 母版**：母版 L2 命中红线后接入 `redlineExempt`，与 pipeline 文本层同口径（豁免则**降级**不 deny），此前"文本层豁免、母版仍 deny"。
  - **③ 闸**：`gateToolCall` 接入 `profile` 并按同一 `scope` 判定，消除"闸与母版不同源"。
- fix: **审批层不可被画像关闭**（安全项）
  - **做法**：`profileLoader` 新增 `FORCED_ON_SWITCHES` / `enforcePolicy`，画像试图关闭 `approvalGate` 时强制启用并告警。
  - **口径**：母版 L3 不再查 `layerEnabled`，只认 `scope`。
  - **原状**：此前"画像关 L3 + 闸只认授权表"可让审批端到端绕过。
- feat: **`approvalGate.scope` 由死配置变为真判定**
  - **新增**：`IRREVERSIBLE_IDS`（rm-rf / format-volume / drop-database / git-push-force / 系统路径写入）与 `profileScope()`。
  - **判定**：`scope:'irreversible'` 时非不可逆高危放行、不可逆类仍须审批。
- feat: **画像接入真实 pre-execute 链路（最后一公里）**
  - **原状**：`pipeline.mjs` 的资格闸此前不传 `profile`，画像只在 `decide()` / `applyEligibility` 两条路可达、实际运行时失效。
  - **做法**：从 `exec` 提取模型标识（`exec.agent.model` / `exec.agent.modelId` / `exec.model`，与成本台账同源）翻成画像交闸，`FG_MODEL_ID` 作显式兜底。
  - **默认**：取不到时为 `null` → 闸按最严 `mutating`（安全默认）。
  - **影响**：红线层不含画像开关，不可被画像放行。
- fix: **版本面补全**
  - **原状**：monorepo 子包 `packages/core/package.json`（DSH 实际挂载的包，也是 GUI 里显示的版本来源）与 `packages/extended/package.json`、外接桥的版本标识此前未纳入版本面。
  - **后果**：出现"清单齐 3.0.4 而代码已 3.0.6"。
  - **做法**：现共 **8 处**版本点由断言锁定"彼此相等 **且** 等于 CHANGELOG 最新条目"。
- fix: **缺陷 3（闸与红线口径不一致）**
  - **做法**：`gatedReasonOf` 命中 `HIGH_RISK_TOOLS` 后先问 `redlineExempt`，豁免成立则不进门槛清单。
  - **口径**：`write-system-path` 是路径检查，不套命令豁免。
- fix: **缺陷 6（判据名不稳定）**
  - **做法**：新增 `redlineSpan()`——裁掉命中片段尾随的空白与收尾引号（**不含 `/`**，`rm -rf /` 的 `/` 是目标路径本体），使 span 稳定落在危险片段本体上。
  - **影响**：这不只是判据名变化，判据 1 的适用面按设计意图扩大了一档——形如 `foo "rm -rf /"`（head 既非只读命令、也无数据标记）从"不豁免"变为 `quoted-literal`。
  - **反证**：`rm -rf "/"` 裁剪后 span 与引号内容区间不相交仍不豁免，执行外壳仍由 `SHELL_EXEC_WRAPPER_RE` 拦。
- fix: **FG 自身缺陷：取证闸对"新建文件"死锁**
  - **做法**：`layer3Check` 的取证判定加 `existsSync` 门——目标不存在（新建）直接放行，仅对**已存在**文件的修改要求先读。
  - **原状**：此前新建文件无既有内容可读 → 永远进不了 readSet → 只能靠"拒一次后豁免"逃生。
- docs: **L3 是否接豁免的判定**（外部接手模型提出）：**不接**
  - **口径**：闸是"无授权即 deny"（无人类环节，须自判豁免），L3 是"转人工审批"（人类环节即裁决）。
  - **理由**：若 L3 也豁免，"数据形态的高危命令"会无人审批直接放行，风险不对称。
  - **落点**：判定已写入 `checkEligibility.mjs` 第 3 层注释，防后人当缺陷改回。
- fix: **测试污染真实工作区**
  - **原状**：跑测试时审计流水写进真实 `<仓库>/.focus-guard/AUDIT.log`（实测 2630 行 / 746 个测试 session）。
  - **根因①**：`auditDeny` 写死 `AUDIT_FILE`，而**同一文件**的 `auditRedlineExempt` 支持 `FG_AUDIT_FILE`（一文件两种口径）。
  - **根因②**：`acceptance.test.mjs::makeRunner` 直接透传 `process.env`，宿主设的 `CLAUDE_PROJECT_DIR` 让 `guard.mjs` 定位到真实工作区。
  - **根因②补充**：原注释"无 ZCODE_PROJECT_DIR 即退回临时目录"的假设失效。
  - **根因③**：`eligibility.test.mjs` 只在两个审计用例内设重定向，且 `finally` 里 `delete` 掉它、把沙箱一并删除（该文件顶部"审计一律注入 mock"的承诺从未成立）。
  - **做法**：`auditDeny` 补重定向 · `makeRunner` 显式置空两个工作区根变量（`...env` 保持最后，用例覆盖仍生效）· `eligibility.test.mjs` 顶部统一沙箱、用例内改为"恢复"而非 delete。
  - **验证**：跑全套后 AUDIT.log 零增长（历史污染已清理，备份于 `.ai/archive/`）。
- docs: 文档同步（外部接手交付，Lead 审计通过）
  - **README**：badge 3.0.4→3.0.6 · 问题→能力对照表 · 母版/适配/宿主缝三层表 · DSH 两条路互斥对比。
  - **README 版本面**：`ENGINE_VERSION` 从 **3.0.0** 修正为 3.0.6 并补 8 处版本面。
  - **INSTALL**：新增「2A. 原生插件（推荐）」节、卸载命令区分原生插件/官方桥。
  - **SKILL**：`skills/focus-thinking/SKILL.md` 的"生效版本"从 `hooks/guard.mjs v3.0.0` **修正为** `ENGINE_VERSION`。
  - **SKILL 理由**：guard.mjs 已封存，不该再代表生效版本；并修正 monorepo 后的 `docs/RULES.md` 路径。
  - **HANDOFF**：`docs/HANDOFF-TO-EXTERNAL.md` 补交付验证与 ENOENT 踩坑记录。

- feat: **审计日志体积轮转**
  - **原状**：`AUDIT.log` 此前 append-only 且无轮转，长期运行无限膨胀（本次事故即累积到 2997 行）。
  - **做法**：新增 `rotateAuditIfNeeded()`：超上限（`FG_AUDIT_MAX_BYTES`，默认 5 MB ≈ 2 万条）时移入同目录 `archive/AUDIT.log.<时间戳>` 并重建空文件。
  - **保留**：保留最近 `FG_AUDIT_ARCHIVE_KEEP`（默认 10）份。
  - **纪律**：**只归档不删除**（执法记录不得丢）· 失败只 `warn` 不阻断 · 轮转失败**继续追加原文件**（宁可变大、不可丢记录）· 文件不存在（首写）静默放过，不刷噪音。
  - **影响**：⚠ 封存的 `hooks/guard.mjs`（ZCode 层）不经此处写入，**不受本机制管辖**——这是封存的代价。
- refactor: **审计写入收敛到单一入口** `appendAudit()`
  - **原状**：三处写点（`auditDeny` / `auditRedlineExempt` / `auditEligibility`）此前各写各的，正是"同一文件两种口径"的温床（污染事故根因之一）。
  - **做法**：现共用同一入口，轮转只在一处生效，口径不可能再分叉。

- chore: **发布元数据补全**（dsh-market 收录前置）
  - **做法**：`packages/core/package.json` 声明 `@deepseek-ai/dsh-tools` 为 **`peerDependencies`** 并标 `optional`（工具注册属可选加载）。
  - **范围**：`>=0.1.0-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`（**显式预发布分支**，覆盖宿主 `0.2.0-rc.2` 元组）。
  - **口径**：按 dsh-market 规则，不带预发布分支的范围会静默排除所有 rc 构建，用户装时会遇到 `ERESOLVE`。
  - **原状**：此前包声明零依赖而代码实际 `import` 该包。
  - **补充**：另补 `packages/core/README.md` 与 `LICENSE`——此前 `license: MIT` 只是声明、无对应文件，npm 包页面会空白。

- fix: **DSH 侧状态所有权**（孤儿机制审计的第一步）
  - **原状**：原生插件此前**没有 state 写入者**（唯一写者是 `guard.mjs`，而它在 DSH 下未挂载）。
  - **后果①**：取证记录（`readSet`）无法落盘，模块重载（HMR）/进程重启后凭空消失。
  - **后果②**：`layer3Check` 走 `readGuardState(undefined)` 退化成"扫 `os.tmpdir()` 取 mtime 最新"，会读到**别的会话或测试残留**。
  - **实测①**：该目录有 199 个 `focus-guard-eval-*`（会被过滤）外加 acceptance/selftest 写的 `focus-guard-<sid>-<RUN>.json`（**过滤不掉**）。
  - **实测②**：于是拿别人（往往是空的）readSet 去判你的真实改动，表现为"拦不拦你取决于最近跑没跑测试"。
  - **做法①**：`rememberReads` 把 readSet 落盘到 `statePath(sessionId)`（原生插件的第一处 state 写权，KPI／预算池等机制后续依赖它）。
  - **做法②**：新增 `readGuardStateExact()`，按会话身份**精确定位**、绝不做目录扫描。
- fix: **内存取证集合跨会话泄漏**
  - **原状**：`nativeReadSet` / `evidenceBlockedOnce` 原为模块级单一 `Set`（按路径索引、不含会话身份），而 DSH 单进程内多个会话共用同一份 `pipeline` 模块。
  - **后果**：「会话 A 读过的文件」被判成「会话 B 也读过」，违反取证的本会话语义。
  - **做法**：现按会话身份分表（`Map<sid, Set>`）。
- test: 新增 `tests/state-ownership.test.mjs`（6 用例）——落盘、判定、**抗他人状态干扰**、会话隔离、无状态 fail-open 且留痕、真实工作区零写入。
- docs: **孤儿机制审计结论**（本次定级修复级的缘起）
  - **两条路互斥**：DSH 侧另有两条**互斥**接入路径，能力二选一。
  - **原生插件**：`pipeline.mjs`（在跑）提供资格审核／申辩／画像／命令硬校验／红线豁免。
  - **官方桥**：`hooks.json` → `guard.mjs`（**未装**）承载 KPI／三预算池／高危审批单／抽查／污染检测／因果链／积木图书馆／降级／绝境／卷宗指纹等机制。
  - **常量口径**：`constants.mjs` 的 42 个导出常量中 **28 个在 DSH 侧零消费者、9 个仅被 `state.mjs` 引用（只存不判）**。
  - **不是死代码**：它们由 `guard.mjs` 消费、经桥调用，但当前 profile 未装桥故此刻不生效。
  - **缺口**：README/INSTALL 只声明了单向差异（"桥不含资格审核"），未声明反向。
  - **后续**：按「移植 + 退役、先搬后删」把机制搬进原生插件，再退役 `guard.mjs`。
  - **另注**：`selftest.mjs` 曾有 **6 项失败**（4 项过期断言、1 项环境指纹的预期拦截、1 项用了不存在的目标文件因而测不到"未取证"），本次一并修正。
  - **CI 闸**：`npm run check` 由 `test && eval`（2 套）扩为 `test:all + eval + selftest + bridges`（5 套，230 个断言）。
  - **覆盖缺口**：此前 `integration` / `state-ownership` / `profile` / `eligibility` / `bridges` / `selftest` 都不在闸内，红了无人知晓。

- feat: **原生插件补上缺失的三条宿主缝 + KPI 兑现移植**（孤儿机制移植第一步）
  - **做法**：新增 `src/dsh/seams.mjs`，按官方桥（`@deepseek-ai/dsh-hooks-claude-code`）的**实测映射**接上三条缝。
  - **`agent/created`** → SessionStart（建立本会话状态）。
  - **`agent/pre-step`** → UserPromptSubmit（回合重置；**waterfall 必须 `return next()`**，否则吞掉下游决策）。
  - **`agent/turn-stopping`** → Stop（**KPI 兑现结算**：本任务 KPI → 等次 → 委托池奖惩，跨任务累计入 `kpiCarry`，留痕 `kpi-settle` / `kpi-low`）。
  - **口径**：映射来源是桥的已验证代码、非猜测。
  - **影响**：`constants.mjs` 的 `BUDGET_CAP` / `DELEGATE_DEFAULT` 由此在 DSH 侧**首次被真正消费**——此前它们属于那 28 个零消费者常量。
- test: 新增 `tests/seams.test.mjs`（6 用例）
  - **覆盖**：start 建状态并留痕 · reset 必须 `return next()` · KPI 优秀 +5 且跨任务累计 · 不称职 −5 且 `kpi-low` 只提醒一次。
  - **其余**：三条缝异常一律不阻塞 · 真实工作区零写入。
  - **规模**：CI 闸门至此为 **6 套 / 235 个断言**。

- feat: **移植批 1：批示识别与回合重置（`reset` 133 行）**
  - **做法**：`preStepListener` 由骨架补齐为完整实现，照搬 `guard.mjs` L194-326。
  - **覆盖**：特赦识别 · 目标预授权（只记 goal、不解锁执行）· 信用延期（停滞≥2 且收到信用批示 → 侦查/执行池各补 `REFILL`）。
  - **覆盖续**：追加批示（三池各 +`REFILL`）· 残留核验（43 条）· 额度核定（`KEY50_RE`/`KEY15_RE`）。
  - **停止令**：`STOP_ORDER_RE` → 熔断；且不再被本函数后续的硬写回抹掉——那是 guard.mjs 2.5.2 修过的老 bug。
  - **y/n 授权**：y 放行全部待批并目标绑定、n 彻底阻断且清除历史绑定。
  - **影响**：`constants.mjs` 的 `MERCY_RE` · `CREDIT_RE` · `STOP_ORDER_RE` · `KEY50_RE` · `KEY15_RE` 由此**首次在 DSH 侧被消费**。
  - **影响续**：`BUDGET_DEFAULT` · `BUDGET_CAP` · `REFILL` · `INV_POOL_DEFAULT` · `DELEGATE_DEFAULT` 亦同。
- fix: **会话标识取值口径**
  - **做法**：`agent/created` 等缝的会话 id 应取 `agent.session.header.id`（与官方桥 `lib/index.js:349-354` 同源）；`projDir` 同步改用 `session.header.cwd`。
  - **原状**：此前误写为 `agent.session.id` 会取不到，于是**所有会话退化成同一个 `'dsh-native'`、状态互相覆盖**（与刚修掉的跨会话泄漏同类）。
- test: `seams.test.mjs` 扩到 11 用例（新增停止令熔断 · 三池追加 · 额度核定 · y/n 授权与目标绑定 · 非批示文本不误判）。CI 闸门至此 **6 套 / 240 个断言**。

- feat: **移植批 2：体积刺客三闸 + 污染核实闸 + 风险文件留痕（约 48 行）**
  - **接线**：`preExecuteListener` 新增五段，插在资格闸之后、第 2 层语义预判之前。
  - **① Read 整读体积闸**：超 `OUTPUT_GATE_BYTES` 拦，并**保留 2.5.3 的审计任务豁免**——法典把审计定为 50 预算重大专项，体积闸却拦审计最需要的整读，属制度性误伤。
  - **② Grep 闸**：content 无 `head_limit` 即拦。
  - **③ 裸 `cat`/`type` 刷屏闸**：在本环境**不可达**（第 1.5 层环境指纹 `cat`→`bat` 先拦），保留作兜底。
  - **④ 污染核实闸**：上轮输出与参数矛盾 → 首个改动类拦一次、一次性。
  - **⑤ 风险文件 100% 留痕**：`.github/` 等，只记不拦。
  - **有意不搬**：高危命令闸与脚本写入闸（依赖审批单机制，与资格闸的关系待定）· 触发①/盲写检测（已被第 3 层按文件覆盖）。
  - **裁剪理由**：硬搬会造成"一个命令被拦两次"或两条路冲突。
- fix: **参数遮蔽导致两段新闸静默 fail-open**
  - **原状**：`preExecuteListener({ …, statePath })` 的**参数名 `statePath`** 遮蔽了从 `state.mjs` import 的同名函数。
  - **症状**：函数体内 `statePath === undefined` → `statePath is not a function`。
  - **后果**：被 `try/catch` 的 fail-open 吞成放行（安全上正确，但 bug 完全静默，靠 `warn` 输出才抓到）。
  - **做法**：现 import 改用别名 `guardStateFile`，并加注释说明原因。
- test: 新增 `tests/gates.test.mjs`（8 用例）。CI 闸门至此 **6 套 / 248 个断言**。

- refactor: **审批单机制退役（`fg_apply` 为唯一授权入口）**
  - **缘起**：按人类批示（2026-10-10），审批单只需敲一个 `y`，**无目的、无范围、无留档**；与 `fg_apply`（要求 purpose/scope 结构化留档）并存时，人会本能选省事的那条，使"事前结构化申请"形同虚设。
  - **判据**：**留一条能绕过主设计的旁路，等于没有主设计。**
  - **代码**：`seams.mjs` 移除批 1 照搬的 y/n 批示识别（`Y_TOKEN`/`N_TOKEN`/`LEAD`/`TAIL`）与待批队列处理，以及 `highRiskDeniedThisTurn` 死字段（保留退役说明注释）。
  - **修法**：RULES 第七十五条(三) **实质保留**（"推送远端属对外发布行为，须审批"），授权方式由"出具【高危申请】审批单 + 领导回复 y"改为"**须先调 `fg_apply` 取得授权**（附 purpose/scope 结构化留档）"。
  - **配套**：(四) 合并审批与批示词容错**标注废止**；第二十四条删去"「同意」即审批单放行"之注；第八十三条(三) 由"不替代审批单"改指 `fg_apply`；技术映射表两行同步。
  - **沿革**：**立法沿革保留**（与第十九条「（已废止·编译版 v1.1）」同例）。
  - **验收**：`acceptance` 的"文档-实现对齐"断言从**锁定 y 放行口径**改为**锁定 `fg_apply` 口径**，并新增"审批单口径不得残留"的反向断言。
  - **不受影响**：`fg_appeal` 误伤申辩——它不是绕过而是救济（须附反例锚点、人类一次性裁决、全程留痕）。
- test: `seams.test.mjs` 的 y/n 授权用例改写为"审批单退役后 `y` 不再构成任何授权"（断言 `highRiskOk` 未被设置、无 `high-risk-approved` 留痕）。

- feat: **移植批 3：post-execute 进度与执法缝（242 行）**
  - **做法**：新增 `src/dsh/postProgress.mjs`，与 `postExecuteListener` **同事件并列监听**，移植自 `guard.mjs` L666-907。
  - **进度检测引擎**：响应/入参签名比对，判定有效 vs 无效调用。
  - **三预算池核算**：执行池/侦查池分列，自动续杯、硬上限熔断、侦查池超限。
  - **停滞熔断**：连续无效达 `STALL_FUSE` → 熔断 + 预警。
  - **污染检测**：58 条上下文污染检测（`head -n N` 行数对账、清单路径重复 → 设 `pollutionFlagged`）· 巨量输出事后追责。
  - **其余**：子代理摘要校验（KPI ±3）· **强制委派场景检测**（KPI ±5）· **抽查 A**（每 `RANDOM_AUDIT_EVERY` 次写操作全量审计）· 卷宗指纹与 TTL 依据（`caseCache`）。
  - **口径**：工具名按 DSH 适配（`Agent`→`agent|subagent`、`Bash`→`pwsh|bash`、大小写不敏感）。
  - **闭环**：本批设置 `pollutionFlagged`，批 2 已搬其消费侧——跨模块用例锁定"post 标记 → pre 拦一次 → 重试放行"。
- fix: **会话标识取值口径（第二处、更严重）**
  - **原状**：`audit.mjs` 的 `sessionOf` 与 `pipeline.mjs` 的 `sessionIdOf` 只认 `exec.sessionId`/`agent.sessionId`/`agent.id`。
  - **症状**：**三者皆空** → 全部退化成 `'dsh-native'`。
  - **实测**：真实 `AUDIT.log` 里 **439 条**记录都记在 `dsh-native` 名下，而取值正确的 `seams.mjs` 写的是 `sess_<uuid>`——即所有会话共用一份状态文件与一条审计流。
  - **做法**：现统一为桥的口径（`agent.session.header.id` 优先）。
- fix: **`postProgress` 误用母版 `audit` 会写真实工作区**
  - **原状**：母版 `audit()` 按 `auditTarget()` 落盘，优先读 `ZCODE_PROJECT_DIR`/`CLAUDE_PROJECT_DIR`，而 DSH 下后者被设置。
  - **后果**：会写真实工作区的 `.focus-guard/AUDIT.log`（重演此前修过的测试污染）。
  - **做法**：现改用本地同签名包装，落点走 DSH 统一入口 `appendAudit`（尊重 `FG_AUDIT_FILE`、带体积轮转）。
- test: 新增 `tests/postProgress.test.mjs`（9 用例，零污染）。CI 闸门 **6 套 / 257 个断言**。
- note: **实弹验证意外达成**
  - **现象**：DSH 插件**热重载生效**，新注册的 `postProgressListener` 在本次会话**真实运行**，把"连续工具调用被取证闸拒"判为停滞、累加至 `STALL_FUSE` 触发熔断（本人被自己的护栏拦下 3 次 edit）。
  - **结论**：这既证明监听器真的挂上了，也暴露一个**待评估的误伤面**：`progress` 判定未区分"调用失败"与"无进展"，当工具屡遭拦截时会误判为停滞。
  - **处置**：已记录，留待评估（`guard.mjs` 原逻辑如此，不宜擅自改动）。

- feat: **移植批 4：start 与 stop 收尾缝（约 300 行）**——新增 `stopGuard.mjs`，并扩充 `sessionStartListener`。
  - **start**（`agent/created`）：环境检测入 `state.envCache` · 卷宗载入（`inherited` 标记）· 卷宗【一】环境声明落卷（原子写）。
  - **start 巡视**：36 条 HANDOFF 交叉巡视 · 42 条部署版本核验 · 因果根链 · `rules-registered` 备案。
  - **常驻规则注入**：`guard.mjs` 把 `SESSION_RULES` 经 stdout 的 `hookSpecificOutput.additionalContext` 输出（Claude hooks 协议）；原生插件无此契约。
  - **做法**：改由新增的 `systemPromptRulesListener` 经 `system-prompt/assemble` 注入**独立 section**（与成本提示行并列，不改动下游既有 section）。
  - **stop**（`agent/turn-stopping`，与 KPI 结算并列监听）：任务规模声明（`TASK_SCALE_RE`）· 绝境模式豁免 · 触发⑤ 熔断声明与未知跟踪。
  - **stop 核验**：**《授权识别与留痕条例》三重核验**（引用原文 ↔ 本回合实际指令比对 / 法条 / 授权语义；不合格 → 熔断 + L3 留痕）· 79 条经验库 `PATTERNS.md` 创建 · 触发②（本回合 ≥5 次调用无锚点）。
  - **取舍① 只审计、不打回**（均因 DSH 的现实）：`guard.mjs` 用 `block()` 打回，靠宿主协议信号 `input.stop_hook_active` 保证"只打回一次"；DSH 无此信号，误打回会变成强制续跑死循环（本移植中本人已被自家熔断拦过）。
  - **取舍② 无收尾文本时跳过文本核验**：沿用原文对"无文本宿主"的 `dshBridge` 降级口径，否则锚点核验会对空文本必然失败、把每次收尾都判成"无锚点"。
  - **不搬**：高危审批单收尾校验（L1059-1077）——该机制已退役。
- fix: **测试污染彻底修复（第三处）**
  - **原状**：`state-ownership.test.mjs` **从未设置审计沙箱**，尽管其头部注释声称"一切写入重定向到 tmpdir"。
  - **后果**：`preExecuteListener` 的 deny 路径经 `auditDeny` 写进了真实工作区（实测 `own-` 前缀 39 条）。
  - **做法**：现补上 `FG_AUDIT_FILE`。
  - **另修**：`integration.test.mjs` 的 `after()` 把 `delete process.env.FG_AUDIT_FILE` 改为恢复沙箱路径——`node --test` 多文件可能共享进程，delete 会让后续测试文件落回真实审计。
  - **对齐**：与 `eligibility.test.mjs` 的已有写法对齐。
  - **验证**：连续两次全量 `npm run check`，`own-` / `gate-` / `post-` / `seams-` / `lc-` / `eval-` 增量**全部为 0**；总增量 15 条经查全为 `deny`（本会话被护栏拦截的真实执法记录，属设计内）。
- test: 新增 `tests/lifecycle.test.mjs`（11 用例）。CI 闸门至此 **9 套 / 268 个断言**。

- feat: **移植批 5：pre 结构性执法（102 行）**
  - **做法**：新增 `src/dsh/preGuard.mjs`（与 `preExecuteListener` **同事件并列监听**）。
  - **资料分层隔离**：静态资料区/派生积木区不得直写，防自我投毒。
  - **环境规则检查**：`platformBashViolation` 管平台不兼容命令；与第 1.5 层"环境指纹替换"**不是同一机制**——前者管平台本身，后者管本机替代。
  - **重名冲突**：拦大小写不敏感文件系统的同名目标（不可用 `existsSync` 豁免：不敏感 FS 上大小写变体目标恒存在）。
  - **子代理闸**：熔断期委派 = 越权绕行 L4/L5 · 48 条继承留痕 · 蜂群因果子链 `/dN` · **委托池消耗**。
  - **熔断期白名单**：只读放行/改动拒绝，且**熔断期不是高危命令的免检通道**。
  - **L2 强制取证 / L5 降权**：改动类一律拒绝。
  - **委托池至此闭环**：追加侧在批 1 的 `preStepListener`（人类批示『追加额度』三池各 +10），消耗侧在本批（每次委派 −1）与 KPI 结算（委托池奖惩）。
- fix: **工具名口径（适配层缺失，跨批次影响）**
  - **原状**：母版 `risk.mjs` 的 `isMutating` / `isInvestigation` 按 **ZCode 命名**精确判定（`tool === "Write"`、`["Read","Grep","Glob",…]`）。
  - **症状**：而 DSH 传**小写**（`write` / `read` / `pwsh` / `subagent`）→ 恒不匹配。
  - **后果**：不是"漏拦一次"而是**静默判错**。
  - **后果①**：`isMutating('write') === false` 使 L2/L5 期间改动类**不被拦**。
  - **后果②**：`isInvestigation('read') === false` 使**只读调用被计入执行池**，侦查池永不满、执行池被只读调用提前耗尽（**批 3 的 `postProgress` 已带此缺陷**）。
  - **做法**：新增 `src/dsh/toolName.mjs` 做归一化——修在**适配层**而非母版。
  - **口径**：母版要同时服务 ZCode 与 DSH，翻译是适配层职责；改母版会把 DSH 命名泄漏进母版、破坏"母版零宿主依赖"的分层约定。
- test: 新增 `tests/preGuard.test.mjs`（10 用例，含委托池**闭环**用例：追加侧补池 → 消耗侧委派）。CI 闸门至此 **10 套 / 278 个断言**，测试污染零增量。

- feat: **移植批 6：卷宗不重复读 + 改动前备份（44 行，功能补齐）**——并入 `preGuard.mjs`：
  - **卷宗不重复读**（总纲四）：指纹（mtime+size+SHA/git）一致且 TTL（`resolveTTL`）未超 → **拦免重读**，复用已有取证。
  - **放开条件**：指纹变化或 TTL 超时 → 放开真重读（post 缝会更新卷宗指纹）。
  - **边界**：**与第 3 层取证闸语义相反**（那座闸管"没读就改"，本闸管"读了还读"）；取证闸只对改动类（`MUTATING_TOOL`）生效，本闸只对 `Read` 生效。
  - **继承**：卷宗继承记录（`inherited`）只提示不拦——本会话从未读过、内容不在上下文，拦首读即阻断取证；`offset` 增量读永远放行；熔断/强制取证期豁免。
  - **74 条改动前自动备份**：所有闸通过、调用确定执行 → `backupBeforeEdit` 落 `.ai/backup/`，供无版本库工作区回滚。
  - **子代理继承不再另接缝**：批 5 已在 `pre` 侧以 `Agent` 工具名判定并留痕 `subagent-spawn`（父状态随派单移交），批 3 的 `postProgress` 已在 `post` 侧按 `subagent` 处理摘要校验。
  - **结论**：`subagent/start|end` 两条缝**无增量价值，不接**（避免重复实现）。
- test: `tests/preGuard.test.mjs` 扩到 15 用例（新增卷宗免重读 · 继承放行 · offset 放行 · 内容变化放行 · 改动前备份）。CI 闸门 **10 套 / 283 个断言**。

- fix: **人类文本提取的健壮性（真实载荷形状修正，P0）**
  - **原状**：重启后的实弹验收里，真实会话审计的 `reset-fired` 出现 `prompt:无`，即 `humanTextOf(messages)` 取不到人类文本。
  - **根因**：两条，见下。
  - **根因① 形状不止一种**：原实现只认 `messages[].content[]` 的 text 块（照官方桥 `blocksToText` 的假设），真实载荷对不上 → 人类文本恒为空。
  - **后果**：**批示识别全部失效**（`追加额度` / `停止令` / 特批 / 额度核定 50·15 全都拿不到输入，额度永远按默认 10 走）。
  - **教训**：**测试发现不了，因为测试造的就是自己假设的形状**——"单元测试全绿 ≠ 真实载荷正确"的典型。
  - **根因② 混有非人类消息**：DSH 的 pre-step 默认 next 是 `{ messages: [...claimed, context] }`（`dsh-agent-loop/lib/index.js:911-918`）。
  - **细节**：**渲染后的系统提示也会作为一条消息追加进来**。
  - **后果**：若无条件拼接，会把系统提示当成人类批示——**比"取不到"更危险的方向**。
  - **做法**：改为健壮提取——**优先只取 `role === 'user'` 的消息**（排除 pre-step 追加的 context）。
  - **兜底**：对 `content[]` 文本块 / `content` 字符串 / `text` / `parts[]` / 裸字符串逐层兜底；无 role 信息时退回全量。
  - **诊断**：`reset-fired` 增加文本长度诊断（`prompt:有(N字)`），下次真实回合即可确认。
- test: `seams.test.mjs` 扩到 14 用例（新增 5 种载荷形状 · **非 user 消息不得被当批示** · 无 role 退回全量）。CI 闸门 **10 套 / 286 个断言**。

- fix: **子代理分流（避免对 subagent 做无意义且有副作用的初始化）**
  - **实测**：hermes-loop 的复盘子代理（`ctx.agents.create({ meta: { origin: 'subagent' } })`）会**同样触发 `agent/created` 与 `agent/pre-step`**，而 FG 未加区分。
  - **后果①**：做完整环境检测、载入 **39 条卷宗记录**（实测白占 20KB 状态文件）。
  - **后果②**：**重写工作区 `.ai/CASE_FILE.md` 的卷宗【一】**（每次 agent 创建写一次 → 文件抖动、并发时可能互相覆盖）。
  - **后果③**：把它**由父 agent 生成的 prompt 当成人类批示**去识别（实测复盘 prompt 命中 `KEY50_RE` → 额度误判为 50，并记了无意义的 `goal-preauth`）。
  - **做法**：现按 `origin === 'subagent'`（兜底 `delegationDepth > 0`）分流：子代理只落一份最小状态、只做回合重置，跳过环境检测 / 卷宗读写 / 规则备案 / 巡视 / 批示识别。
- fix: **42 条版本核验误报**
  - **原状**：核验把 `packages/core/hooks/guard.mjs` 的版本号与 `ENGINE_VERSION` 比较，但该文件是**封存版、版本号独立**（header 写明不随 FG 主版本更新，见 `HANDOFF.md` §九）。
  - **后果**：**每次会话都误报"部署漂移 v3.0.6 ≠ v3.0.4"**。
  - **做法**：现将其列入 `SEALED` 排除清单。
- test: `seams.test.mjs` 扩到 17 用例（新增子代理轻量初始化 · 子代理跳过批示识别 · 主会话分流不受影响）。CI 闸门 **10 套 / 289 个断言**。

## 3.0.5 · 事前资格审核、模型画像与命令硬校验

- feat: **资格审核逻辑层**
  - **做法**：`core/checkEligibility.mjs` 六层判定（L0 申请完整性 / L1 状态 / L2 绝对红线 / L3 高危资格 / L4 前置条件 / L5 语义信号 / L6 授权并留痕）。
  - **依赖**：注入 `redlines`/`model`/`audit`/`grants`/`profile`，母版不反向依赖适配层。
  - **授权表**：`core/grants.mjs` 为 FG 独有状态（按会话分表，不进 guard 状态）。
- feat: **fg_apply 工具与双入口闭环**
  - **工具**：`adapters/dsh/fg-apply-tool.mjs` 按 `defineTool({name, description, parameters, execute})` 注册。
  - **闸**：`adapters/dsh/eligibility-gate.mjs` 提供 `applyEligibility`（审核期临时授权、未通过立即收回，避免申请通道被自己的第 3 层挡死）与 `gateToolCall`。
  - **接线**：`src/dsh/pipeline.mjs` 在硬校验之后接入资格闸——高危工具无授权即 deny，理由指向 `fg_apply`。
- feat: **模型画像系统**
  - **内容**：`src/profiles/` 五份纯参数画像（deepseek-flash / deepseek-pro / glm / gpt-astra / default）。
  - **加载**：`core/profileLoader.mjs`（层→子开关映射、别名表、id 精确与前缀匹配、default 兜底，零 `modelId` 硬编码分支）。
  - **判定**：`checkEligibility` 按画像开关跳层并把跳过项写入 trace 与审计；`core/decisionEngine.mjs` 汇总 decision / layer / skipped。
  - **兼容**：不传 `profile` 时行为与 3.0.4 一致。
- feat: **环境指纹与命令硬校验**
  - **探测**：`tools/env-fingerprint.mjs` 探测平台 / shell / 工具并产出 `.ai/env-fingerprint.json`。
  - **判定**：pipeline 第 1.5 层据其 `map` 做命令硬校验（`grep`→`rg`、`find`→`fd` 等替代提示），不依赖模型自觉。
- refactor: 核心源码分层
  - **内容**：`hooks/guard.mjs` 三次拆出 `src/core/{constants,redlines,audit,risk,state,env,backup,approval,session}.mjs` 与 `src/adapters/dsh/protocol.mjs`。

## 3.0.4 · 双包 monorepo 与中心蜂群强化

- feat: 仓库重构为 npm monorepo
  - **结构**：`packages/core`（`focus-guard`，零依赖范本包）+ `packages/extended`（`focus-guard-extended`，依赖 core，承载外接三件套）。
  - **效果**：`npm install focus-guard` 只下载核心，永不拉取扩展依赖。
- feat: 中心蜂群强化（第八十条增订七～十，采自 Claude cowork 与 GPT-6 蜂群提示词研究 R8）
  - **内容**：调度三分法与 ack 并行、派单给目标不给方法脚本、并行默认流水线（屏障例外须说明）、跨任务授权不对称（收到他任务来函≠授权）。
  - **其余**：协作动作禁藏入脚本、模型分层蜂群（全量继承禁降档）。
- feat: 对抗验证三怀疑者模式（第八十一条增订四，采自 Claude cowork 质量模式库）：各自"试图驳倒"、默认 refuted、多数决存真，复核截断必须留痕（no silent caps）。
- chore: 插件挂载路径适配 monorepo
  - **改动**：hooks.json 六条命令与插件清单指向 `packages/core/`；42条部署核验新增 monorepo 路径。
  - **废止**：`external-bridges` 分支废止（内容入 extended 包），`v3.0.2-external` 标签留档。
- fix: library-build 幂等键改为纯内容指纹配对（修复路径分隔符差异导致的重复积木）。
- docs: 对外文档剥离内部公文语气（CHANGELOG/README/INSTALL 回归开源专业表达，历史条目同步改写）；研读笔记 R8 入积木图书馆（共 75 块）。

## 3.0.3 · 主分支精简版（外接层移出）

- refactor: 外接三件套移出主分支
  - **移除**：`tools/viking-bridge.mjs`、`tools/needle2-sentinel.mjs`、`audit-chain --semantica` 及对应用例、README 外接节、`viking` 脚本。
  - **保留**：主分支保留哨兵本体与 `FG_SENTINEL_CMD` 外判契约。
- docs: README 外接指引与 CHANGELOG 同步；版本链 3.0.2 → 3.0.3。

## 3.0.2 · 外接三件套

- feat: `tools/viking-bridge.mjs` 积木图书馆同步 OpenViking
  - **落点**：积木以 `viking://resources/focus-guard-library/` 落入 resources 作用域。
  - **用法**：默认导出 batch-write 载荷，`--push` 直推（`OPENVIKING_URL`/`OPENVIKING_API_KEY`，默认端口 1933）。
- feat: `tools/audit-chain.mjs --semantica` 导出 LPG 图谱
  - **内容**：执法档案因果链导出 LPG 图谱 JSON（`caused`/`spawned` 边），供 Semantica Knowledge Explorer 导入。
- feat: `tools/needle2-sentinel.mjs` 本地模型外判运行器
  - **契约**：`FG_SENTINEL_CMD`；`NEEDLE2_BIN`/`NEEDLE2_MODEL` 指向本地推理运行时。
  - **回退**：失败静默回退内建启发式。
- feat: 批示词尾置容错——"……照此办理，y" 亦构成批示（3.0.1 的容错只认句首，尾置批示此前会被吞）。
- chore: 版本链 3.0.1 → 3.0.2。

## 3.0.1 · 合并审批

- feat: 高危待批队列（上限 10 条）——多条高危命令合并出示，一次 `y` 放行全部待批（每条仍各一次性消费、逐字一致），`n` 全部彻底阻断。
- fix: 授权消费统一——批量键与单条键重复登记时双槽同清（修复同一命令被无声放行两次）。
- feat: 批示词容错——批示词后接分隔符与简短补充指令（全文 ≤30 字符）仍构成批示（"y，顺带把文档改了"不再被整条吞掉）。
- fix: 写入闸对抗审查同源判定——同回合被拒 A 目标后写 B 目标不再连坐 L4 记档，跨目标走正常待批。

## 3.0.0 · 协作治理版（十大原则）

- feat: 中心调度与蜂群委派（第八十条）：主会话只做调度与审计，关键路径亲手、sidecar 委派；委派法典细则（关键路径规则/写集分离/共存三律/等待纪律/explorer-worker 二分/派单自包含）。
- feat: 去中心化验证（第八十一条）：关键决策（高危批准前/熔断宣告前/宣称完成前）换模型互查，findings-first，无锚点互评不计为复核发现。
- feat: 静态积木图书馆（第八十二条）
  - **区划**：`.ai/library/` 积木区不可变、引擎拦截直写，新知只进 `inbox/` 便签区（记忆更新隔离区）；积木读不进卷宗【三】。
  - **构建**：新增 `tools/library-build.mjs` 构建器（幂等重建）。
- feat: 本地哨兵接入层（第八十三条，opt-in `FG_SENTINEL=1`，默认仅记档 audit-only，`FG_SENTINEL_MODE=strict` 拦截）。
- feat: KPI 兑现闭环（第八十四条）：收尾即结算——KPI→等次→委托池奖惩（+5/0/-2/-5），跨任务累计 kpiCarry 落台账，AUDIT 记 `kpi-settle`。
- feat: 提问即治理（第八十五条）：任务漏斗（目标→约束→验收锚点→额度批示）；计划批准≠实现批准。
- feat: 因果链追溯（第八十六条）：AUDIT.log 每条增 `seq/chain/ref` 三字段，委派派生 `/dN` 子链；新增 `tools/audit-chain.mjs` 渲染因果树/Mermaid。
- fix: FG-D1 授权引文核验窗口 500→4000 字符（长批示靠后的授权原文此前必然核验失败误判越权）；FG-D2 卷宗【一】改原子写；FG-D3 rename 失败清理 tmp 残片；FG-D4 卷宗初始化降级防御。
- fix: 解释器 eval 类命令（`python -c`/`node -e`）不再判只读侦查——堵住熔断期白名单放行解释器的洞。
- breaking: AUDIT.log 追加 `seq/chain/ref` 三字段（追加式，旧解析器兼容）
  - **判定**：解释器 eval 类 Bash 改判执行类（熔断期不再放行、计入执行池）。
  - **注入**：常驻注入 411→425 字（仍低于 500 字立法上限）。
- docs: 新增 `docs/MASTER-PLAN-3.0.0.md`（协作治理总纲）、法条第十五章之二（第八十～八十六条）、SKILL §13-16 镜像。

## 2.5.3 · 实测误伤修复

- fix: 卷宗免重读限定会话内——跨会话继承指纹只提示不拦（内容不在本会话上下文，拦首读即阻断取证）；会话内真读后恢复拦截。
- fix: 58条对账限单条语句——复合命令（`&&`/`;`/换行）跳过整段对账，清除六起系统性误报（巨量输出仍由体积追责兜底）。
- fix: 审计任务体积闸豁免——批示含"审计/盘点/审查"时取证对象整读留痕不罚（预算与巨量输出追责仍生效）。
- chore: 卷宗【一】/PATTERNS.md 写失败告警
  - **落地**：61条落地（启动清扫临时目录 30 天陈旧文件）。
  - **修法**：法典 v1.1 修法（SKILL 效力条款改"暂停机械执行＋报请裁决"、废止 19/24四/44/45/46条）。
  - **迁移**：仓库迁移 JohnnyEisen → irisblackwood。
- test: 验收 86 → 90 用例。

## 2.5.2 · 对抗审查版

- fix(安全/P0): 熔断期不再放行高危命令——旧顺序让只读白名单先退出，`npm publish`/`shutil.rmtree`/`reg add`/`diskpart` 等直接绕过审批；现白名单之前先判高危，熔断期一律拒绝。
- fix: 中文批示生效
  - **原状**：`同意/批准/允许` 与 `不/拒绝` 因正则 `\b` 不识别 CJK 全部失效 → 整句精确匹配。
  - **其余**：「停止/熔断」批示真正生效（熔断状态曾被同一函数写回 false）；超 300 字符命令 y/n 生效（比对键改全量哈希）。
  - **补充**：Stop 打回一次性保护（杜绝强制续跑死循环）。
- fix: 变更类命令识别——`sudo mv`/`xargs mv`/`cp`/`sed -i` 不再被当只读侦查；shell 重检修复（zsh/sh 不再误报为 bash）。
- chore: `.env`/私钥不再落明文备份
  - **状态**：会话状态原子落盘。
  - **判定**：SQL WHERE 豁免按单条语句判定；`curl -d` 与 `-D` 区分大小写。
  - **特征补齐**：`find -delete`/`rimraf`/`wget --post-data`/`Invoke-WebRequest -Method POST`。
- chore: 新增 CI（Windows 必过，Linux/macOS 观察项 × Node 18/20/22）；威胁评测 31+16 → 61+34；验收 63 → 86。

## 2.5.1 · 盘点修复版

- fix: 版本一致性——`ENGINE_VERSION`、引擎头注释与五处清单统一并新增自检用例锁定。
- fix: 假留痕防线——AUDIT.log、卷宗【三】【四】、改动前备份写失败一律上报 stderr。
- feat: 卷宗【一】环境声明落卷（此前仅占位符）；42条适配"根即插件"布局。
- fix: 58条路径查重改判"首 token 是路径"（git 警告散文行不误报）；委派 KPI 落台账并阈值提醒；删除只写不读的 `envChecked`；五处清单 description 去重（加用例禁止镜像复制）。

## 2.5.0 · DSH 硬拦截

- feat: 官方桥 `dsh-hooks-claude-code` 直接运行 `hooks/hooks.json`
  - **效果**：DSH 获得与 ZCode 同级硬拦截（exit 2 阻断、stderr 原文透传、Stop 打回），取代 fire-and-forget 监察模式。
- fix: 识别桥接 Stop 签名自适应降级（锚点/审批单打回仅审计），防桥接强制续跑死循环；`cordis.patch.yml` 改空载（避免 bundle 与桥双跑）。

## 2.4.1 · 特征库加固

- fix: 堵住以下绕过
  - **补漏**：`git -C <目录> push`、`rm --recursive`、node `rmSync(recursive)`、无 where 的 `DELETE FROM`/`UPDATE SET`。
  - **新增**：`DROP DATABASE`。
- chore: post 阶段五处响应采样合并为单次；卷宗缓存 200 条按取证时间裁剪。

## 2.4.0 · 高危命令闸

- feat: 六类不可逆命令（破坏性删除/强推与历史覆盖/权限与配置篡改/全局依赖安装/对外发送与发布/数据库影响）命中即拒，须一行【高危申请】审批单——`y` 放行本次（一次性、逐字一致）、`n` 彻底阻断。
- feat: 目标预授权与执行级授权分离；严禁脚本包装绕行（写入与执行两侧都拦）。

## 2.3.0 · 委派条例

- feat: 委托池独立核算（默认 20 次，不占执行池）；子代理摘要四字段 ≤200 字，超长或缺字段拒收（KPI-3）。
- feat: 强制委派场景（全库搜索/大文档摘要/批量文件处理）未委派 KPI-5、已委派 +5；熔断期启动子代理=越权绕行（L4+L5）。

## 2.2.0 · 正面指引版

- feat: 法条第十五章之一（第七十四～七十九条）与运行时镜像；机械化三处：污染核实闸、改动前自动备份、推送走审批单。
- chore: 常驻注入压缩为电报体。

## 2.0.0 ~ 2.0.2 · 卷宗体系重构

- feat(2.0.0·破坏性): 卷宗体系重构
  - **卷宗四册**：`.ai/CASE_FILE.md`（环境声明/依赖声明/侦查记录/额度台账）、会话级环境检测一次复用。
  - **取证**：跨回合取证指纹（mtime+size+SHA-256≤200KB+git 脏态）、自适应 TTL（4h/2h/24h/7天，依赖声明 > 人工标注 > 自适应）。
  - **其余**：免重读放行、跨平台命令拦截、额度台账落卷；旧 mtime 逐回合闸废弃。
- fix(2.0.1): win32 shell 误判热修（PSModulePath 机器级恒存不再判为 PowerShell）。
- chore(2.0.2): `.csproj`/`.sln` 列入风险文件备案。
