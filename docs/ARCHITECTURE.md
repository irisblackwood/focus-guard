# 架构与机制（ARCHITECTURE）

> **状态**：权威 · 适用版本 3.2.1 · 最后核对 2026-10-28
>
> 3.4 D1：从 README 迁出的机制正文（触发层/处罚/预算/卷宗/监察/审批/资格/委派/运行面/配置/工作原理/测试/双包/边界）。
> README 只保留入口；这里回答「怎么运作」。法条原文仍以 RULES.md 为准。

---
## 核心机制

### 空气层（日常零打扰）
对话、分析、讨论、解释：不查、不拦、不提醒。执法只看行为，不查词。

### 触发层（行为五条，违规即罚）

| # | 触发条件 | 判定 |
|---|---|---|
| ① | 未取证就改 | 本回合 0 次调查（读文件/Grep/搜索/只读命令）就 Write/Edit/改动类 Bash |
| ② | 无锚点结论 | 回合内调用 ≥5 次后收尾无 `[文件:行号]`/`[日志原文]`/工具结果，也未标【假设】 |
| ③ | 体积刺客 | 整读 >50KB 文件、Grep content 无 head_limit、裸 cat/type 刷屏（批示含"审计/盘点/审查"时，取证对象整读留痕不罚——2.5.3） |
| ④ | 动态预算超限 | 有效调用超任务预算，或连续 5 次无效调用（真失控） |
| ⑤ | 硬凑不熔断 | 查无实据仍强行猜测；连续 2 次未知声明同样熔断 |

### 梯度处罚（L1–L6）

`L1 打回重写 → L2 强制取证 → L3 熔断 → L4 记档 → L5 降权 → L6 上报人类`

同回合违规数累加自动爬升。熔断期只读调查类仍可用、改动类全拒、非只读放行的高危命令同样拒绝（2.5.2 修复）。人类新指令即"批示"、全部解除；**唯「停止/熔断」批示本身就是熔断**，不会被解除。

### 预算与进度检测（三预算池）

- 初始预算按批示关键词核定：审计/红队/重构/全量/批量/探索/遍历/升级/补丁 → **50**；修复/添加/修改/重命名/删除 → **15**；其他 → **10**。首轮可声明【任务规模】上调，只升不降，硬上限 **200**；
- **三池分立**：侦查池（只读，独立 15 次）／执行池（Write/Edit/变更命令）／委托池（子代理，独立 20 次），互不挤占；短指令『追加额度』执行/侦查/委托三池各 +10；
- **有效调用**（返回内容有变化/产生文件变更/出现新报错）满阈值自动续杯 +10；
- **无效调用**（重复读同一内容/同命令同返回/失败调用）连续 **5** 次 → 判真失控直接熔断；停滞 4 次时预警，可申请【信用延期】由人类批示。
  **闸门拒绝不计入无效调用**（被拦是判定生效，不是空转）；`effectiveCalls`/`invCalls` 是**回合级**计数，换回合清零。

### 卷宗体系（四册，总纲见 [docs/MASTER-PLAN-2.0.0.md](../packages/core/docs/MASTER-PLAN-2.0.0.md)）

工作区档案 `<工作区>/.ai/CASE_FILE.md`：

| 册 | 内容 | 维护方 |
|---|---|---|
| 【一】环境声明 | OS / Shell / 编码 / 路径分隔符 / 大小写敏感 / BSD 工具 / 可用命令 | 引擎（会话级一次检测，结果直接落卷可查阅） |
| 【二】项目依赖声明 | 依赖名 / 版本 / 安装路径 / 信任 TTL（如游戏本体 60 天） | **人工填写** |
| 【三】侦查取证记录 | 文件名 / 读取时间 / mtime / size / SHA-256 / 变更历史 / TTL / 验证方式 | 引擎自动追加 |
| 【四】工作额度台账 | 初始额度 / 已用 / 剩余 / 有效 / 无效调用 / KPI | 引擎（回合末落卷） |

- **环境检测一次全程复用**：SessionStart 检测一次，`UserPromptSubmit` 不重检，仅在探测到 shell 变化时重检；
- **跨回合取证指纹**：mtime + size + SHA-256（≤200KB）+ git 脏态，指纹一致且 TTL 未超 → **免重读放行**（拦截本次 Read，复用已有取证）；不一致或超时 → 放行真重读并更新卷宗。时间戳伪造（`touch -d`/`cp -p`/`git checkout`）无法绕过 SHA 内容校验；**免重读限同一会话内**——跨会话继承的卷宗指纹只提示不拦，首读永远放行（2.5.3）；
  - **边界（别读成"任何尺寸都防伪"）**：SHA-256 只对 ≤200KB 的文件计算。超过 200KB 退回 mtime+size+git；工作区没有 git 时（`gitDirty` 为 null），"同尺寸改写 + 还原 mtime"无法被察觉。大文件请依赖版本库或单独做内容校验；
- **自适应 TTL**：首次 4 小时 → 7 天内有变 2 小时 → 7–30 天未变 24 小时 → 30 天未变 7 天；优先级 **依赖声明 > 人工标注（【三】TTL 列手填）> 自适应**；
- **免重读豁免**：`offset` 增量读永远放行；熔断/强制取证期豁免（降级重建证据需要真重读）；
- **跨平台命令拦截**（按检出 shell 适配）：PowerShell 会话禁 bash 管道（`\| head`、`&&`）与裸 Get-Content，改用 `Select-String`/`Measure-Object`/`-TotalCount`；macOS 禁 `sed -i` 无后缀、`grep -P`、`readlink -f`；大小写不敏感文件系统禁仅大小写不同的重名文件；Linux 标准 GNU 无特殊限制。

