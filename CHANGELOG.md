# 变更记录（CHANGELOG）

> 本文件按版本倒序记录面向使用者的变更。版本号与**七处清单**（根 `package.json`、根 `marketplace.json`、
> `.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、
> `packages/core/package.json`、`packages/extended/package.json`）及引擎 `ENGINE_VERSION` **完全相同**
> （共 8 处版本点），且**必须等于本文件最新条目版本**——两条一致性均由验收用例锁定。
> 引擎头注释（`hooks/guard.mjs`）例外：该文件已封存、版本号独立，由断言锁定其"封存标注"而非版本相等。

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
