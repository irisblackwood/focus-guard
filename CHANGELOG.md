# 变更记录（CHANGELOG）

## 3.0.8 · 2026-10-19

> v3.0.8 - Implemented Lazy Liveness to reduce prompt token overhead; Relicensed under AGPLv3

> 发布状态：in-tree（**尚未发布到 npm**）。npm 上最新仍是 `3.0.7`（MIT 授权、不可撤销）。
> 本条目已并入 2026-10-19 起累积的全部改动（原「未发版」区已合并，不再单列）；含 AGPLv3 切换与按需自证。

- fix(gate): **改动类工具分类只认 8 个名字**（2026-10-22）——取证闸/授权闸/批量待批全靠 `MUTATING_TOOL`，而真实目录里 `mcp__cities2-mcp__write_project_file`（写项目文件）、`build_project`/`package_project`（跑构建、打包）、`plugin_manager`（装删插件，会执行 npm 构建脚本）、`move_run`（写 AGENTS.md）、`import_claude`/`claude_export`（写会话文件）全被判"非改动"→ **天生免检**。现新增 `isMutatingTool()`（显式清单 + MCP 动词前缀；只读类不误判）、`pathOfTool()` 支持 MCP `{project_dir, relative_path}`；**改动类解析不出路径时不再放行**，改为要求 `fg_apply` 一次授权（`FG_MUTATION_UNMAPPED=allow` 退回旧行为）。母版 `core/risk.mjs::isMutating` 同步支持小写与 MCP。新增 `tests/mutation-classify.test.mjs` 6 条。
- feat(tools): **死闸审计** `tools/gate-audit.mjs`（`npm run gate:audit`）——把源码引用的参数键与真实会话 `request/header` 的工具 schema 对账，输出「引用了但 schema 没有的键」（死闸嫌疑）与「既不算只读/改动/shell 的工具」（分类盲区）。首跑 11 会话 / 254 工具，只剩 `cmd`（兼容回退）、`head_limit`（ZCode 遗留）、`pages`（已删）三个无害键。
- chore: 删除两处 `args.pages` 死参数（DSH `read` 只有 `offset/limit`）。
- feat(tools): **面板采集处理器** `tools/collect-panel.mjs`（2026-10-22）——3.0.8 面板基线要人工跑 ≥5 轮，"抄数 → 校验 → 复算 → 中位数"不该靠手算。工具做四件事：① 校验「未缓存+缓存读取+输出 == 总 token」；② 从会话记录解析 `steps`/`denies`/耗时（多帧 zstd，按魔数分帧）；③ 按官方价目复算成本并与面板成本核对（峰谷自动判定：工作日 09-12 / 14-18 为峰 ×2）；④ 输出每轮表 + 中位数 + `n<5` 告警。`--init` 生成 `panel-runs.json` 模板（已 gitignore）；`AB-PROMPTS.md` 的 P0 采集协议已改为「一条命令出表」。

- fix(guard): **KPI 重复结算**（ΣΣ）——`state.kpi` 是会话累计值而 `agent/turn-stopping` 每回合都跑，旧实现把它当"本任务 KPI"，既每回合重复累加进 `kpiCarry`（实测 `-8900` 对 `-290`，膨胀 30 倍）又每回合重复扣委托池。改为按增量结算（`kpiNow = 累计 - kpiSettled`），无增量零动作、不记 `kpi-settle`。
- fix(guard): **成本台账静默停摆**——`postExecuteListener` 拿不到 `usage` 时旧实现无 `else`，整条成本核算静默失效（台账 10-08 起零新增无人发现）。连续 5 次缺失 `warn` 一次，成功调用清零重计。
- feat(tools): **卷宗【三】路径自检**——新增 `packages/core/tools/verify-case-paths.mjs`（只读核查，不删不改，`--json` 可机器读）。实测 81 行 / 有效 75 / 失效 6（均为 monorepo 迁移前布局，待人类批准后归档）。
- refactor(layers): **消除三处分层越界**并固化断言——`protocol.mjs` 移入 `hooks/`（去掉 `zcode → adapter`）；审计写入器下沉 `src/core/audit-writer.mjs`、绝对红线表下沉 `src/core/redlines.mjs`（去掉 `adapter → seam`，`pipeline.mjs` 保留 re-export）；自检脚本移入 `tools/selftest.mjs`（工具不再放生产目录）。新增 `tests/layering.test.mjs` 锁死方向：`core → adapter → seam` 单向，禁止 `zcode → 适配层/宿主缝`，并显式承认组装根 `seam → adapter` 合法。
- feat(bench): **判定基准** `tests/decision-bench.mjs`——14 用例 × 10 轮 = 140 次真实 `preExecuteListener` 调用，输出准确率 / 误伤率 / p50-p95 / max，基线落 `docs/BENCH-BASELINE.json`（`--update` 覆盖，掉点即 exit 1）。首跑即暴露真实成本：**Bash 类命令每次约 60ms**（第 2 层语义判定调 python 哨兵），非 Bash 工具 p95 < 3ms。
- feat(bench): **成本基准** `tools/bench-cost.mjs`——不跑模型，只汇总 `.ai/CASE_FILE.md`【五】成本台账与 `AUDIT.log`：token/USD、按模型分布、拦截数、`trigger` 分布、误伤比（`appeal-granted / deny`）；支持 `--since` / `--json`。附 A/B 对照协议（FG 开/关各 5 次取中位数）。
- fix(ci): **`test:all` 改为发现式**——原为硬编码 11 文件清单，今天新增的 `casePaths` / `layering` 测试不在其中，会出现"CI 全绿但没测"。现统一走 `tests/audit-isolation.mjs`（自动发现 + 真实审计零增长守卫）。
- docs: 新增 `packages/core/docs/BENCH.md`（四类基准的跑法与已知热路径成本），README 命令表补 `bench:decision` / `bench:cost`。
- perf(gate): **哨兵结论缓存**——判定基准量出每条 Bash 命令都要付约 60ms 的 python 冷启动，而同一命令在会话里反复出现（重试/复测/同脚本多轮）。`riskOfSentinel` 现按命令原文缓存**成功结论**（LRU 500，`FG_SENTINEL_CACHE=0` 关闭、`FG_SENTINEL_CACHE_SIZE` 调容量），失败（超时/缺 python/解析失败）一律不缓存，不把错误固化成判定。实测 **p95 61.19ms → 2.37ms**，p50 0.58ms → 0.36ms；每条新命令首次仍付约 60ms（常驻进程方案未做）。
- test(bench): **任务测试 50 组**（`tests/task-bench.mjs` + `task-suite.json`）——组 = 一串真实调用（读→改→跑→查），任一环被错拦整组失败。覆盖只读/改代码/命令/高危/资格/边界六类，`--group` 单跑、`--json` 机器读，零 API 花费。首轮 46/50，暴露并修掉下列四个真问题后 **50/50**。
- fix(gate): **引号豁免射程过宽**（漏拦）——`psql -c 'DROP DATABASE prod'`、`node -e '…'` 的引号内容会被**真正执行**，旧实现按"被引用的数据"豁免放过。`redlineExempt` 增加执行型参数判据（`psql/mysql/sqlite3/node/python/ruby/perl/bash/pwsh… -c|-e|--command|--eval` 的实参不豁免），`git log --grep 'drop database'` 这类真数据仍豁免。
- fix(gate): **`rm -rf` 一刀切要 fg_apply**（误伤）——`rm -rf ./dist`、`rm -rf /tmp/...` 属常规构建清理，与第 2 层已做的分级（`destructiveApiWeight`：TEMP 0.2 / 递归系统 0.9）口径矛盾。现对可重建目录（`dist/build/out/output/target/coverage/.cache/.next/node_modules`）与 TEMP 目标不进门槛清单，交回第 2 层按风险裁决。
- fix(gate): **`Write`/`Edit` 写系统路径未被拦**（漏拦）——资格闸原来只在 `if (cmd)` 时执行，而写入型工具没有 command 参数，`C:\Windows\...` 之类的目标从未被检查。现闸按"命令或 `file_path` 任一存在"触发，`gatedReasonOf(tool, command, filePath)` 对写入型工具查 `SYSTEM_PATH_RE`。
- fix(gate): **shell 写文件绕过取证闸**（漏拦）——A/B 会话对照 B 组实测：要求"不读就改 README"，代理用 `pwsh Add-Content` 而非 Edit，旧实现只管 `MUTATING_TOOL`，于是**盲改被放行**。新增 `shellWriteTargets()`：从命令里提取写目标（`>`/`>>`、`Set-Content`/`Add-Content`/`Out-File`/`Tee-Object`、`tee`、`sed -i`、`perl -pi`），对**已存在且本会话未读**的目标同样拒一次；新建文件与 `NUL`/句柄复制不误伤。参数惰性 getter 抛错时降级不做判定（不中断判定链）。新增 `tests/evidence-shell.test.mjs` 7 条。
- feat(bench): **`bench:ab` 会话成本对照**——从 `$DSH_HOME/.dsh/sessions` 的 `session.v4.jsonl.zstd` 解出结构指标（turns/steps/工具调用分布/各类正文字符/时长），并按会话 id 从 `AUDIT.log` 取拦截数与理由分布；输出 A/B 差值与性价比（每步 tokens、每次拦截 tokens）。多帧 zstd 需按魔数 0x28B52FFD 分帧解压，单帧 API 只解第一帧。
- fix(bench): **token 口径与台账退化值得以确认**——宿主会话记录**不含逐次 usage**；FG 成本台账写进去的是退化值（`model=unknown`、1 token、cacheRead `undefined`）。`bench:ab` 因此给两列估算（`est4 = chars/4`、`estCJK = chars/1.6`）并显式标注"不可当账单"。真实 token 统计需另找宿主接口，属未完成项。
- fix(audit): **成本台账停止写假账**——`appendCostRow` 增加退化值守卫（`usageLooksReal`：模型名不得为 `unknown`，且输入+输出 > 2），不可信时整条不写、每进程 warn 一次，指向"真实用量以宿主面板为准"。同时**清空卷宗【五】历史 42 行**（全为 1 token/未知价目的退化值），保留标题与表头并追加清空说明；清理前已双备份到 `%TEMP%\CASE_FILE.bak-*.md` 与 `.ai/archive/`。
- fix(gate): **`ttl` 真正生效（授权回收）**——`grants.mjs` 此前自述"ttl 只记录、不生效"，等于 `fg_apply` 申请一次就**进程内永久放行**，`ttl: turn` 是空话。现三档按事件回收：`turn` 在 `agent/turn-stopping` 回收（`sweepGrants(sid,'turn')`，放在监听器最前，避免 KPI 无增量的提前 return 跳过回收）、`task` 回收 turn+task、`persist` 只受会话寿命约束；另设硬上限 `TTL_MAX_MS`（turn 30min / task 4h / persist 24h）防僵尸授权。回收留痕 `grants-swept`（trigger `ttl:turn`）。新增 `tests/grants-ttl.test.mjs` 5 条（含端到端：授权期内放行 → turn-stopping 后必须 deny）。
- feat(gate): **FGA-PTC 补全（默认只读 / 静默秒批 / 不可逆严格档）**——主图 L3 的核心语义此前只有"按需申请"，缺两个端点，且藏着一个口径漏洞。
  - `FG_PTC_READONLY=1`：默认只读。`ptcReasonOf()` 把**写类工具**（Write/Edit/MultiEdit/NotebookEdit/Delete/Move/Patch）与**变更型 shell**（`isMutatingBashCmd`）纳入门槛，未授权即拦；只读 shell 与 Read/Grep 不受影响。等价于"隐藏高危工具"的可执行替代（schema 在宿主层，FG 无法真正隐藏）。
  - `FG_PTC_AUTO_GRANT=1`：静默秒批。可逆类别（publish / global-install / chmod-wide）自动批准并留痕 `ptc-auto-grant`；不可逆类别不批。
  - `FG_PTC_STRICT_IRREVERSIBLE=1`：修口径漏洞——`applyOneEligibility` 审核期给的**临时授权**会让母版 L3 全部放行，导致 `rm -rf ./src` 这类不可逆删除**自证自批**。严格档下不可逆类别（rm-rf / format-volume / drop-database / git-push-force / write-system-path）申请返回 `needApproval` 且不授予任何授权，留痕 `ptc-irreversible-blocked`。