### 监察与留痕

- **盲写拦截**：写"本回合没读过的已存在文件"100% 拦截；
- **风险文件留痕**：`package.json`、lock、CI 配置、`.env`、`.csproj` 等修改 100% 记录；
- **抽查A**：每 5 次写操作全量审计 1 次（确定性节奏，不是随机抽样）；
- **上下文污染检测**：工具输出与指令矛盾（单条语句的 head 行数超限 / 清单路径重复；复合命令不整段对账——2.5.3）→ 立即停用该输出，用带标记的小命令隔离核实并报告人类；
- **回合卫生**：回合开始核验上一回合计数/熔断/取证/降权残留（43条），异常记档后清理；新会话发现 `HANDOFF.md` 注入交叉巡视提醒（36条）；引擎与工作区源码版本不一致告警（42条）；
- 一切执法行为（触发/处罚/抽查/特赦/预算伸缩）写入 `<工作区>/.focus-guard/AUDIT.log`（JSONL）：时间 / 会话 / 动作 / 触发条件 / 级别 / 证据 / 是否特赦。

### 授权与高危命令审批

- **授权识别**：凡声称依人类授权绕过护栏（熔断/锚点/预算/体积），必须先出【授权识别】引人类指令**原文** + 指明法条依据；引擎核验引文确实出现在本回合指令且含授权语义。伪造/事后补 → L3 熔断；意图明显但未明说 → 出【授权待确认】暂停并提问；
- **高危命令闸**：即使完全访问（yolo/自动批准）模式，**六类不可逆命令仍须实时审批**——
  破坏性删除（`rm -r`、`rm --recursive`、`shutil.rmtree`、`find -delete`、`rimraf`、`DROP TABLE`）、
  强制推送与历史覆盖（`git push`、`git reset --hard`、`git clean -fd`）、
  系统权限与配置（`chmod 777`、`chown`、`reg add/delete`、`net user`）、
  全局依赖安装（`npm i -g`、`pnpm add -g`、`yarn global add`、`apt-get install`、`docker run --privileged`）、
  对外发送与发布（`npm publish`、`docker push`、`curl -X POST`/`-d`、`wget --post-data`）、
  数据库影响（无 where 的 `DELETE`/`UPDATE`、`DROP DATABASE`）；
- **审批单是唯一通道**：命中 → 拒绝并要求一行
  `【高危申请】命令：<真实命令> | 真实目的：<一句话> | 影响范围：<具体文件/表/系统> | 回滚方案：<可否回滚> | 允许执行？(y/n)`；
  收尾没带单 → Stop 打回补交（一次性，不无限重复）；
- **`y` 放行本次**（一次性，改一个字符都要重新申请）；**`n` 彻底阻断**（会话内不得重发）。中文同样有效：**同意/批准** = y，**不/拒绝** = n；
- **预授权隔离**：任务指令里的「最后上传 github」只是目标预授权（goal），不解锁任何执行；执行级授权只认人类当下对审批单的短批示；
- **严禁脚本包装**：被拒后写 `push.sh` 再执行 = 对抗审查（从重记档）；高危脚本的**写入本身**也要走审批单；
- **不设卡**：普通单文件 rm、构建、测试、本地 commit、常规 `curl` GET——零打断。放松日常 + 刚性高危。
- **文件审批的作用域**（2026-10-29）：`.focus-guard/approvals/` 那条链上，一条批准 = **一次 × 一个会话 × 30 分钟**。
  id 是 `sha256(工具+命令)` 前 12 位（改一个字符即失效）；消费端校验 `record.session`，**两侧都认得出身份且不一致即拒绝**
  （`dsh-native` / `unknown` / 空值是"我不知道你是谁"，不算身份，放行并在返回值里标 `loose`）；
  `approvedAt` 超过 `FG_APPROVAL_TTL_MS`（默认 30 分钟）作废，时间戳不可解析按过期处理（fail closed）。
  批准是对**这一次意图**的授权，不是对这条命令的长期豁免——只写 `pending` 时的"换会话刷新"不构成防线。

### 事前资格审核与司法救济（3.0.5 / 3.0.6 / 2026-10-18 增量）

高危命令闸管的是**事后拦截**（命中即拒，再交人类审批）。3.0.5 起在其之前加一道**事前资格审核**：高危工具**先申请、后执行**，无授权直接拒。

- **六层判定**（`packages/core/src/core/checkEligibility.mjs`，母版层、依赖注入、不反向依赖适配层）：

  | 层 | 判什么 |
  |---|---|
  | L0 | 申请完整性——`purpose` / `scope` 空白即拒 |
  | L1 | 状态——熔断 / 降权 / 预算耗尽 |
  | L2 | 绝对红线（命中即拒，且不进 L3） |
  | L3 | 高危资格——命中 `HIGH_RISK_TOOLS` 且本会话无授权 → 转人工审批 |
  | L4 | 前置条件——改动类目标须已取证；系统路径 / 特殊目录（`.git`、`node_modules`）加严 |
  | L5 | 语义信号——模型探针的 `mismatch` / 高风险分 |
  | L6 | 授权并留痕 |

- **双入口闭环**：`fg_apply`（申请 → 审核 → 按 session 授权）与 pre-execute 的 `gateToolCall`（无授权 → deny，理由指向 `fg_apply`）。审核期临时授权、未通过立即收回，避免申请通道被自己的 L3 挡死。
- **模型画像**：`src/profiles/` 五份纯参数画像（`deepseek-flash` / `deepseek-pro` / `glm` / `gpt-astra` / `default`），按画像跳层并把跳过项写入 trace 与审计。不传画像时与 3.0.4 行为一致。**画像不能关闭审批层**（`profileLoader.mjs` 的 `FORCED_ON_SWITCHES` 强制启用 `approvalGate`），也不能放行红线层；`approvalGate.scope` 只决定"哪些类别需审批"（`irreversible` 时非不可逆高危放行、不可逆类仍须审批）。
- **环境指纹与命令硬校验**：`packages/core/tools/env-fingerprint.mjs` 探测平台 / shell / 工具并产出 `.ai/env-fingerprint.json`；pipeline 第 1.5 层据其 `map` 表做命令硬校验（`grep`→`rg`、`find`→`fd` 等替代提示），不依赖模型自觉。
- **绝对红线上下文豁免**（3.0.6）：红线在**文本层**匹配，分不清"要执行的命令"与"被引用的命令字符串"。三条判据把后者**降级到第 2 层语义预判**（绝不直接放行）：① 命中片段完整落在引号字面量内；② 片段前有显式数据标记（`示例：`/`例如：`/`测试数据`/`prompt:`/`【假设】`/代码围栏）且命令非变更类；③ 首 token 属只读输出命令。**执行外壳一律不豁免**（`bash -c` / `cmd /c` / `eval` / `iex` / 解释器 `-e`·`-c`）——那些引号里的内容是真执行。豁免写 `AUDIT.log`（`action:"redline-exempt"` + 判据名 + 命中片段）。
- **误伤申辩（司法救济通道，3.0.6）**：`fg_appeal` 让被拦方能**当场申辩**，不必等修法。参数携带被拦命令原文，故 pipeline 在**所有闸之前**处理它（否则会被同一规则再拦一次），转成 `{kind:"ask"}` 交人类一次性裁决：批准 → 开通该工具一次授权（`ttl=turn`）+ 豁免本次命中红线；拒绝 → 维持拦截。全程留痕 `appeal-filed` / `appeal-granted` / `appeal-denied`。法条依据见 [RULES.md](../packages/core/docs/RULES.md) 第八十三条(四)。

### 子代理委派（v2.3.0：高产出、低污染）

| 机制 | 规则 | 机械化 |
|---|---|---|
| 委托池独立核算 | 默认 20 次/任务，不占执行池；用尽批示『追加额度』三池各 +10 | 每次委派记 `delegate-used`；用尽拒绝并请示 |
| 摘要强制格式 | 主会话只收【子代理摘要】四字段（任务/结果/异常/文件线索），≤200 字 | 超长或缺字段 → 拒收要求压缩（KPI-3） |
| 强制委派场景 | 全库搜索 ≥3 目录或 ≥10 文件 / 大文档 >50KB 或 >2000 行 / 批量 ≥5 文件 | 未委派 → 未尽职提醒（KPI-5）；已委派 +5 |
| 独立并行任务 | 两个任务互不依赖 | **自申明**：引擎无机械特征，不判罚也不加分，AI 不得据此声称"已尽职" |
| 合法委派边界 | 正常委派放行不计违规 | 仅熔断期启动子代理 = 越权绕行（L4+L5） |

### 正面指引（告诉 AI 怎么干活）

负面清单管下限，正面指引给标准动作（法条第十五章之一，74–79 条；运行时镜像 [packages/core/skills/focus-thinking/SKILL.md](../packages/core/skills/focus-thinking/SKILL.md) §10）：

| 树杈 | 标准动作 | 机械化 |
|---|---|---|
| 环境适配 | 环境不主动探测，行为暴露后自动适配；有 `.git` 用 `git restore`，没有用 `.ai/backup/` | 每次 Write/Edit 前自动备份到 `.ai/backup/`（保留最近 100 份；>200KB 跳过；`.env`/私钥不落明文副本） |
| 返工与提交 | 只回滚出错文件；重试带"失败包裹"（报错行号 + 堆栈尾 30 行 + 限定范围）；本地 commit 测试全绿 AI 可做 | **高危审批单**：`git push` 命中特征库须【高危申请】，`--dry-run` 例外 |
| 污染与日志 | 参数-输出矛盾 → 标记可疑；改文件前先出【污染核实】声明；超大日志只取统计 + 堆栈尾 30 行 | **污染核实闸**：污染检出后首个改动类先拦一次 |
| 任务编排 | 第一句话声明"通过条件"（可测 = 退出码 0；不可测 = 编译 + 不崩溃 + 《人类验收清单》）；机械任务优先内置库与既有预制脚本（`.ai/tools/`，存在则用） | 结案以机器退出码为准 |
| 人类交互 | 提交前固定一行：`【提交申请】修改:<文件> (+n,-m) \| 测试:n/n 绿 \| 允许提交？(y/n)`；仅不可逆操作请示 | 其余全自动 |
| 经验固化 | L2/L3 或回滚后往 `.ai/PATTERNS.md` 追加 `[环境:x] [任务:y] 以后遇到 X 必须先做 Y`；新任务不预读，卡点时 Grep 检索 | 熔断出口提示经验固化（触发熔断时引擎确保该文件存在） |

### 运行面与自证（2026-10-18 in-tree 增量，未 bump 版本）

这些是引擎里**已经在跑**的部分。版本以 `ENGINE_VERSION` 为准，代码即事实。