- feat(gate): **人工闸门改为默认开（B 方案）+ 文件审批链路**——上面那条"严格档默认关"等于安全幻觉，人类批示改为默认拦截 `rm-rf`：
  - 拦截即写 `.focus-guard/approvals/pending_request.json`，`id = sha256(工具+命令) 前 12 位`（换一个字符即失效，防偷换）；理由里直接给出可照抄的命令：`node packages/core/tools/focusguard.mjs approve <id>`。
  - 新增 CLI `tools/focusguard.mjs`：`pending` / `approve <id>` / `list` / `status`（`npm run focusguard -- approve <id>`）。
  - 消费语义**一次性**：`consumeApproval()` 命中后删除批准文件与 pending，下一次同命令重新拦、重新申请；批错 id 一律失败。
  - 默认只严抓 `rm-rf`（format-volume / drop-database / git-push-force 已被绝对红线层直接拦，到不了申请通道）；逃生口 `FG_PTC_ALLOW_RM_RF=1`，扩展 `FG_PTC_STRICT_ALL=1`。
  - 新增 `core/approvals.mjs`、`tests/approval-seam.test.mjs` 5 条（请求生成与 id 绑定 / 批错无效 / CLI 真写状态 / 消费一次性 / 换命令原批准失效）；同步改 `eligibility.test.mjs` 验收②（样本换成可逆类别 publish）与 `ptc.test.mjs` 人工闸门用例。
  - 三个开关默认全关（改变默认放行/拦截的主干语义，不能偷偷开）。新增 `tests/ptc.test.mjs` 7 条。
- fix(gate): **熔断/降权口径统一到 shell 变更型命令**——`layer3Check` 的早退条件此前是"写类工具 **或** shell 有写目标"，而 `git commit`、`npm install` 这类命令没有重定向 → `shellTargets` 为空 → **整条第 3 层被跳过**。实测铁证：本会话被判熔断后 `write` 被拒，`Bash git commit` 却提交成功。现引入 `isMutatingBashCmd` 把"变更型 shell"并入同一判据：熔断期 `git commit` / `npm install` 一律拒（只读命令仍放行），未熔断时不误伤。新增 `tests/fuse-shell.test.mjs` 5 条。
- chore(license): **全面切换为 AGPLv3 + 商业双授权**——`LICENSE` 换为标准 GNU Affero GPL v3.0 全文（34.5KB，含版权头与商业授权说明），三处 `package.json` 的 `license` 改为 `AGPL-3.0-only`，`NOTICE` 写清双授权与商标，README 顶部加显眼双授权声明、底部 License 节重写。相比 PolyForm NC：AGPL 允许商用但强制开源网络服务，对"资本入场"的约束是**同化**而非**禁止**，同时保留商业授权通道。
- chore(license): **（已被上一条取代）曾改为 PolyForm Noncommercial 1.0.0**——人类明确了授权意图：个人电脑部署与社区使用免费，但不允许盈利。Apache-2.0 与 MIT 都是商业友好的宽松许可，表达不了"非商业"，故整体替换：
  - `LICENSE` = PolyForm Noncommercial 1.0.0 原文（4,563 字节）+ `Required Notice` 行 + 中英双语商用授权说明（个人学习/研究/业余项目/非营利社区免费；企业内部生产、收费产品/服务、SaaS 转售一律禁止；商用需单独授权）。
  - `NOTICE` 同步；三处 `package.json` 的 `license` 改为 `PolyForm-Noncommercial-1.0.0`；三份 README 的许可行与徽章同步。
  - 说明：**非 OSI 开源**（source-available）。已发布的 `focus-guard@3.0.7` 仍是 MIT，许可不可撤销、不追溯；本许可自下一个发布版本生效。上一版短暂的 Apache-2.0 从未发布，无对外影响。
  - **补强可执行性**：`NOTICE` 增加**商标保留**段（`FocusGuard` / `聚焦护栏` 及项目标识不得用于 fork 命名或背书）与非商业声明；README 许可节补三条边界与商标说明；新增 `CONTRIBUTING.md`——包含**简版 CLA**（提交即授予作者"永久、免费、不可撤销、可再许可"的版权与专利许可，使作者能发放商业授权），以及提交前自检、会被拒的 5 类情况。没有这两项，非商业许可只是"纸面约束"。
  - **修不一致**：`packages/core/LICENSE` 此前仍是 MIT 文本（**npm 发布时带的正是这一份**），根目录已是 PolyForm → 两份法律文本互相矛盾。现根 `LICENSE`/`NOTICE` 同步到 `packages/core` 与 `packages/extended`，两个子包的 `files` 显式加入 `NOTICE`；`npm pack --dry-run` 已确认 `LICENSE`、`NOTICE` 均入包。
- ci(publish): **发布工作流去抖动**——`npm install -g npm@latest` 改为锁定 `npm@11`（latest 每次可能带进新的 2FA/GAT 策略，本仓库已因此红过两次），并显式校验 `npm >= 11.5.1`；新增 `concurrency: publish-${ref}` 防止并发触发撞上 "cannot publish over"；`Verify` 步骤显式 `shell: pwsh`（windows runner 默认 shell 行为差异）。
- ci(test): **CI 矩阵拆分，推送不再挂红叉**——原矩阵 `windows-latest / ubuntu-latest / macos-latest` × 3 个 Node，`continue-on-error` 只保证总结果绿，UI 上 Linux/macOS 作业仍显示 ✗（用户视角"老是不过"）。而验收套件含数条 Windows 专用断言，非 Windows 必红且短期无法平台化。现拆分：`push`/`pull_request` 只跑 `windows-latest × Node 18.20/20/22`（必过）；跨平台 `observe` 作业仅 `workflow_dispatch` 触发，保留需要时的可见性。另加 `concurrency: ci-${ref}` 取消重复推送的旧运行。
- refactor(liveness): **按需自证（Lazy Liveness）**——存活状态不再进系统提示，改为三处局部附带。
  - **先纠正一个事实**：旧实现 `livenessNote()` 在全部模块报到时返回 `null`，`index.js` 里又有 `if (note)` 守卫，所以**正常态本来就没有注入**（真实节省为 0）。真正的浪费在**降级时**：一旦缺模块，`focus-guard-degraded` 段会随每一次装配重复进入 Prompt（约 100+ 字/轮），而且它描述的是"启动那一刻"的快照——模型后续每轮都被提醒一次早已过期的状态。
  - 现改为 `livenessBadge()`：正常态 `[FG 存活 15/15]`（≈14 字），异常带 `；降级: <模块名>`，并支持 `事件: compaction` 这类一次性附注。`livenessNote()` 仅保留为兼容别名。
  - **只在这三处出现**：① `tools/pre-execute` 返回 `deny`/`ask` 时给理由追加徽标（`index.js` 的 `withLivenessBadge` 包裹，两条执行缝都套）；② `fg_apply` 结果文本末尾（`src/dsh/tools.mjs`）；③ 压缩落定（`compactionWatch.mjs` 调 `noteLivenessEvent('compaction')`，下一次徽标带上 `事件: compaction` 后即清除）。系统提示装配里**彻底移除** `focus-guard-degraded` 段。
  - **降噪核对**：`heartbeat.mjs` 的 `beat()` 只做 `status.json` 的 tmp+rename 覆写，不含任何 `appendAudit` —— 心跳 10s 一次也不会往 `AUDIT.log` 写行（新增用例断言"跑一次心跳后 AUDIT.log 仍不存在"）。
  - 新增 `tests/liveness-lazy.test.mjs` 5 条（正常态短徽标 / 事件一次性 / 降级带模块名 / 心跳不写审计 / 装配层不再含 degraded 段）。