| 能力 | 落点 | 行为 |
|---|---|---|
| 心跳与存活确认 | `packages/core/src/dsh/heartbeat.mjs:85`、`status.mjs:73` | 每 10s 原子覆写 `.focus-guard/status.json`；外部 `node status.mjs` 判活，exit `0` 全绿 / `2` 缺模块 / `3` STALE / `4` 文件缺失 |
| 模块启动自检 | `heartbeat.mjs:45`（`markModule`） | 10 条执法缝 + 心跳各自报到；缺谁写进 `degraded`，宿主日志告警，模型侧收到 `focus-guard-degraded` 段 |
| L4 跨会话卷宗 | `workspace.mjs:38`（hash）、`:125`（回合落账）、`index.js:71`（注入段） | `workspace_hash = sha256(realpath(cwd))` 前 16 位；hash 不符零注入（改文件夹名即彻底屏蔽） |
| 整文件读取闸 | `guard/wholeFile.mjs:26`（口径）、`:70`（闸本体） | 目标 > 300 行且无 offset/limit → deny，提示改用 XERJ `search`/`def`；`FG_WHOLE_FILE_MAX_LINES` 可调 |
| Superpowers 动笔闸 | `guard/superpowers.mjs:34`（判据 `:21`） | 模糊开发任务（开发动词+模糊标记+无验收词）首次动笔 deny 一次，要求先加载 `brainstorming`/`writing-plans`；同条重试与已加载均放行 |
| 风险启发式分级 | `guard/risk.mjs:37`（`destructiveApiWeight`） | 破坏性 API 按目标给权：系统路径/递归 0.9（必拦）、TEMP 0.2、其他 0.4；重定向 0.15 |
| 压缩监察 | `packages/core/src/dsh/compactionWatch.mjs:239`、`:364` | 只观察 `compaction/start|end|prune` 与 `agent/request-error` 撞窗并留痕（`action=compaction*`），**不写 surface、不 cancel 回合**——压缩归 DSH 内置栈 |
| 审计拦截理由 | `packages/core/src/dsh/audit.mjs:120` | `auditDeny(exec, cmd, {trigger, level})`：`redline:<name>` / `env-substitute` / `gate:fg_apply` / `evidence-gate` / `whole-file:lines` / `risk:<category>` 等，不再是清一色 `high-risk-rm` |
| 执行体判定 | `packages/core/src/core/env.mjs:18`、`index.js:31` | 母版认 `FG_SHELL` 显式覆盖；DSH 适配层声明执行体为 `powershell`，与卷宗【一】/指纹不再互相矛盾 |
| 审计零增长守卫 | `packages/core/tests/audit-isolation.mjs:1` | 跑测前拍真实 `AUDIT.log` 快照，跑完有增长即 exit 1（已双向验证：干净 Δ0 PASS、故意污染 Δ1 FAIL） |

## 配置

所有阈值集中在 `packages/core/src/core/constants.mjs`（`hooks/guard.mjs` 已封存，不再新增常量）：

| 常量 | 默认 | 说明 |
|---|---|---|
| `OUTPUT_GATE_BYTES` | 50KB | 体积刺客闸值（整读/刷屏拦截线） |
| `BUDGET_DEFAULT` | 10 | 默认任务预算 |
| `BUDGET_CAP` | 200 | 有效调用硬上限 |
| `REFILL` | 10 | 续杯步长 |
| `STALL_FUSE` | 5 | 连续无效调用熔断线（3 → 5；闸门拒绝不计入） |
| `MERCY_SHORT` | 30 | 特赦短语仅认短指令的长度上限 |
| `RANDOM_AUDIT_EVERY` | 5 | 每 N 次写操作全量审计 1 次（确定性节拍） |
| `INV_POOL_DEFAULT` | 15 | 侦查池独立额度 |
| `DELEGATE_DEFAULT` | 20 | 委托池默认额度（不占执行池） |
| `SHA_LIMIT` | 200KB | 卷宗 SHA-256 校验上限（超过则用 mtime+size+git 脏态） |
| `CASE_MAX_ROWS` | 200 | 卷宗【三】最大行数（超出淘汰最旧） |
| `BACKUP_KEEP` | 100 | `.ai/backup/` 最大保留份数 |
| `TTL_FIRST/RECENT/WEEK/STABLE` | 4h / 2h / 24h / 7天 | 卷宗自适应 TTL 四级 |
| `ENGINE_VERSION` | 3.2.1 | 42条部署版本核验基准。**版本面 = 七处清单 + 两个常量 + CHANGELOG 最新段**（七处：根 `package.json` / 根 `marketplace.json` / `.zcode-plugin/plugin.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` / `packages/core/package.json` / `packages/extended/package.json`；两个常量：本项与 `PIPELINE_VERSION`），由断言锁定"彼此相等 **且** 等于 CHANGELOG 最新条目"。引擎头注释例外：`guard.mjs` 已封存、版本号独立，断言只锁"封存标注存在" |

### 环境变量（34 个）

`FG_*` 共 34 个，分三类：**19 个用户该知道**（开关与阈值）、**7 个仅测试注入**（路径与运行时标记）、**8 个内部**（性能与探针）。下文未列出的 `FG_*` 不存在。锚点相对 `packages/core/src/`。

**闸门开关（8 个）** —— 「生产可关」一列写明这道闸能不能被关掉：

| 变量 | 默认 | 设为 | 效果 | 生产可关 | 锚点 |
|---|---|---|---|---|---|
| `FG_EVIDENCE_GATE` | 开 | `0` | 关取证闸：改文件不再要求先读 | **否** | `dsh/guard/evidence.mjs:34` |
| `FG_VALUE_GATE` | 开 | `0` | 关改动面闸：新建敏感文件/加生产依赖不再要求回三行 | **否** | `dsh/guard/authz.mjs:70` |
| `FG_RANDOM_FUSE` | 开 | `0` | 关反规避抽查B（随机间隔 2–5 次写操作） | **否** | `dsh/postProgress.mjs:82` |
| `FG_RESULT_ADMIT_BUDGET` | 3 | `0` | 关结果准入闸：大结果整读不再限额 | **否** | `dsh/guard/volume.mjs:23` |
| `FG_MUTATION_UNMAPPED` | 拒 | `allow` | 放行「无可解析路径的改动类工具」（默认拒，防绕道） | 是（旁路） | `dsh/guard/evidence.mjs:269` |
| `FG_RANDOM_FUSE_EVERY` | 随机 | `N` | 抽查B 固定间隔 N 次（优先级高于随机） | 是（调参） | `dsh/postProgress.mjs:83` |
| `FG_RANDOM_FUSE_BLOCK` | 留痕 | `1` | 抽查B 命中即阻断（默认只留痕不拦） | 是（加严） | `dsh/guard/evidence.mjs:218` |
| `FG_BLAST_REPORT` | 6 | `0` | 关改动面收尾报告（单轮改动 ≥N 个文件时记账） | 是（关报告） | `dsh/seams.mjs:77` |

> **「生产可关=否」的实现**（2026-10-29 立法：不允许关闭任何功能）：这四个走 `src/dsh/testRuntime.mjs` 的 `gateSwitch` / `gateThreshold`，
> 只在测试运行时读变量，生产环境恒返「开」——不是设了无效，是代码里没有那个分支。
> 判据是 `NODE_TEST_CONTEXT`（`node --test` 自动注入，用户伪造不了）或显式 `FG_TEST_MODE=1`，
> **不用 `NODE_ENV=test`**：本仓测试跑法不设它（实测 `undefined`），用它等于把关闭权交给谁都能设的普通变量。
> 测试仍能关（`random-fuse` / `result-admit` / `production-gates` 三处依赖这一点），立法与可测性两边都不用让步。

**阈值（4 个）**：

| 变量 | 默认 | 说明 | 锚点 |
|---|---|---|---|
| `FG_AUDIT_MAX_BYTES` | 5 MB | AUDIT.log 体积上限，超出滚动归档（≈2 万条记录） | `core/audit-writer.mjs:26` |
| `FG_AUDIT_ARCHIVE_KEEP` | 10 | 归档保留份数，超出删最旧 | `core/audit-writer.mjs:29` |
| `FG_RESULT_ADMIT_BYTES` | 32 KB | 「大结果」起算线，超此值的整读每次扣 1 点额度 | `dsh/guard/volume.mjs:21` |
| `FG_WHOLE_FILE_MAX_LINES` | 300 | 整读闸行数阈值，超此值且无 offset/limit 即拒 | `dsh/guard/wholeFile.mjs:19` |

**环境适配（3 个）**：

| 变量 | 默认 | 说明 | 锚点 |
|---|---|---|---|
| `FG_SHELL` | 自动探测 | 显式指定执行体（`powershell` / `bash`），母版层用 | `core/env.mjs:17` |
| `FG_SEARCH_TOOL` | 自动探测 | 强制指定检索后端，跳过 PATH 探测 | `dsh/search-hints.mjs:90` |
| `FG_SEARCH_BIN_DIR` | — | 检索工具额外搜索目录（PATH 之外） | `dsh/search-hints.mjs:39` |

**PTC 模式（4 个）** —— 语义见上文「事前资格审核与司法救济」：

| 变量 | 默认 | 设为 | 效果 | 锚点 |
|---|---|---|---|---|
| `FG_PTC_READONLY` | 关 | `1` | 默认只读：写类工具与变更型 shell 一律先申请 | `adapters/dsh/eligibility-gate.mjs:47` |
| `FG_PTC_AUTO_GRANT` | 关 | `1` | 可逆类别静默秒批，不可逆类别仍走人工 | `adapters/dsh/eligibility-gate.mjs:51` |
| `FG_PTC_ALLOW_RM_RF` | 关 | `1` | 允许 `rm -rf` 自证自批（应急用，审计留痕） | `adapters/dsh/eligibility-gate.mjs:65` |
| `FG_PTC_STRICT_ALL` | 关 | `1` | 全部不可逆类别纳入人工闸（默认只抓 rm-rf） | `adapters/dsh/eligibility-gate.mjs:68` |

**仅测试注入（7 个）** —— 生产环境设了会改变落盘位置（等于把留痕写丢），或改变运行时判定：

| 变量 | 用途 |
|---|---|
| `FG_TEST_MODE` | `1` = 声明「测试运行时」，给不走 `node --test` 的夹具用；生产设了会重新打开四个关闭型开关 |
| `FG_APPROVAL_DIR` | 覆盖审批单目录（默认 `.focus-guard/approvals`） |
| `FG_APPROVAL_TTL_MS` | 批准有效期（毫秒，默认 `1800000` = 30 分钟）；过期批准消费时作废并清掉 |
| `FG_AUDIT_FILE` | 覆盖 AUDIT.log 路径 |
| `FG_CASE_FILE` | 覆盖卷宗【三】/【四】路径（默认 `.ai/CASE_FILE.md`） |
| `FG_STATUS_FILE` | 覆盖会话状态文件（默认 %TEMP%） |
| `FG_WORKSPACE_FILE` | 覆盖 workspace 声明文件 |
| `FG_PYTHON` | 哨兵调用的 Python 可执行文件（默认 `python`） |

**内部（8 个）** —— 性能与探针，正常使用不需要动：

| 变量 | 默认 | 用途 |
|---|---|---|
| `FG_APPROVAL_SEAM` | — | 仅 `cli` 值生效：命令行审批接缝 |
| `FG_PROJECT_DIR` | 宿主 cwd | 项目目录提供者 |
| `FG_RUN_ID` | — | 审计行的 `run` 字段 |
| `FG_MODEL_ID` | 宿主声明 | 模型标识（工具清单判定用） |
| `FG_HEARTBEAT_INTERVAL_MS` | 10 s | 心跳写盘间隔 |
| `FG_STALE_AFTER_MS` | 30 s | 心跳陈旧判定线 |
| `FG_SENTINEL_CACHE` | 开 | `0` 关哨兵缓存 |
| `FG_SENTINEL_CACHE_SIZE` | 500 | 哨兵缓存条目上限 |