> 本文件按版本倒序记录面向使用者的变更。版本号与**七处清单**（根 `package.json`、根 `marketplace.json`、
> `.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、
> `packages/core/package.json`、`packages/extended/package.json`）及引擎 `ENGINE_VERSION` **完全相同**
> （共 8 处版本点），且**必须等于本文件最新条目版本**——两条一致性均由验收用例锁定。
> 引擎头注释（`hooks/guard.mjs`）例外：该文件已封存、版本号独立，由断言锁定其"封存标注"而非版本相等。

### 2026-10-22 · 清除 guard.mjs 两处确定性假警报

- fix(guard): **42条 部署版本核验不再比对封存脚本自身**——`hooks/guard.mjs` 头注释是封存的 `v3.0.4`（版本独立、不随主版本更新），而候选表第一条正是它自己，于是每个会话必然命中「引擎 v3.0.8 ≠ 源码 v3.0.4」并注入约 89 字告警。现改为：读到的副本**带「已封存」标记即跳过**；未封存的历史部署副本仍照常核验（那才是真信号）。
- fix(guard): **ZCode 注册表部署漂移核验改为显式开启**（`FG_ZCODE_DEPLOY_CHECK=1`）——ZCode 通道已退役，但 `~/.zcode/cli/plugins/installed_plugins.json` 里留着按版本号命名的旧安装路径（basename 恒为 `3.0.4`），导致每会话注入「引擎 v3.0.8 ≠ 注册表 v3.0.4，存在部署漂移」。该告警不可行动（没人会为消警去改旧注册表），且与"封存"语义矛盾。
- test: 新增「默认不注入部署漂移告警」用例；既有「注册表不一致应告警」用例补 `FG_ZCODE_DEPLOY_CHECK=1`（保持该分支仍有覆盖）。
- 验证：`npm run check` → `366/366`、eval PASS、bridges 3/3、审计隔离 Δ0；探针实测 `guard.mjs start` 输出已无「部署版本核验」字样。

### 2026-10-22 · 层序审查 + 基准重测

- refactor(layer): **体积闸判定内核下沉到母版**（新增 `src/core/outputGate.mjs`）——体积闸此前在 `hooks/guard.mjs`（Claude Code / ZCode 路径）与 `src/dsh/pipeline.mjs`（DSH 路径）**各写一份判定**；而红线判定早已收敛在 `core/redlines.mjs` 一处。同一套架构里两个判定走两种做法，就是漂移的温床。
  - 关键判断：**不能简单合并**。两个宿主的 Grep schema 不同——Claude Code / ZCode 有 `output_mode`/`head_limit`，DSH 只有 `{pattern,path,include}`。故拆为「判定共享 + 参数提取各自」：内核只收语义布尔量（`broadDir` / `contentUnlimited`），翻译留在适配层。
  - 三闸收敛：`judgeReadGate`（含审计任务豁免）/ `judgeGrepGate` / `judgeCatGate`；两条路径均改调内核，**行为零变化**（`eval` 61/61 + 良性 34/34、`bench:decision` 100% / 误伤 0% 均不变）。
  - 新增 `tests/outputGate.test.mjs` **16 条**（阈值边界 / 审计豁免仅超阈值时生效 / ENOENT 放行 / 两种 Grep 语义 / 裸 cat 与管道放行 / 命令中段 cat / 参数含 cat 字不误伤）。
- fix(layer): `src/core/approvals.mjs` 的 session 缺省值 `'dsh-native'` → `'unknown'`——母版层不该替宿主代言，真实 session 由适配层传入。
- docs: `src/core/env.mjs` 注释更正——原文写「② DSH 宿主直接判 powershell」，但实现里**从未有过该判断**（一直走 `opts.shell` 参数传递）。注释落后于实现，已按实际改写。
- docs: `src/core/decisionEngine.mjs` 补「接入状态」——实测生产路径**零调用**（`pipeline.mjs` 直调 `gateToolCall`、`guard.mjs` 走自有判定链），当前仅 3 个测试使用。保留而非删除，但**接入属行为变更**（改返回结构与审计 trace 字段），须单独评估。
- fix(test): **清掉给假测试续命的死分支**——`pipeline.mjs` 的 `grepContentNoLimit`（依赖真实 DSH 工具不存在的 `output_mode`）已删。删后立刻暴露两条同类假用例：`gates.test.mjs:85` 与 `decision-bench.mjs:72`，均已改真实参数，并各补一条「带 `include` 应放行」防误伤。
- fix(docs): 发布状态更正——`focus-guard` 在 npm 上**已发布（3.0.7）**，此前三处 README 误写「未发布 / 404」（`README.md`、`packages/core/README.md`、`packages/core/README.zh-CN.md`）；`focus-guard-extended` 确未发布（registry 404），已加 `"private": true` 硬阻止误发（`npm publish` 现直接被拒），依赖由 `^3.0.4` 对齐到 `^3.0.8`。
- chore(bench): `BENCH-BASELINE.json` 同步到 **15 用例 / 150 调用**，但**延迟标尺刻意保留 2.37ms 未放宽**——新增两条走 `statSync` 的用例实测约 8ms，若一并放宽即等于把劣化合法化；加 `_latencyNote` 说明原委。
- docs: `BENCH.md` 第三节新增「四个注入体量数字辨析」（**425** 静态 `SESSION_RULES` / **440** DSH 侧注入 / **545** `bench` 读数 / **3425** 场景加权），并标注 545 中约 **89 字**是 `guard.mjs` 版本核验假警报（封存版 v3.0.4 vs 引擎 3.0.8，`seams.mjs` 已修、ZCode 侧未修）。
- docs: `README.md` 常驻注入表按 2026-10-22 实测更新（SessionStart 531→**545**、高危审批闸 175→**推送闸 182**、合计 3404→**3425**）；`RULES.md` 全角/半角分解更正（260+165 → **246+179**）。
- docs: `BENCH.md` A/B 协议重写为七节（两臂 / 开跑前体检 / 必记字段 / 主指标 / 判定规则 / 禁止清单 / 记账），并把两组历史 A/B 数据**标为作废**（10-18 步数不可比、10-19 带病测量），声明该表为唯一数字源。

### 2026-10-19 · 画像与审计元数据

- feat(profile): **L1 画像包 `evasionRisk` 接线**（ARCH-MAP 主图 L1 第一件）——五份画像新增纯参数字段 `evasionRisk`（`high` / `low`，取值标 `TODO(实测)`，当前一律 `high` = 与 3.0.8 行为一致）；解析收敛到 `src/core/profileLoader.mjs` 的 `approvalScopeOf()`（**唯一真源**）：显式 `approvalGate.scope` 优先，否则 `low` → `irreversible`、`high` / 缺省 / 非法 → `mutating`；`checkEligibility.profileScope()` 改为委托它，pre-execute 闸 `gateToolCall` 因此天然同源。
  - 安全边界：不可逆类别（`rm-rf` / `format-volume` / `drop-database` / `git-push-force` / `write-system-path`）在**任何** scope 下都要审批——本字段只能把范围「收窄到不可逆」，永远放不掉它们；审批层仍不可被画像关闭（`FORCED_ON_SWITCHES`）。
  - 数据整理：`deepseek-flash` / `deepseek-pro` / `glm` / `default` 去掉冗余的 `scope: 'mutating'`（= 派生默认值，行为不变）；`gpt-astra` 保留显式 `scope: 'irreversible'`，并用例锁死「显式优先」。
  - 测试：`tests/profile.test.mjs` 新增 g1-g4（五画像派生回归锁 / 派生三分支与显式优先 / low 放行 `publish` 但 `rm-rf` 仍转人工 / 闸与母版同源）。实测 `node --test packages/core/tests/profile.test.mjs` **12/12** 通过。
- docs: `ARCH-MAP.md` 同步——L1 `evasionRisk` 由 ⬜ 改 ✅，缺口 #2 改为「剩余两件」，并新增缺口 #5「**缺 3.0.8 面板基线**」（本轮人类确认暂无面板数据，故不出环比表、不编造基线）。
- feat(docs): **P2 回流台账（伪 RLHF 最小闭环）**——新增 `packages/core/docs/PROFILE-TUNING.md`：人工批准制四步（采数据 → 建议 → 人类批准 → 改画像再测），含可复算的数据快照（`bench:decision` 100% / 误伤 0 / p95 2.79ms；`bench:tasks --ab` 57/57 双向、介入 15 次应拦 15 误伤 0；`AUDIT.log` 10-18~19 共 3,132 行、deny 139 行 / 13 会话及 trigger 分布，快照 `2026-10-19T20:17:18+08:00`）与 5 条建议条目（T1 `evasionRisk` 保持 `high`、T2 `budgetGate.ceiling` 已有初步数值但缺判据（`budget-extend` 19 行 / 3 会话，分母 53 会话 ≈ 5.7%）、T3 `stalledFuse.threshold` 连指标都没有（缺 step 边界）、T4 `approvalGate.scope` 保持派生、T5 误伤口径扣除 `evidence-gate`/`gate:fg_apply`）。**本轮可批的数值改动 = 0 条**。
  - 口径修正：`evidence-gate` 的 deny 是设计内「首次改动提醒」（拒一次、重试即放行），`bench:cost` 的 `falsePositiveRatio` 必须扣除它，否则高估误伤。
  - 边界：不做自动调参、不做无人批准的回写；自动化只允许只读汇总。
- docs: `ARCH-MAP.md` 同步——L6 闭塞项补「回流台账已建、本轮 0 条可批」，缺口 #3 改为「缺测量侧而非回流侧」。
- feat(audit): **审计行补 `turn`/`step` 元数据 + 熔断浪费按会话独立计数**（2026-10-19 人类批示）——此前 `AUDIT.log` 只有 `seq`（进程内序号，跨会话不可比），"熔断后浪费了几步"算不出来，`stalledFuse.threshold` 无从校准（缺口 #3）。
  - 位置来源单一：`agent/pre-step` 载荷的 `{turn, step}`（`dsh-agent-loop/lib/index.js:956`）；`tools/pre-execute` 的 exec 里没有这两个字段（`dsh-tools/lib/index.js:3239`），所以由 `src/dsh/traceMeta.mjs` 记录、不由 exec 猜。
  - 注入单点：`src/core/audit-writer.mjs` 新增 `setTraceMetaProvider()`，所有写点（`auditDeny` / `auditEligibility` / `compactionWatch` / `preGuard` / `stopGuard` / `postProgress` / `seams`）自动带 `turn`/`step`；行里已有值时以行为准；provider 抛错按"无元数据"处理，绝不阻断留痕。
  - 结算：`agent/turn-stopping` 调 `recordFuseWaste()`，**只在本回合真熔断过时**写一行 `action:"fuse-waste"`，`wasted = 回合末 step − 熔断 step`（被拦也算一步）；换回合作废上一回合熔断点。**按会话独立计数**——每会话 `step` 从 1 起，跨会话不可相加。
  - `bench:cost` 新增 `report.fuseWaste`（`stallFuse` / `withMeta` / `bySession`）；历史 57 次熔断无元数据 → 明确报"带元数据 0 次、无法回溯"，不假装能算。
  - 新增 `tests/trace-meta.test.mjs` 6 条（provider 注入 / 显式值优先 / 无 provider 不添加 / pre-step 记录 / fuse-waste 结算 / 换回合作废 / 两会话互不相加）。
  - 验证：`npm run check` → `337/337`，`audit-isolation` Δ 0 PASS。
- docs: `BENCH.md` 增「熔断浪费（fuse-waste）」小节（来源、口径、命令）；`ARCH-MAP.md` 缺口 #3 改为「T3 指标已补、待样本」；`PROFILE-TUNING.md` T3 状态改为「指标已可达（待样本）」并补 `fuse-waste` 快照行。
- feat(gate): **反规避抽查B 参数化（不可预测检查点，2026-10-19 人类批示）**——`ARCH-MAP` L5 的「2-5 次随机熔断」此前只有抽查A（确定性每 5 次全量审计），两者混在一个参数里。
  - 新参数**与抽查A 完全独立**：**默认开**（2026-10-19 晚人类批示；`FG_RANDOM_FUSE=0` 关闭）→ 间隔在 `[RANDOM_FUSE_MIN=2, RANDOM_FUSE_MAX=5]` 次写操作间**随机**（`core/constants.mjs`）；`FG_RANDOM_FUSE_EVERY=N` → 固定间隔（运维/测试用，优先级更高）。
  - 语义：post-execute 只能"挂检查点"（那次写已经发生，无法回滚），由 pre-execute 第 3 层对**下一次**变更型调用**拒一次**（与取证闸同手感），审计 `trigger:"random-fuse"`，重试即放行；状态回写失败时**不拒**（宁可不拦也不做永久死锁）。换回合作废检查点，写操作计数（会话级）保留。
  - 计数与留痕：`fuseOps` 独立于抽查A 的 `writeOps`；命中写 `action:"random-fuse"`（含第几次写操作、间隔、超出阈值几次）。
  - 新增 `tests/random-fuse.test.mjs` 6 条（默认开启随机 2–5 / 固定间隔第 3 次命中 / 拒一次后放行且 trigger 正确 / 与抽查A 独立 / 换回合作废 / 随机间隔两端可达）。
  - 验证：`npm run check` → `346/346`，`audit-isolation` Δ 0 PASS。
- docs: `ARCH-MAP.md` L5「反规避 · 不可预测检查点」🟡 → ✅（**默认开**，`FG_RANDOM_FUSE=0` 关闭），缺口 #4 改为「已默认开 + RULES 条款已补」；新增「版本路线」节（3.5 重置文档 / 4.0 剥离旧 hook 或升级用法）。
- docs(rules): **`RULES.md` 补第三十五条(二) 反规避抽查B**（默认开、2–5 随机、拒一次即放行、`random-fuse` 留痕、会话级计数），技术映射表同步新增一行，实施差异备忘新增 **v3.0.8 现状对齐**条目（收录 3.0.x 的按需自证/人工闸门/审计 turn·step/取证键归一化/evasionRisk/AGPL）。
- docs: `ARCH-MAP.md` L5「反规避 · 不可预测检查点」🟡 → ✅（默认关），缺口 #4 改为「默认关闭 + 未写入 RULES，待人类批示」。
- fix(gate): **取证闸「读过仍被拒一次」的真根因——取证键没归一化**（2026-10-19 实测复现）——读记录侧 `rememberReads` 存的是宿主给的**原始路径**（相对），查证侧存的是 `resolveToolPath()` 后的**绝对路径**（`join(cwd, rel)`，Windows 带反斜杠）；同一文件两种写法 → 查不到 → 判「未读」→ 靠 `evidenceBlockedOnce` 的「拒一次」逃生阀放行。表现就是"每次首次改都要被拦一次"。
  - 修法：新增 `evidenceKeyOf()`（绝对化 + 统一正斜杠）、`sameEvidenceKey()`（Windows 大小写不敏感）、`isReadRecorded()`（先查归一化键直命，再兼容历史/异形态键逐个解析比对）；`rememberReads` 改写归一化键，`layer3Check` 的 `known` 判定改用 `isReadRecorded`。**未放宽闸门**：真没读过的文件仍拒一次（用例 e3 锁死）。
  - 复现/回归：新增 `tests/evidence-relative-path.test.mjs` 3 条（相对路径读后改应放行 / 跨正反斜杠形态应放行 / 未读就改仍拦）；同步修正 `tests/state-ownership.test.mjs` 的 readSet 断言到归一化键。
  - 验证：`npm run check` → `346/346`，`audit-isolation` Δ 0 PASS。

## 3.0.7 · 2026-10-18（Trusted Publishing 首发）

> 本节记录 3.0.7 的增量。首次通过 GitHub Actions OIDC（Trusted Publishing）发布，包内容不含任何长期凭据。对应提交：`8f58bcf` / `861e9a7` / `cd7ad36` / `2d04d53`。

- feat(runtime): **心跳与存活确认**——`heartbeat.mjs` 每 10s 原子覆写 `.focus-guard/status.json`（tmp→rename），`unref()` 不拖住宿主；`status.mjs` 按需判活，exit `0` 全绿 / `2` 缺模块 / `3` STALE（>30s）/ `4` 文件缺失。
- feat(runtime): **11 模块启动自检**——10 条执法缝 + 心跳各自报到（`markModule`）；缺项写 `degraded`、宿主日志 warn、模型侧注入 `focus-guard-degraded` 段；心跳首写延后一 tick，避免首帧少报自己。
- feat(l4): **跨会话卷宗按路径哈希路由**——`workspace.mjs` 以 `sha256(realpath(cwd))` 前 16 位为身份，`.focus-guard/workspace.json` 存决策/约束/下一步（各限 10 条、每条 200 字、注入 ≤1200 字）；**hash 不符零注入**，改文件夹名即彻底屏蔽。回合结束（`agent/turn-stopping`）自动落账，只记 FG 亲眼看到的事实。
- feat(gate): **第 1.4 层整文件读取闸**——目标 >300 行且无 `offset`/`limit` 即 deny，提示改用 XERJ `search`/`def`；`FG_WHOLE_FILE_MAX_LINES` 可调。分块数换行、够数即停，不整文件读入内存。
- feat(gate): **第 1.3 层 Superpowers 动笔闸**——判据三件套（开发动词 + 模糊标记 + 无验收词）同中才触发；首次改文件/写文件/破坏性 shell deny 一次，要求先加载 `brainstorming` / `writing-plans`；同条重试与已加载均放行（防死锁）。
- fix(gate): **破坏性 API 按目标分级**——旧实现只看动词、权重恒 0.6，清 TEMP 单文件与递归删系统目录同分，且 `Remove-Item` + 任意重定向即 0.9 越线。现系统路径/递归 0.9（拦截）、TEMP 0.2、其他 0.4、重定向 0.15。历史 39 条误伤样本回放：全部降到阈值下（最高 0.45）。
- fix(gate): **红线射程补两处**——长旗标写法 `rm --recursive --force X`（旧短簇正则认不出 `--force`）与系统顶层目录（`/usr` 等）；`/tmp` 刻意不收，避免误伤构建。
- fix(audit): **`FG_AUDIT_FILE` 优先**——`core/audit.mjs` 的 `auditTarget` 此前只认 `ZCODE_PROJECT_DIR`/`CLAUDE_PROJECT_DIR`，导致 `risk.mjs` 的 `penalize()` 成为第四个写点、测试重定向对它失效（CHANGELOG 3.0.6 所称"零增长"实测不成立）。
- fix(audit): **deny 记录真实 trigger**——`auditDeny(exec, cmd, {trigger, level})`，10 处调用点补 `redline:<name>` / `env-substitute` / `gate:fg_apply` / `evidence-gate` / `whole-file:lines` / `volume:*` / `superpowers:writing-gate` / `risk:<category>`；此前一律写 `high-risk-rm`，`ls -la` 也被记成强删。
- fix(env): **执行体判定不再三方矛盾**——母版认显式 `FG_SHELL`，DSH 适配层在 `apply()` 声明执行体为 `powershell`；卷宗【一】/指纹/实际执行从此一致（实测 `powershell 5.1.26100.9444`）。
- fix(seams): **42 条版本核验退旧账**——封存版此前被"并入候选表"而非跳过，每会话误报一次部署漂移；改为 `SEALED` 命中即 skip。
- feat(watch): **压缩监察**——`compactionWatch.mjs` 只观察 `compaction/start|end|prune` 与 `agent/request-error` 撞窗并留痕（`action=compaction*`），不写 surface、不 cancel；压缩归 DSH 内置栈，第三方不再重复实现。
- fix(test): **审计零增长守卫**——`tests/audit-isolation.mjs` 跑测前后比对真实 `AUDIT.log`，有增长即 exit 1；`test`/`test:all` 改经守卫运行。已双向验证：干净 Δ0 PASS、故意污染 Δ1 FAIL。
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

- feat: **绝对红线上下文豁免**（HANDOFF §八）——`core/redlines.mjs` 新增 `redlineExempt()`，三条判据：① 命中片段完整落在引号字面量内（`quotedSpans()` 解析 `'…'`/`"…"` 并处理反斜杠转义）；② 片段前有显式数据标记（`示例：`/`例如：`/`测试数据`/`prompt:`/`【假设】`/ 代码围栏）且命令非变更类（复用 `isMutatingBashCmd`）；③ 首 token 属只读输出命令（已剥离 `sudo`/`env`/`xargs` 前缀）。豁免只把裁决**降级到第 2 层语义预判**，绝不直接放行；`pipeline.mjs` pre-execute 在豁免时写 `AUDIT.log`（`action:"redline-exempt"`、`trigger`、`basis`、`evidence`）后继续下传。
- fix: 豁免**排除执行外壳**——`bash -c "rm -rf /"`、`node -e "…execSync('rm -rf /')"` 的危险内容同样在引号内，但那是真执行。`SHELL_EXEC_WRAPPER_RE`（shell `-c` / `cmd /c|/k` / `eval` / `exec` / `iex` / `Invoke-Expression` / 解释器 `node -e`·`python -c`·`perl -e`）命中即不豁免，口径与既有 R5-3 解释器黑名单一致。
- chore: `docs/RULES.md` 删除已废止条款正文及未机械化清单中的废止残留（条款 91→87，编号空缺保留以维持既有交叉引用不漂移）。
- docs: CHANGELOG 补勘误小节，记录历史三条 `refactor(core)` 提交的行数口径与正确数字（不改写历史）。
- feat: **误伤申辩程序**（司法救济通道，补齐外部审计指出的结构缺口）——新增 `fg_appeal` 工具（`adapters/dsh/fg-appeal-tool.mjs`）与 `appealAsk` / `grantFromAppeal` / `hasRedlineGrant`；`pipeline.mjs` 在**所有闸之前**处理申辩（否则申辩参数携带的被拦命令原文会被同一规则再拦一次，形成死锁），返回 `{kind:"ask"}` 经 DSH approval seam 交人类**一次性裁决**。批准 → 开通该工具一次授权（`ttl=turn`）+ 豁免本次命中红线（`redline:<name>` 凭据，红线层可查）；拒绝 → 维持拦截。全程留痕 `appeal-filed` / `appeal-granted` / `appeal-denied`。条文见 `RULES.md` 第八十三条(四)——同时**更正**该条(三)「仍走第十二章」的条文错配（第十二章为「反规避与纪律审查」，非申请执行流程）。
- test: 画像链路端到端集成测试 `tests/integration.test.mjs`（16 用例）——验证 fg_apply→授权→闸放行闭环、画像跳层、红线豁免与资格闸的边界、授权回收与会话隔离。
- fix: **画像与豁免在真实入口失效**（集成测试挖出、逐条修复）——① `applyEligibility` 新增 `profile` / `modelId` 形参并透传，此前真实 fg_apply 路径 `profile=null`、画像全失效（差异只在 `decide()` 可达）；② 母版 L2 命中红线后接入 `redlineExempt`，与 pipeline 文本层同口径（豁免则**降级**不 deny），此前"文本层豁免、母版仍 deny"；③ `gateToolCall` 接入 `profile` 并按同一 `scope` 判定，消除"闸与母版不同源"。
- fix: **审批层不可被画像关闭**（安全项）——`profileLoader` 新增 `FORCED_ON_SWITCHES` / `enforcePolicy`，画像试图关闭 `approvalGate` 时强制启用并告警；母版 L3 不再查 `layerEnabled`，只认 `scope`。此前"画像关 L3 + 闸只认授权表"可让审批端到端绕过。
- feat: **`approvalGate.scope` 由死配置变为真判定**——新增 `IRREVERSIBLE_IDS`（rm-rf / format-volume / drop-database / git-push-force / 系统路径写入）与 `profileScope()`；`scope:'irreversible'` 时非不可逆高危放行、不可逆类仍须审批。
- feat: **画像接入真实 pre-execute 链路（最后一公里）**——`pipeline.mjs` 的资格闸此前不传 `profile`，画像只在 `decide()` / `applyEligibility` 两条路可达、实际运行时失效。现从 `exec` 提取模型标识（`exec.agent.model` / `exec.agent.modelId` / `exec.model`，与成本台账同源）翻成画像交闸，`FG_MODEL_ID` 作显式兜底；取不到时为 `null` → 闸按最严 `mutating`（安全默认）。红线层不含画像开关，不可被画像放行。
- fix: **版本面补全**——monorepo 子包 `packages/core/package.json`（DSH 实际挂载的包，也是 GUI 里显示的版本来源）与 `packages/extended/package.json`、外接桥的版本标识此前未纳入版本面，导致"清单齐 3.0.4 而代码已 3.0.6"。现共 **8 处**版本点由断言锁定"彼此相等 **且** 等于 CHANGELOG 最新条目"。
- fix: **缺陷 3（闸与红线口径不一致）**——`gatedReasonOf` 命中 `HIGH_RISK_TOOLS` 后先问 `redlineExempt`，豁免成立则不进门槛清单；`write-system-path` 是路径检查，不套命令豁免。
- fix: **缺陷 6（判据名不稳定）**——新增 `redlineSpan()`：裁掉命中片段尾随的空白与收尾引号（**不含 `/`**，`rm -rf /` 的 `/` 是目标路径本体），使 span 稳定落在危险片段本体上。**注意：这不只是判据名变化，判据 1 的适用面按设计意图扩大了一档**——形如 `foo "rm -rf /"`（head 既非只读命令、也无数据标记）从"不豁免"变为 `quoted-literal`。已反证真执行未被放过：`rm -rf "/"` 裁剪后 span 与引号内容区间不相交仍不豁免，执行外壳仍由 `SHELL_EXEC_WRAPPER_RE` 拦。
- fix: **FG 自身缺陷：取证闸对"新建文件"死锁**——`layer3Check` 的取证判定加 `existsSync` 门：目标不存在（新建）直接放行，仅对**已存在**文件的修改要求先读。此前新建文件无既有内容可读 → 永远进不了 readSet → 只能靠"拒一次后豁免"逃生。
- docs: **L3 是否接豁免的判定**（外部接手模型提出）——**不接**：闸是"无授权即 deny"（无人类环节，须自判豁免），L3 是"转人工审批"（人类环节即裁决）。若 L3 也豁免，"数据形态的高危命令"会无人审批直接放行，风险不对称。判定已写入 `checkEligibility.mjs` 第 3 层注释，防后人当缺陷改回。
- fix: **测试污染真实工作区**——跑测试时审计流水写进真实 `<仓库>/.focus-guard/AUDIT.log`（实测 2630 行 / 746 个测试 session）。三处根因：① `auditDeny` 写死 `AUDIT_FILE`，而**同一文件**的 `auditRedlineExempt` 支持 `FG_AUDIT_FILE`（一文件两种口径）；② `acceptance.test.mjs::makeRunner` 直接透传 `process.env`，宿主设的 `CLAUDE_PROJECT_DIR` 让 `guard.mjs` 定位到真实工作区（原注释"无 ZCODE_PROJECT_DIR 即退回临时目录"的假设失效）；③ `eligibility.test.mjs` 只在两个审计用例内设重定向，且 `finally` 里 `delete` 掉它、把沙箱一并删除（该文件顶部"审计一律注入 mock"的承诺从未成立）。现：`auditDeny` 补重定向 · `makeRunner` 显式置空两个工作区根变量（`...env` 保持最后，用例覆盖仍生效）· `eligibility.test.mjs` 顶部统一沙箱、用例内改为"恢复"而非 delete。**验证：跑全套后 AUDIT.log 零增长**（历史污染已清理，备份于 `.ai/archive/`）。
- docs: 文档同步（外部接手交付，Lead 审计通过）——`README.md`（badge 3.0.4→3.0.6 · 问题→能力对照表 · 母版/适配/宿主缝三层表 · DSH 两条路互斥对比 · `ENGINE_VERSION` 从 **3.0.0** 修正为 3.0.6 并补 8 处版本面）· `INSTALL.md`（新增「2A. 原生插件（推荐）」节、卸载命令区分原生插件/官方桥）· `skills/focus-thinking/SKILL.md`（"生效版本"从 `hooks/guard.mjs v3.0.0` **修正为** `ENGINE_VERSION`——guard.mjs 已封存，不该再代表生效版本；并修正 monorepo 后的 `docs/RULES.md` 路径）· `docs/HANDOFF-TO-EXTERNAL.md`（补交付验证与 ENOENT 踩坑记录）。

- feat: **审计日志体积轮转**——`AUDIT.log` 此前 append-only 且无轮转，长期运行无限膨胀（本次事故即累积到 2997 行）。新增 `rotateAuditIfNeeded()`：超上限（`FG_AUDIT_MAX_BYTES`，默认 5 MB ≈ 2 万条）时移入同目录 `archive/AUDIT.log.<时间戳>` 并重建空文件，保留最近 `FG_AUDIT_ARCHIVE_KEEP`（默认 10）份。纪律：**只归档不删除**（执法记录不得丢）· 失败只 `warn` 不阻断 · 轮转失败**继续追加原文件**（宁可变大、不可丢记录）· 文件不存在（首写）静默放过，不刷噪音。⚠ 封存的 `hooks/guard.mjs`（ZCode 层）不经此处写入，**不受本机制管辖**——这是封存的代价。
- refactor: **审计写入收敛到单一入口** `appendAudit()`——三处写点（`auditDeny` / `auditRedlineExempt` / `auditEligibility`）此前各写各的，正是"同一文件两种口径"的温床（污染事故根因之一）。现共用同一入口，轮转只在一处生效，口径不可能再分叉。

- chore: **发布元数据补全**（dsh-market 收录前置）——`packages/core/package.json` 声明 `@deepseek-ai/dsh-tools` 为 **`peerDependencies`**：`>=0.1.0-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`（**显式预发布分支**，覆盖宿主 `0.2.0-rc.2` 元组——按 dsh-market 规则，不带预发布分支的范围会静默排除所有 rc 构建，用户装时会遇到 `ERESOLVE`），并标 `optional`（工具注册属可选加载）。此前包声明零依赖而代码实际 `import` 该包。另补 `packages/core/README.md` 与 `LICENSE`——此前 `license: MIT` 只是声明、无对应文件，npm 包页面会空白。

- fix: **DSH 侧状态所有权**（孤儿机制审计的第一步）——原生插件此前**没有 state 写入者**（唯一写者是 `guard.mjs`，而它在 DSH 下未挂载），连锁造成两个后果：① 取证记录（`readSet`）无法落盘，模块重载（HMR）/进程重启后凭空消失；② `layer3Check` 走 `readGuardState(undefined)` 退化成"扫 `os.tmpdir()` 取 mtime 最新"，会读到**别的会话或测试残留**——实测该目录有 199 个 `focus-guard-eval-*`（会被过滤）外加 acceptance/selftest 写的 `focus-guard-<sid>-<RUN>.json`（**过滤不掉**），于是拿别人（往往是空的）readSet 去判你的真实改动，表现为"拦不拦你取决于最近跑没跑测试"。现：① `rememberReads` 把 readSet 落盘到 `statePath(sessionId)`（原生插件的第一处 state 写权，KPI／预算池等机制后续依赖它）；② 新增 `readGuardStateExact()`，按会话身份**精确定位**、绝不做目录扫描。
- fix: **内存取证集合跨会话泄漏**——`nativeReadSet` / `evidenceBlockedOnce` 原为模块级单一 `Set`（按路径索引、不含会话身份），而 DSH 单进程内多个会话共用同一份 `pipeline` 模块，于是「会话 A 读过的文件」被判成「会话 B 也读过」，违反取证的本会话语义。现按会话身份分表（`Map<sid, Set>`）。
- test: 新增 `tests/state-ownership.test.mjs`（6 用例）——落盘、判定、**抗他人状态干扰**、会话隔离、无状态 fail-open 且留痕、真实工作区零写入。
- docs: **孤儿机制审计结论**（本次定级修复级的缘起）——DSH 侧另有两条**互斥**接入路径：**原生插件**（`pipeline.mjs`，在跑）提供资格审核／申辩／画像／命令硬校验／红线豁免；**官方桥**（`hooks.json` → `guard.mjs`，**未装**）承载 KPI／三预算池／高危审批单／抽查／污染检测／因果链／积木图书馆／降级／绝境／卷宗指纹等机制。`constants.mjs` 的 42 个导出常量中 **28 个在 DSH 侧零消费者、9 个仅被 `state.mjs` 引用（只存不判）**——它们**不是死代码**（由 `guard.mjs` 消费、经桥调用），但当前 profile 未装桥故此刻不生效。**两条路互斥意味着能力二选一**，而 README/INSTALL 只声明了单向差异（"桥不含资格审核"），未声明反向。后续按「移植 + 退役、先搬后删」把机制搬进原生插件，再退役 `guard.mjs`。另注：`selftest.mjs` 曾有 **6 项失败**（4 项是资格闸加入后的过期断言、1 项是本项目环境指纹硬校验的预期拦截、1 项用了不存在的目标文件因而测不到"未取证"），本次一并修正；同时**把它与其余散落的测试纳入 CI 闸**——`npm run check` 由 `test && eval`（2 套）扩为 `test:all + eval + selftest + bridges`（5 套，230 个断言），此前 `integration` / `state-ownership` / `profile` / `eligibility` / `bridges` / `selftest` 都不在闸内，红了无人知晓。

- feat: **原生插件补上缺失的三条宿主缝 + KPI 兑现移植**（孤儿机制移植第一步）——新增 `src/dsh/seams.mjs`，按官方桥（`@deepseek-ai/dsh-hooks-claude-code`）的**实测映射**接上三条缝：`agent/created` → SessionStart（建立本会话状态）· `agent/pre-step` → UserPromptSubmit（回合重置；**waterfall 必须 `return next()`**，否则吞掉下游决策）· `agent/turn-stopping` → Stop（**KPI 兑现结算**：本任务 KPI → 等次 → 委托池奖惩，跨任务累计入 `kpiCarry`，留痕 `kpi-settle` / `kpi-low`）。映射来源是桥的已验证代码、非猜测。`constants.mjs` 的 `BUDGET_CAP` / `DELEGATE_DEFAULT` 由此在 DSH 侧**首次被真正消费**——此前它们属于那 28 个零消费者常量。
- test: 新增 `tests/seams.test.mjs`（6 用例）——start 建状态并留痕 · reset 必须 `return next()` · KPI 优秀 +5 且跨任务累计 · 不称职 −5 且 `kpi-low` 只提醒一次 · 三条缝异常一律不阻塞 · 真实工作区零写入。CI 闸门至此为 **6 套 / 235 个断言**。

- feat: **移植批 1：批示识别与回合重置（`reset` 133 行）**——`preStepListener` 由骨架补齐为完整实现，照搬 `guard.mjs` L194-326：特赦识别 · 目标预授权（只记 goal、不解锁执行）· 信用延期（停滞≥2 且收到信用批示 → 侦查/执行池各补 `REFILL`）· **停止令**（`STOP_ORDER_RE` → 熔断；且不再被本函数后续的硬写回抹掉——那是 guard.mjs 2.5.2 修过的老 bug）· 追加批示（三池各 +`REFILL`）· **y/n 执行级授权**（y 放行全部待批并目标绑定、n 彻底阻断且清除历史绑定）· 残留核验（43 条）· 额度核定（`KEY50_RE`/`KEY15_RE`）。`constants.mjs` 的 `MERCY_RE` · `CREDIT_RE` · `STOP_ORDER_RE` · `KEY50_RE` · `KEY15_RE` · `BUDGET_DEFAULT` · `BUDGET_CAP` · `REFILL` · `INV_POOL_DEFAULT` · `DELEGATE_DEFAULT` 由此**首次在 DSH 侧被消费**。
- fix: **会话标识取值口径**——`agent/created` 等缝的会话 id 应取 `agent.session.header.id`（与官方桥 `lib/index.js:349-354` 同源）；此前误写为 `agent.session.id` 会取不到，于是**所有会话退化成同一个 `'dsh-native'`、状态互相覆盖**（与刚修掉的跨会话泄漏同类）。`projDir` 同步改用 `session.header.cwd`。
- test: `seams.test.mjs` 扩到 11 用例（新增停止令熔断 · 三池追加 · 额度核定 · y/n 授权与目标绑定 · 非批示文本不误判）。CI 闸门至此 **6 套 / 240 个断言**。

- feat: **移植批 2：体积刺客三闸 + 污染核实闸 + 风险文件留痕（约 48 行）**——`preExecuteListener` 新增三段（插在资格闸之后、第 2 层语义预判之前）：① **Read 整读体积闸**（超 `OUTPUT_GATE_BYTES` 拦，并**保留 2.5.3 的审计任务豁免**——法典把审计定为 50 预算重大专项，体积闸却拦审计最需要的整读，属制度性误伤）；② **Grep content 无 `head_limit` 闸**；③ **裸 `cat`/`type` 刷屏闸**（在本环境**不可达**：第 1.5 层环境指纹 `cat`→`bat` 先拦，保留作兜底）；④ **污染核实闸**（上轮输出与参数矛盾 → 首个改动类拦一次、一次性）；⑤ **风险文件修改 100% 留痕**（`.github/` 等，只记不拦）。**批 2 有意不搬**与既有功能重叠者：高危命令闸与脚本写入闸（依赖审批单机制，与资格闸的关系待定）· 触发①/盲写检测（已被第 3 层按文件覆盖）。裁剪理由：硬搬会造成"一个命令被拦两次"或两条路冲突。
- fix: **参数遮蔽导致两段新闸静默 fail-open**——`preExecuteListener({ …, statePath })` 的**参数名 `statePath`** 遮蔽了从 `state.mjs` import 的同名函数，函数体内 `statePath === undefined` → `statePath is not a function`，且**被 `try/catch` 的 fail-open 吞成放行**（安全上正确，但 bug 完全静默，靠 `warn` 输出才抓到）。现 import 改用别名 `guardStateFile`，并加注释说明原因。
- test: 新增 `tests/gates.test.mjs`（8 用例）。CI 闸门至此 **6 套 / 248 个断言**。

- refactor: **审批单机制退役（`fg_apply` 为唯一授权入口）**——按人类批示（2026-10-10）：审批单只需敲一个 `y`，**无目的、无范围、无留档**；与 `fg_apply`（要求 purpose/scope 结构化留档）并存时，人会本能选省事的那条，使"事前结构化申请"形同虚设。**留一条能绕过主设计的旁路，等于没有主设计。**
  - **代码**：`seams.mjs` 移除批 1 照搬的 y/n 批示识别（`Y_TOKEN`/`N_TOKEN`/`LEAD`/`TAIL`）与待批队列处理，以及 `highRiskDeniedThisTurn` 死字段（保留退役说明注释）。
  - **修法**：RULES 第七十五条(三) **实质保留**（"推送远端属对外发布行为，须审批"），授权方式由"出具【高危申请】审批单 + 领导回复 y"改为"**须先调 `fg_apply` 取得授权**（附 purpose/scope 结构化留档）"；(四) 合并审批与批示词容错**标注废止**；第二十四条删去"「同意」即审批单放行"之注；第八十三条(三) 由"不替代审批单"改指 `fg_apply`；技术映射表两行同步。**立法沿革保留**（与第十九条「（已废止·编译版 v1.1）」同例）。
  - **验收**：`acceptance` 的"文档-实现对齐"断言从**锁定 y 放行口径**改为**锁定 `fg_apply` 口径**，并新增"审批单口径不得残留"的反向断言。
  - **不受影响**：`fg_appeal` 误伤申辩——它不是绕过而是救济（须附反例锚点、人类一次性裁决、全程留痕）。
- test: `seams.test.mjs` 的 y/n 授权用例改写为"审批单退役后 `y` 不再构成任何授权"（断言 `highRiskOk` 未被设置、无 `high-risk-approved` 留痕）。

- feat: **移植批 3：post-execute 进度与执法缝（242 行）**——新增 `src/dsh/postProgress.mjs`，与 `postExecuteListener` **同事件并列监听**。移植自 `guard.mjs` L666-907：**进度检测引擎**（响应/入参签名比对，判定有效 vs 无效调用）· **三预算池核算**（执行池/侦查池分列，自动续杯、硬上限熔断、侦查池超限）· **停滞熔断**（连续无效达 `STALL_FUSE` → 熔断 + 预警）· **58 条上下文污染检测**（`head -n N` 行数对账、清单路径重复 → 设 `pollutionFlagged`）· 巨量输出事后追责 · **子代理摘要校验**（KPI ±3）· **强制委派场景检测**（KPI ±5）· **抽查 A**（每 `RANDOM_AUDIT_EVERY` 次写操作全量审计）· 卷宗指纹与 TTL 依据（`caseCache`）。工具名按 DSH 适配（`Agent`→`agent|subagent`、`Bash`→`pwsh|bash`、大小写不敏感）。
  - **闭环**：本批设置 `pollutionFlagged`，批 2 已搬其消费侧——跨模块用例锁定"post 标记 → pre 拦一次 → 重试放行"。
- fix: **会话标识取值口径（第二处、更严重）**——`audit.mjs` 的 `sessionOf` 与 `pipeline.mjs` 的 `sessionIdOf` 只认 `exec.sessionId`/`agent.sessionId`/`agent.id`，**三者皆空** → 全部退化成 `'dsh-native'`。实测真实 `AUDIT.log` 里 **439 条**记录都记在 `dsh-native` 名下，而取值正确的 `seams.mjs` 写的是 `sess_<uuid>`——**即所有会话共用一份状态文件与一条审计流**。现统一为桥的口径（`agent.session.header.id` 优先）。
- fix: **`postProgress` 误用母版 `audit` 会写真实工作区**——母版 `audit()` 按 `auditTarget()` 落盘，优先读 `ZCODE_PROJECT_DIR`/`CLAUDE_PROJECT_DIR`，而 DSH 下后者被设置 → 会写真实工作区的 `.focus-guard/AUDIT.log`（重演此前修过的测试污染）。现改用本地同签名包装，落点走 DSH 统一入口 `appendAudit`（尊重 `FG_AUDIT_FILE`、带体积轮转）。
- test: 新增 `tests/postProgress.test.mjs`（9 用例，零污染）。CI 闸门 **6 套 / 257 个断言**。
- note: **实弹验证意外达成**——DSH 插件**热重载生效**，新注册的 `postProgressListener` 在本次会话**真实运行**并把"连续工具调用被取证闸拒"判为停滞、累加至 `STALL_FUSE` 触发熔断（本人被自己的护栏拦下 3 次 edit）。这既证明监听器真的挂上了，也暴露一个**待评估的误伤面**：`progress` 判定未区分"调用失败"与"无进展"，当工具屡遭拦截时会误判为停滞。已记录，留待评估（`guard.mjs` 原逻辑如此，不宜擅自改动）。

- feat: **移植批 4：start 与 stop 收尾缝（约 300 行）**——新增 `stopGuard.mjs`，并扩充 `sessionStartListener`。
  - **start**（`agent/created`）：环境检测入 `state.envCache` · 卷宗载入（`inherited` 标记）· 卷宗【一】环境声明落卷（原子写）· 36 条 HANDOFF 交叉巡视 · 42 条部署版本核验 · 因果根链 · `rules-registered` 备案。
  - **常驻规则注入**：`guard.mjs` 把 `SESSION_RULES` 经 stdout 的 `hookSpecificOutput.additionalContext` 输出（Claude hooks 协议）；原生插件无此契约 → 改由新增的 `systemPromptRulesListener` 经 `system-prompt/assemble` 注入**独立 section**（与成本提示行并列，不改动下游既有 section）。
  - **stop**（`agent/turn-stopping`，与 KPI 结算并列监听）：任务规模声明（`TASK_SCALE_RE`）· 绝境模式豁免 · **《授权识别与留痕条例》三重核验**（引用原文 ↔ 本回合实际指令比对 / 法条 / 授权语义；不合格 → 熔断 + L3 留痕）· 触发⑤ 熔断声明与未知跟踪 · 79 条经验库 `PATTERNS.md` 创建 · 触发②（本回合 ≥5 次调用无锚点）。
  - **两处刻意取舍（均因 DSH 的现实）**：① **只审计、不打回**——`guard.mjs` 用 `block()` 打回，靠宿主协议信号 `input.stop_hook_active` 保证"只打回一次"，而 DSH 无此信号，误打回会变成强制续跑死循环（本移植过程中本人已被自家熔断拦过）；② **无收尾文本时跳过文本核验**——沿用原文对"无文本宿主"的 `dshBridge` 降级口径，否则锚点核验会对空文本必然失败、把每次收尾都判成"无锚点"。
  - **不搬**：高危审批单收尾校验（L1059-1077）——该机制已退役。
- fix: **测试污染彻底修复（第三处）**——`state-ownership.test.mjs` **从未设置审计沙箱**，尽管其头部注释声称"一切写入重定向到 tmpdir"。`preExecuteListener` 的 deny 路径经 `auditDeny` 写进了真实工作区（实测 `own-` 前缀 39 条）。现补上 `FG_AUDIT_FILE`。另修 `integration.test.mjs` 的 `after()`：**`delete process.env.FG_AUDIT_FILE` 改为恢复沙箱路径**——`node --test` 多文件可能共享进程，delete 会让后续测试文件落回真实审计（与 `eligibility.test.mjs` 的已有写法对齐）。
  - **验证**：连续两次全量 `npm run check`，`own-` / `gate-` / `post-` / `seams-` / `lc-` / `eval-` 增量**全部为 0**；总增量 15 条经查全为 `deny`（本会话被护栏拦截的真实执法记录，属设计内）。
- test: 新增 `tests/lifecycle.test.mjs`（11 用例）。CI 闸门至此 **9 套 / 268 个断言**。

- feat: **移植批 5：pre 结构性执法（102 行）**——新增 `src/dsh/preGuard.mjs`（与 `preExecuteListener` **同事件并列监听**）：**资料分层隔离**（静态资料区/派生积木区不得直写，防自我投毒）· **环境规则检查**（`platformBashViolation`：平台不兼容命令；与第 1.5 层"环境指纹替换"**不是同一机制**——前者管平台本身，后者管本机替代）· **大小写不敏感文件系统的重名冲突**（不可用 `existsSync` 豁免：不敏感 FS 上大小写变体目标恒存在）· **子代理闸**（熔断期委派 = 越权绕行 L4/L5 · 48 条继承留痕 · 蜂群因果子链 `/dN` · **委托池消耗**）· **熔断期白名单**（只读放行/改动拒绝，且**熔断期不是高危命令的免检通道**）· **L2 强制取证 / L5 降权**（改动类一律拒绝）。
  - **委托池至此闭环**：追加侧在批 1 的 `preStepListener`（人类批示『追加额度』三池各 +10），消耗侧在本批（每次委派 −1）与 KPI 结算（委托池奖惩）。
- fix: **工具名口径（适配层缺失，跨批次影响）**——母版 `risk.mjs` 的 `isMutating` / `isInvestigation` 按 **ZCode 命名**精确判定（`tool === "Write"`、`["Read","Grep","Glob",…]`），而 DSH 传**小写**（`write` / `read` / `pwsh` / `subagent`）→ 恒不匹配。后果不是"漏拦一次"而是**静默判错**：`isMutating('write') === false` 使 L2/L5 期间改动类**不被拦**；`isInvestigation('read') === false` 使**只读调用被计入执行池**，侦查池永不满、执行池被只读调用提前耗尽（**批 3 的 `postProgress` 已带此缺陷**）。新增 `src/dsh/toolName.mjs` 做归一化——修在**适配层**而非母版：母版要同时服务 ZCode 与 DSH，翻译是适配层职责；改母版会把 DSH 命名泄漏进母版、破坏"母版零宿主依赖"的分层约定。
- test: 新增 `tests/preGuard.test.mjs`（10 用例，含委托池**闭环**用例：追加侧补池 → 消耗侧委派）。CI 闸门至此 **10 套 / 278 个断言**，测试污染零增量。

- feat: **移植批 6：卷宗不重复读 + 改动前备份（44 行，功能补齐）**——并入 `preGuard.mjs`：
  - **卷宗不重复读**（总纲四）：指纹（mtime+size+SHA/git）一致且 TTL（`resolveTTL`）未超 → **拦免重读**，复用已有取证；指纹变化或 TTL 超时 → 放开真重读（post 缝会更新卷宗指纹）。**与第 3 层取证闸语义相反**（那座闸管"没读就改"，本闸管"读了还读"），二者不冲突：取证闸只对改动类（`MUTATING_TOOL`）生效，本闸只对 `Read` 生效。**卷宗继承记录（`inherited`）只提示不拦**——本会话从未读过、内容不在上下文，拦首读即阻断取证；`offset` 增量读永远放行；熔断/强制取证期豁免。
  - **74 条改动前自动备份**：所有闸通过、调用确定执行 → `backupBeforeEdit` 落 `.ai/backup/`，供无版本库工作区回滚。
  - **子代理继承不再另接缝**：批 5 已在 `pre` 侧以 `Agent` 工具名判定并留痕 `subagent-spawn`（父状态随派单移交），批 3 的 `postProgress` 已在 `post` 侧按 `subagent` 处理摘要校验——`subagent/start|end` 两条缝**无增量价值，不接**（避免重复实现）。
- test: `tests/preGuard.test.mjs` 扩到 15 用例（新增卷宗免重读 · 继承放行 · offset 放行 · 内容变化放行 · 改动前备份）。CI 闸门 **10 套 / 283 个断言**。

- fix: **人类文本提取的健壮性（真实载荷形状修正，P0）**——重启后的实弹验收里，真实会话审计的 `reset-fired` 出现 `prompt:无`，即 `humanTextOf(messages)` 取不到人类文本。根因两条：
  - **形状不止一种**：原实现只认 `messages[].content[]` 的 text 块（照官方桥 `blocksToText` 的假设），真实载荷对不上 → 人类文本恒为空 → **批示识别全部失效**（`追加额度` / `停止令` / 特批 / 额度核定 50·15 全都拿不到输入，额度永远按默认 10 走）。**测试发现不了，因为测试造的就是自己假设的形状**——"单元测试全绿 ≠ 真实载荷正确"的典型。
  - **messages 里混有非人类消息**：DSH 的 pre-step 默认 next 是 `{ messages: [...claimed, context] }`（`dsh-agent-loop/lib/index.js:911-918`），**渲染后的系统提示也会作为一条消息追加进来**。若无条件拼接，会把系统提示当成人类批示——**比"取不到"更危险的方向**。
  - 现改为健壮提取：**优先只取 `role === 'user'` 的消息**（排除 pre-step 追加的 context），并对 `content[]` 文本块 / `content` 字符串 / `text` / `parts[]` / 裸字符串逐层兜底；无 role 信息时退回全量。`reset-fired` 增加文本长度诊断（`prompt:有(N字)`），下次真实回合即可确认。
- test: `seams.test.mjs` 扩到 14 用例（新增 5 种载荷形状 · **非 user 消息不得被当批示** · 无 role 退回全量）。CI 闸门 **10 套 / 286 个断言**。

- fix: **子代理分流（避免对 subagent 做无意义且有副作用的初始化）**——实测（hermes-loop 的复盘子代理，`ctx.agents.create({ meta: { origin: 'subagent' } })`）会**同样触发 `agent/created` 与 `agent/pre-step`**，而 FG 未加区分，于是对一个只跑几十秒的子代理：① 做完整环境检测、载入 **39 条卷宗记录**（实测白占 20KB 状态文件）；② **重写工作区 `.ai/CASE_FILE.md` 的卷宗【一】**（每次 agent 创建写一次 → 文件抖动、并发时可能互相覆盖）；③ 把它**由父 agent 生成的 prompt 当成人类批示**去识别（实测复盘 prompt 命中 `KEY50_RE` → 额度误判为 50，并记了无意义的 `goal-preauth`）。现按 `origin === 'subagent'`（兜底 `delegationDepth > 0`）分流：子代理只落一份最小状态、只做回合重置，跳过环境检测 / 卷宗读写 / 规则备案 / 巡视 / 批示识别。
- fix: **42 条版本核验误报**——核验把 `packages/core/hooks/guard.mjs` 的版本号与 `ENGINE_VERSION` 比较，但该文件是**封存版、版本号独立**（header 写明不随 FG 主版本更新，见 `HANDOFF.md` §九），于是**每次会话都误报"部署漂移 v3.0.6 ≠ v3.0.4"**。现将其列入 `SEALED` 排除清单。
- test: `seams.test.mjs` 扩到 17 用例（新增子代理轻量初始化 · 子代理跳过批示识别 · 主会话分流不受影响）。CI 闸门 **10 套 / 289 个断言**。

## 3.0.5 · 事前资格审核、模型画像与命令硬校验

- feat: **资格审核逻辑层**——`core/checkEligibility.mjs` 六层判定（L0 申请完整性 / L1 状态 / L2 绝对红线 / L3 高危资格 / L4 前置条件 / L5 语义信号 / L6 授权并留痕），依赖注入 `redlines`/`model`/`audit`/`grants`/`profile`，母版不反向依赖适配层；`core/grants.mjs` 授权表为 FG 独有状态（按会话分表，不进 guard 状态）。
- feat: **fg_apply 工具与双入口闭环**——`adapters/dsh/fg-apply-tool.mjs` 按 `defineTool({name, description, parameters, execute})` 注册；`adapters/dsh/eligibility-gate.mjs` 提供 `applyEligibility`（审核期临时授权、未通过立即收回，避免申请通道被自己的第 3 层挡死）与 `gateToolCall`；`src/dsh/pipeline.mjs` 在硬校验之后接入资格闸——高危工具无授权即 deny，理由指向 `fg_apply`。
- feat: **模型画像系统**——`src/profiles/` 五份纯参数画像（deepseek-flash / deepseek-pro / glm / gpt-astra / default）+ `core/profileLoader.mjs`（层→子开关映射、别名表、id 精确与前缀匹配、default 兜底，零 `modelId` 硬编码分支）；`checkEligibility` 按画像开关跳层并把跳过项写入 trace 与审计；`core/decisionEngine.mjs` 汇总 decision / layer / skipped。不传 `profile` 时行为与 3.0.4 一致。
- feat: **环境指纹与命令硬校验**——`tools/env-fingerprint.mjs` 探测平台 / shell / 工具并产出 `.ai/env-fingerprint.json`；pipeline 第 1.5 层据其 `map` 做命令硬校验（`grep`→`rg`、`find`→`fd` 等替代提示），不依赖模型自觉。
- refactor: 核心源码分层——`hooks/guard.mjs` 三次拆出 `src/core/{constants,redlines,audit,risk,state,env,backup,approval,session}.mjs` 与 `src/adapters/dsh/protocol.mjs`。

## 3.0.4 · 双包 monorepo 与中心蜂群强化

- feat: 仓库重构为 npm monorepo——`packages/core`（`focus-guard`，零依赖范本包）+ `packages/extended`（`focus-guard-extended`，依赖 core，承载外接三件套）；`npm install focus-guard` 只下载核心，永不拉取扩展依赖。
- feat: 中心蜂群强化（第八十条增订七～十，采自 Claude cowork 与 GPT-6 蜂群提示词研究 R8）：调度三分法与 ack 并行、派单给目标不给方法脚本、并行默认流水线（屏障例外须说明）、跨任务授权不对称（收到他任务来函≠授权）、协作动作禁藏入脚本、模型分层蜂群（全量继承禁降档）。
- feat: 对抗验证三怀疑者模式（第八十一条增订四，采自 Claude cowork 质量模式库）：各自"试图驳倒"、默认 refuted、多数决存真，复核截断必须留痕（no silent caps）。
- chore: 插件挂载路径适配 monorepo——hooks.json 六条命令与插件清单指向 `packages/core/`；42条部署核验新增 monorepo 路径；`external-bridges` 分支废止（内容入 extended 包），`v3.0.2-external` 标签留档。
- fix: library-build 幂等键改为纯内容指纹配对（修复路径分隔符差异导致的重复积木）。
- docs: 对外文档剥离内部公文语气（CHANGELOG/README/INSTALL 回归开源专业表达，历史条目同步改写）；研读笔记 R8 入积木图书馆（共 75 块）。

## 3.0.3 · 主分支精简版（外接层移出）

- refactor: 外接三件套移出主分支——`tools/viking-bridge.mjs`、`tools/needle2-sentinel.mjs`、`audit-chain --semantica` 及对应用例、README 外接节、`viking` 脚本；主分支保留哨兵本体与 `FG_SENTINEL_CMD` 外判契约。
- docs: README 外接指引与 CHANGELOG 同步；版本链 3.0.2 → 3.0.3。

## 3.0.2 · 外接三件套

- feat: `tools/viking-bridge.mjs`——积木图书馆同步 OpenViking：积木以 `viking://resources/focus-guard-library/` 落入 resources 作用域；默认导出 batch-write 载荷，`--push` 直推（`OPENVIKING_URL`/`OPENVIKING_API_KEY`，默认端口 1933）。
- feat: `tools/audit-chain.mjs --semantica`——执法档案因果链导出 LPG 图谱 JSON（`caused`/`spawned` 边），供 Semantica Knowledge Explorer 导入。
- feat: `tools/needle2-sentinel.mjs`——Needle 2 本地模型外判运行器（`FG_SENTINEL_CMD` 契约；`NEEDLE2_BIN`/`NEEDLE2_MODEL` 指向本地推理运行时；失败静默回退内建启发式）。
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
- feat: 静态积木图书馆（第八十二条）：`.ai/library/` 积木区不可变、引擎拦截直写、新知只进 `inbox/` 便签区（记忆更新隔离区）、积木读不进卷宗【三】；新增 `tools/library-build.mjs` 构建器（幂等重建）。
- feat: 本地哨兵接入层（第八十三条，opt-in `FG_SENTINEL=1`，默认仅记档 audit-only，`FG_SENTINEL_MODE=strict` 拦截）。
- feat: KPI 兑现闭环（第八十四条）：收尾即结算——KPI→等次→委托池奖惩（+5/0/-2/-5），跨任务累计 kpiCarry 落台账，AUDIT 记 `kpi-settle`。
- feat: 提问即治理（第八十五条）：任务漏斗（目标→约束→验收锚点→额度批示）；计划批准≠实现批准。
- feat: 因果链追溯（第八十六条）：AUDIT.log 每条增 `seq/chain/ref` 三字段，委派派生 `/dN` 子链；新增 `tools/audit-chain.mjs` 渲染因果树/Mermaid。
- fix: FG-D1 授权引文核验窗口 500→4000 字符（长批示靠后的授权原文此前必然核验失败误判越权）；FG-D2 卷宗【一】改原子写；FG-D3 rename 失败清理 tmp 残片；FG-D4 卷宗初始化降级防御。
- fix: 解释器 eval 类命令（`python -c`/`node -e`）不再判只读侦查——堵住熔断期白名单放行解释器的洞。
- breaking: AUDIT.log 追加 `seq/chain/ref` 三字段（追加式，旧解析器兼容）；解释器 eval 类 Bash 改判执行类（熔断期不再放行、计入执行池）；常驻注入 411→425 字（仍低于 500 字立法上限）。
- docs: 新增 `docs/MASTER-PLAN-3.0.0.md`（协作治理总纲）、法条第十五章之二（第八十～八十六条）、SKILL §13-16 镜像。