> **登记纪律**：新增 `FG_*` 必须同时改本节。未登记 = 用户不知道它存在 = 这个开关等于没做。
> 2026-10-29 盘点补录 8 个此前零文档的开关：`FG_EVIDENCE_GATE`、`FG_VALUE_GATE`、`FG_MUTATION_UNMAPPED`、`FG_AUDIT_MAX_BYTES`、`FG_AUDIT_ARCHIVE_KEEP`、`FG_BLAST_REPORT`、`FG_RESULT_ADMIT_BUDGET`、`FG_RESULT_ADMIT_BYTES`。

## 工作原理

```
SessionStart       → 环境检测一次 + 卷宗载入（重建取证缓存与 TTL 表）+ 注入执法模型
UserPromptSubmit   → 批示识别（关键词预算 / 信用延期 / 特赦 / 追加额度 / y-n）+ 重置任务态（保留侦查缓存）+ shell 变化重检 + 任务链起新链
PreToolUse         → 平台命令拦截 + 本地哨兵（opt-in）+ 图书馆直写拦截 + 高危审批闸 + 熔断白名单 + 未取证拦截 + 污染核实闸 + 体积三闸 + 盲写拦截 + 卷宗免重读 + 改动前备份
PostToolUse        → 进度检测引擎（三池 / 续杯 / 停滞熔断）+ 卷宗取证记录 + 污染检测 + 抽查 + 委派 KPI 计分
PostToolUseFailure → 失败计入停滞
Stop               → 回合边界 + 证据锚点检查 + 授权识别核验 + 审批单格式校验 + KPI 兑现结算 + 额度台账落卷
```

拦截协议：PreToolUse 以**退出码 2** 拒绝工具调用（原因走 stderr，原文透传给模型）；Stop / PostToolUse 返回 `{"decision":"block","reason":...}` 打回重写。所有打回路径都有一次性保护（`stopBlocked` + 宿主的 `stop_hook_active`），不会因强制续跑变成死循环。

DSH 原生插件（`src/dsh/pipeline.mjs` 编排，各层实现在 `src/dsh/guard/`）在**同一条 PreToolUse 缝**上按序叠加（各段独立 fail-open，异常一律放行或原样透传）：

```
申辩入口(fg_appeal) → 第3层状态/取证校验 → 绝对红线(+上下文豁免/申辩凭据) → 第1.3层动笔闸
→ 第1.4层整读闸 → 第1.5层命令硬校验 → 资格审核闸(fg_apply) → 改动面闸
→ 体积刺客三闸(Read/Grep/cat) → 污染核实闸 → 第2层语义预判(哨兵) → next
```

- **第 3 层取证校验**只对**已存在文件**的修改要求先读；**新建文件**无目标可读，直接放行（否则死锁）；
- **L3 不接红线上下文豁免**（闸接、L3 不接）：闸是"无授权即 deny"、无人类环节，必须自判豁免；L3 是"转人工审批"、人类环节本身就是裁决。若 L3 也豁免，"数据形态的高危命令"会无人审批直接放行——风险不对称。判定写在 `checkEligibility.mjs` 第 3 层注释里，防后人当缺陷改回。

留痕协议：AUDIT.log（JSONL）每条带 `seq`（事件唯一号）/ `chain`（任务链，委派派生 `/dN` 子链）/ `ref`（父事件）三字段——流水账可随时重组为因果树：`node packages/core/tools/audit-chain.mjs <AUDIT.log> [--mermaid]`。

**行构造只有一处**：`core/audit-writer.mjs::buildAuditRow()`。七字段（时间/会话/动作/触发条件/级别/证据/是否特赦）与因果链三字段由它统一生成，`seq` 用进程内单调计数（不用 `performance.now()`——同毫秒连写会撞号）；`appendAudit()` 落盘前还有一道 `normalizeRow()` 兜底，绕开构造点直传裸行也会补齐七字段。**别在调用点再手写行对象**：2026-10-29 之前有 5 处各写一份，字段集各不相同，实测日志里漂出三种形态、17 组 seq 重复。体检命令 `node packages/core/tools/log-audit.mjs` 末尾的「行契约体检」段会报缺字段与撞号。

落盘全图（写入面共 9 处）：AUDIT.log、卷宗【一】环境声明、【三】侦查记录、【四】额度台账（同 CASE_FILE.md）、会话状态（%TEMP%）、改动前备份（.ai/backup/）、PATTERNS.md 经验库、TEMP 陈旧清扫、派生积木与索引（仅 library-build 写到 .ai/output/library/）。

**内存态（不落盘）**：`packages/core/src/core/sessionScratch.mjs` 统一托管「按会话分表的进程内临时数据」——
`nativeReadSet` / `evidenceBlockedOnce`（本会话读过的路径、已拒过一次的路径）、`remindedNoBackend`（已提醒过没装检索工具）。
两种形态：`sessionSet(name)` 给每会话一个 `Set<T>`，`sessionFlag(name)` 给一个「已做过」标记。
三件事必须做到：**按会话隔离**（DSH 单进程多会话，共享会让 A 读过的文件被判成 B 也读过）、
**能一键清空**（`clearSession(sid)` —— 测试与基准靠它把状态摆回已知起点）、
**有上限**（每表最多 200 个会话，超出按插入序删最旧，长驻进程不无限涨）。
新增会话级内存态一律走这里，不要再各模块 `new Map()`——那样等于又造一个清不掉、测不了的表。

### 常驻注入的体量

常驻注入 `SESSION_RULES` 运行期实测 **425 字**（246 全角 + 179 半角，≤500 字立法上限；3.0.0 因果链提示 +14 字）。典型长会话的执法可见开销加权实测 **3425 字 ≈ 2283 tokens**（2026-10-22 复测，`npm run bench`；3.0 新增报文：推送闸 182 字级、哨兵拦截 175 字级、图书馆隔离 40 字级、KPI 结算 0 字——仅落档不打扰）：

| 场景 | 引擎实测字符 | 会话内次数 | 加权 |
|---|---|---|---|
| SessionStart 常驻注入 | 545 ⚠ | ×1 | 545 |
| 卷宗免重读放行（最高频） | 145 / 次 | ×10 | 1450 |
| 触发③体积三闸（三连拦场景合计） | 278 | ×1 | 278 |
| 熔断出口（拒绝 + 打回） | 268 | ×1 | 268 |
| 动态预算续杯 | 73 / 次 | ×3 | 219 |
| 推送闸拦截 | 182 | ×1 | 182 |
| 强制场景未委派提醒 | 131 | ×1 | 131 |
| 触发①未取证就改 | 56 / 次 | ×2 | 112 |
| 委派摘要超长拒收 | 107 | ×1 | 107 |
| 上下文污染检出 | 93 | ×1 | 93 |
| 盲写拦截 | 40 | ×1 | 40 |
| **加权合计** | | | **3425 字 ≈ 2283 tokens**（1 token ≈ 1.5 中文字符，区间 1713–2854） |

⚠ **545 里约 89 字是假警报**：`hooks/guard.mjs` 头部自述「v3.0.4 已封存·版本独立，不随 FG 主版本更新」，但 `guard.mjs:136` 仍拿它比对 `ENGINE_VERSION`，故每次会话追加一条版本核验告警。`seams.mjs` 已于 10-18 用 `SEALED` 排除修掉，**ZCode 侧未修**。干净状态应为 425 + 45（HANDOFF 巡视）≈ **470 字**，加权合计约 **3336**。上表按实测原值记录，不掩盖。

复测：`npm run bench`。v2.2.0 曾对报文做电报体压缩（当时相对更早版本 -31.6%，对比基线已失效，只作历史记录）；2.4.0 起审批单与委派报文变长，故当前总量高于那次优化后的数值。报文只保留"标签 + 动作指令"，规则细节由技能与法典承载。

### 前缀稳定性（2026-10-29）

缓存命中要求**前缀逐字节相同**；前缀一变，后面整段会话历史都要按未缓存价重付。所以注入内容要分两类：**不变量**可以进前缀，**历史**不进。

- **实测**（`npm run prefix:drift`，读真实会话落盘）：四个会话里工具表（56,486 字）与首条 user 段**全程 1 个版本**；系统段 **2 个版本**，分歧点恒定落在 `[FG-WORKSPACE]` 的「决策：」那一行——FG 自己往系统提示里塞了历史，而历史每回合都在长。
- **规则**：决策行只在**换会话**时注入（那是交接信息）；约束（人类否决过的命令）实时保留——它只在真被否决时变，且是安全信息。
- **常态机制**：每次装配算一次 FG 段指纹，同一会话内变了就写一条 `prompt-prefix-shift` 审计（带段名与字节差）。抖动因此可查，不靠人记得。
- **边界**：只看 `focus-guard-*` 段。宿主的工具表 / 系统提示 / 技能目录不归 FG 管，变了这里不报——不替宿主背锅，也不假装能测。
- **取证**：`npm run prefix:drift --strict`——工具表与首条 user 段多版本即 exit 1；系统段默认只报（熔断告知与换会话交接会合法地变一次），要看严加 `--fail-on-system`。它是探针不是闸门：输入是本机会话落盘，CI 上无从复现。

## 测试与质量闸

```bash
npm test                                             # 全量验收（用例数随版本增长，以实际输出为准）
npm run test:eligibility                             # 资格审核（六层 + 红线豁免 + 申辩）
node --test packages/core/tests/integration.test.mjs  # 端到端（画像→审核→授权→闸→取证闸）
node --test packages/core/tests/profile.test.mjs      # 画像加载
npm run eval                                         # 对抗评测：61 条高危写法 + 34 条良性命令，有漏检或误报即 exit 1
npm run bench                                        # 报文体量基准
npm run bench:decision                               # 判定基准：14 用例×10 轮 → 准确率/误伤率/p50-p95（基线锁定）
npm run bench:tasks                                  # 任务测试：50 组真实任务串 → 组通过率/误伤/漏拦
npm run bench:cost                                   # 成本基准：读台账【五】与 AUDIT.log → token/USD/拦截/误伤比
npm run check                                        # 全链：测试 + eval + selftest + 文档/房规/结构闸（pre-push 跑的就是它）
npm run library                                      # 派生积木构建（默认 --src .ai/library --out .ai/output/library，幂等）
npm run chain -- <AUDIT.log路径> [--mermaid]         # 执法档案因果树渲染
npm run sentinel -- --check "<命令>"                  # 本地哨兵单条预判
npm run focusguard -- pending                        # 查看待批请求（rm-rf 人工闸门）
npm run focusguard -- approve <id>                   # 人类在终端批准该次不可逆操作（一次性）
npm run focusguard -- list                           # 已批准未消费的请求
npm run test:bridges                                 # 扩展包桥测试（单独跑）
```

### 双包架构：范本 + 衍生

本仓是 npm monorepo，**一个项目、两个包**：