## 2.5.3 · 实测误伤修复

- fix: 卷宗免重读限定会话内——跨会话继承指纹只提示不拦（内容不在本会话上下文，拦首读即阻断取证）；会话内真读后恢复拦截。
- fix: 58条对账限单条语句——复合命令（`&&`/`;`/换行）跳过整段对账，清除六起系统性误报（巨量输出仍由体积追责兜底）。
- fix: 审计任务体积闸豁免——批示含"审计/盘点/审查"时取证对象整读留痕不罚（预算与巨量输出追责仍生效）。
- chore: 卷宗【一】/PATTERNS.md 写失败告警；61条落地（启动清扫临时目录 30 天陈旧文件）；法典 v1.1 修法（SKILL 效力条款改"暂停机械执行＋报请裁决"、废止 19/24四/44/45/46条）；仓库迁移 JohnnyEisen → irisblackwood。
- test: 验收 86 → 90 用例。

## 2.5.2 · 对抗审查版

- fix(安全/P0): 熔断期不再放行高危命令——旧顺序让只读白名单先退出，`npm publish`/`shutil.rmtree`/`reg add`/`diskpart` 等直接绕过审批；现白名单之前先判高危，熔断期一律拒绝。
- fix: 中文批示生效（`同意/批准/允许` 与 `不/拒绝` 因正则 `\b` 不识别 CJK 全部失效 → 整句精确匹配）；「停止/熔断」批示真正生效（熔断状态曾被同一函数写回 false）；超 300 字符命令 y/n 生效（比对键改全量哈希）；Stop 打回一次性保护（杜绝强制续跑死循环）。
- fix: 变更类命令识别——`sudo mv`/`xargs mv`/`cp`/`sed -i` 不再被当只读侦查；shell 重检修复（zsh/sh 不再误报为 bash）。
- chore: `.env`/私钥不再落明文备份；会话状态原子落盘；SQL WHERE 豁免按单条语句判定；`curl -d` 与 `-D` 区分大小写；补齐 `find -delete`/`rimraf`/`wget --post-data`/`Invoke-WebRequest -Method POST` 特征。
- chore: 新增 CI（Windows 必过，Linux/macOS 观察项 × Node 18/20/22）；威胁评测 31+16 → 61+34；验收 63 → 86。