| 包 | 路径 | 定位 |
|---|---|---|
| **`focus-guard`** | `packages/core/` | **零依赖范本**——引擎钩子、技能、核心工具、法条文档、**DSH 原生插件**。`npm install focus-guard` 只下载本包，不拉任何外接依赖。主分支即从此包发版，可衍生无数变体。**DSH 挂载的正是这个包**——它的 `package.json` 版本就是 GUI 里显示的那个。 |
| **`focus-guard-extended`** | `packages/extended/` | **扩展衍生包**——依赖 core（版本随主版本），承载重型外接三件套：OpenViking 积木同步桥（`viking-bridge.mjs`）、Needle 2 外判运行器（`needle2-sentinel.mjs`）、Semantica LPG 图谱导出（`audit-chain-semantica.mjs`）。 |

衍生纪律（详见 [packages/extended/bridges/README.md](../packages/extended/bridges/README.md)）：桥只依赖主分支**契约**（审计 JSONL 格式、哨兵外判协议、积木 INDEX 格式），禁止 import 主分支源码，禁止被主分支引用（验收用例锁定零反向依赖）；桥故障一律静默回退核心默认行为。新增外接 = 在 extended 包加一个自包含文件 + 一条桥测试。

- **CI**：每次推送/PR 自动跑验收 + 对抗评测（[.github/workflows/ci.yml](../.github/workflows/ci.yml)）。Windows 必过；Linux/macOS 为观察项（验收里仍有数处 Windows shell 检测用例未平台化），Node 18.20 / 20 / 22 矩阵；
- **本地质量闸（pre-push 钩子，GitHub Actions 不可用环境的主闸）**：`.githooks/pre-push` 在每次 `git push` 前强制 `npm run check`（验收 + 对抗评测），不过即阻止推送，结果留痕 AUDIT.log（`ci-pre-push` 事件）。克隆后启用一次：`git config core.hooksPath .githooks`；强行绕过（`--no-verify`）按法规须先批示——钩子留痕只在正常触发时写入，绕过即失察；
- **覆盖范围**（用例数随版本增长，以 `npm run check` 实际输出为准）：动态预算与三池分池、进度检测与信用延期、触发①②③④⑤（含审计豁免）、梯度处罚与熔断只读放行、卷宗体系（环境检测 / 环境声明落卷 / 免重读含会话内限定 / SHA 防伪 / TTL 三级覆盖 / 台账落卷 / caseCache 裁剪）、跨平台命令拦截、盲写与抽查A、上下文污染与污染核实闸（含复合命令不误报）、授权识别（伪造引文 → L3 / 合规声明 → 特赦 / 待确认 → 暂停）、高危命令闸（特征库 / 审批单 / y-n 一次性 / 预授权隔离 / 脚本包装端到端 / 熔断期拒绝 / 超长命令）、子代理委派与委托池、极限场景（80KB 命令行、2MB 响应、损坏状态、奇异会话 ID、中文路径）、DSH 桥接自适应，以及工程自检（七处清单版本一致性 / 版本追赶 / 五处说明互不重复 / 文档-实现口径对齐 / RULES 注入逐字镜像 / hooks.json ↔ 引擎映射 / 部署漂移核验 / 61条陈旧清理）；
- **对抗评测样本**按"同一危险动作的多种写法"组织（别名、长旗标、传参穿插）并配良性反例，避免用误报换检出。

## 设计取舍与已知边界

- **回合边界双保险**：实测 `UserPromptSubmit` 不保证触发，回合计数由可靠的 `Stop` 事件兜底清零，`reset` 仅作尽力而为的提前重置；
- **钩子读取的是安装副本**：改源码不会自动生效，需同步安装缓存或经市场更新——"源码已升级但引擎没变"是这套系统最常见的部署事故，[INSTALL.md](../INSTALL.md) FAQ 4 有排查步骤；
- **平台受限暂缓条款**：第 21 条 Token 成本核算、第 37 条思考链监管（钩子层不可见 token 用量与思考时长）、第 64 条(二)(三)(四)限流（无对应信号）；第 48 条子代理继承以留痕方式实现。**完整"未机械化条款清单"见 [packages/core/docs/RULES.md](../packages/core/docs/RULES.md) 附注**——凡清单所列，AI 不得声称已由引擎自动执行；
- **>200KB 文件没有内容级防伪**：见上文卷宗体系边界说明；
- **引号内的危险字样：按上下文分级**（3.0.6）——`echo "git push"`、`grep -rn "delete from users"` 这类**被引用的数据**经三条判据（引号内 / 数据标记 / 只读命令）降级到语义预判，不再直接拒；**执行外壳内的一律不豁免**（`bash -c "…"`、`node -e "…"`、`eval "…"`），因为那是真执行。仍未覆盖的形态：无引号又无数据标记的裸引用、`rm${IFS}-rf` 类拼接。判据名与命中片段写入 `AUDIT.log` 可复核；
- **特征库不可能堵完**：`rm${IFS}-rf`、base64 管道、shell 别名等在射程之外，护栏治的是"顺手失控"，不是定向对抗；
- **免重读的边界**：指纹一致但会话上下文已被压缩时，用 `offset` 增量读或请批示；【二】依赖声明与【三】TTL 列人工标注可按需放宽/收紧；
- **行业对照（2026-10 系统提示词研究，详见 `docs/analysis/`）**：各大厂商把 Agent 持久性推到极致（"persist until complete"）且提示词层无一设预算机制。FocusGuard 的定位由此清晰：坚持性交给模型自判（厂商已做好），**成本台账与破坏性关卡由宿主侧硬约束承担**——熔断随模型进化从常开保险丝退为断路器，但断路器不拆；
- **违禁词扫描已废弃**（v3.0 起"不查词"）：空气层允许口语与主观语气，执法只看行为。