## 2.5.1 · 盘点修复版

- fix: 版本一致性——`ENGINE_VERSION`、引擎头注释与五处清单统一并新增自检用例锁定。
- fix: 假留痕防线——AUDIT.log、卷宗【三】【四】、改动前备份写失败一律上报 stderr。
- feat: 卷宗【一】环境声明落卷（此前仅占位符）；42条适配"根即插件"布局。
- fix: 58条路径查重改判"首 token 是路径"（git 警告散文行不误报）；委派 KPI 落台账并阈值提醒；删除只写不读的 `envChecked`；五处清单 description 去重（加用例禁止镜像复制）。

## 2.5.0 · DSH 硬拦截

- feat: 官方桥 `dsh-hooks-claude-code` 直接运行 `hooks/hooks.json`——DSH 获得与 ZCode 同级硬拦截（exit 2 阻断、stderr 原文透传、Stop 打回），取代 fire-and-forget 监察模式。
- fix: 识别桥接 Stop 签名自适应降级（锚点/审批单打回仅审计），防桥接强制续跑死循环；`cordis.patch.yml` 改空载（避免 bundle 与桥双跑）。

## 2.4.1 · 特征库加固

- fix: 堵住 `git -C <目录> push`、`rm --recursive`、node `rmSync(recursive)`、无 where 的 `DELETE FROM`/`UPDATE SET`；补 `DROP DATABASE`。
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

- feat(2.0.0·破坏性): 卷宗四册（`.ai/CASE_FILE.md`：环境声明/依赖声明/侦查记录/额度台账）、会话级环境检测一次复用、跨回合取证指纹（mtime+size+SHA-256≤200KB+git 脏态）、自适应 TTL（4h/2h/24h/7天，依赖声明 > 人工标注 > 自适应）、免重读放行、跨平台命令拦截、额度台账落卷；旧 mtime 逐回合闸废弃。
- fix(2.0.1): win32 shell 误判热修（PSModulePath 机器级恒存不再判为 PowerShell）。
- chore(2.0.2): `.csproj`/`.sln` 列入风险文件备案。
