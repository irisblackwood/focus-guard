# 司会 Keepward 安装指南（v3.5.3）

> **状态**：权威 · 适用版本 3.5.3 · 最后核对 2026-11-22

前置要求：Node.js ≥ 18.17（引擎零依赖，仅用内置模块；与 `package.json` 的 `engines` 一致）。逐行验证：

```bat
node -v
```

**双平台说明**：本仓库同时支持两套宿主，清单各自独立，不要混用——

| 平台 | 插件结构 | 拦截语义 | 安装方式 |
|---|---|---|---|
| **ZCode** | `.zcode-plugin/plugin.json` + `packages/core/hooks/hooks.json` | PreToolUse 退出码 2 / `decision:block` **硬拦截** | 插件市场（市场源刷新 + UI 更新） |
| **DSH·原生插件**（推荐，3.0.5 起） | `packages/core/` 的 `dsh` 字段 + `src/dsh/` 的宿主事件 | **8 个宿主事件 / 十余条监听**（以 `src/dsh/index.js` 的 register 调用为准）：`tools/pre-execute` 拦截判定（资格审核 + `fg_apply`/`fg_appeal` + 模型画像 + 命令硬校验 + 红线豁免）、`system-prompt/assemble` 注入、`tools/post-execute` 成本与进度、`agent/pre-step` turn/step 留痕、`agent/turn-stopping` 熔断结算、`agent/request-error` 撞窗告警、`session/event` 压缩监察 | `dsh plugin --profile <name> add focus-guard`（三种写法见 §2A） |
| **DSH·官方桥** | 桥 `@deepseek-ai/dsh-hooks-claude-code` 挂载 `packages/core/hooks/hooks.json`（Claude 方言） | **同等硬拦截**：exit 2 阻断工具/提示、`ask` 原生审批、stderr 原文透传给模型、Stop 打回强制续步。但**不含**原生插件独有的资格审核与申辩 | profile 的 `cordis.patch.yml` 挂桥（见下文逐行步骤） |

注意 **DSH 的两条路互斥**——原生插件与官方桥监听同一条 pre-execute 缝，**同时挂载即双跑**。二选一。

### 官方桥的前置、版本对应与责任边界

**官方桥 `@deepseek-ai/dsh-hooks-claude-code` 由官方仓库维护**；本仓库只提供**适配层**
（`packages/core/hooks/hooks.json` 与 `packages/core/src/dsh/` 的事件映射），不包含桥本体。

**安装顺序（走官方桥时）**：先装/确认官方桥，再装本包——

```bat
:: 1) 先确认桥在（版本号要能打印出来）
npm ls -g @deepseek-ai/dsh-hooks-claude-code
::    部分 DSH 发行版把桥打在应用内，无需单独安装；以官方仓库说明为准
:: 2) 桥就位后再挂本仓库的 hooks.json（步骤见 §2B）
```

**版本对应关系**（适配层只支持已验证区间，区间外会在会话启动时报警）：

| 适配层 | 官方桥已验证区间 | 说明 |
|---|---|---|
| 3.5.x | `>=0.2.1-rc.1 <0.3.0` | 实测通过：`0.2.1-rc.1`、`0.2.2-rc.5` |

桥升级后事件契约/载荷可能变化，**适配层可能必须跟着更新**；反之，把适配层降级到旧桥也可能不匹配。
不匹配时启动日志会出现 `bridge-incompatible` 告警，内含两条命令：

```
升级：npm i -g @deepseek-ai/dsh-hooks-claude-code@latest   （或升级 DSH 到自带匹配桥的版本）
回退：npm i -g @deepseek-ai/dsh-hooks-claude-code@0.2.2-rc.5（或回退 DSH）
```

**责任边界（重要）**：

- **桥层面的 issue（功能缺失、崩溃、事件不触发）→ 上报官方仓库**，不计入本仓库。
- 本仓库 README 只描述**适配层行为与兼容矩阵**；功能残缺请先到官方桥仓库反馈。
- 本仓库只处理**适配层自身的缺陷**（如事件映射错、载荷解析错）与**兼容问题**（版本区间、升级适配）。

版本必须全链一致（**10 处版本面** = 8 个清单 + `ENGINE_VERSION` + CHANGELOG 最新段）：根 `package.json`、根 `package-lock.json`、根 `marketplace.json`、`.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`packages/core/package.json`、`packages/extended/package.json` 的 `version`，`packages/core/src/core/constants.mjs` 的 `ENGINE_VERSION`，以及 `CHANGELOG.md` 最新段标题——由断言锁定"彼此相等 **且** 等于 CHANGELOG 最新条目"。一键核对：`node packages/core/tools/version.mjs`（不一致 exit 1）。引擎头注释例外：`packages/core/hooks/guard.mjs` **已封存**、版本号独立，断言只锁"封存标注存在"。

## 一、ZCode 安装（逐行可复制）

```bat
:: 1) 取得源码（二选一）
git clone https://github.com/irisblackwood/focus-guard.git
:: 或：下载 zip 后解压，得到含 marketplace.json 的目录

:: 2) 验证市场清单位置（必须在仓库根目录，不是子目录）
cd /d <仓库目录>
dir /b marketplace.json
```

```text
3) ZCode → 设置 → 插件 → 插件市场 → 添加 → 选择上一步验证过的目录（含 marketplace.json 的文件夹）
4) 插件列表 → FocusGuard 聚焦护栏 → 安装
5) 新开一个会话
```

验证生效：新会话开头出现 `<focus-guard v3.0：日常零打扰，只看行为>【硬线】①未取证不改进` 的注入即为生效（该字符串逐字取自引擎 `SESSION_RULES` 开头，完整镜像见 `packages/core/docs/RULES.md` 第四部分；2026-10-24 起常驻文本已按"按需注入"压缩到 222 字，完整条文见同文件第一部分法条正文）；工作区出现 `.ai/CASE_FILE.md` 与 `.focus-guard/AUDIT.log` 即为卷宗与留痕就绪。

> **`.focus-guard/` 请加进你自己仓库的忽略规则**（2026-11-26）
>
> 这个目录会落本机的会话留痕、卷宗与审批记录——其中 `workspace.json` 含历史 prompt 片段
> （决策自动落账已于 2026-11-26 下架，但存量原文仍在文件里）。它属于私有面，不该入库。
>
> ```bash
> echo ".focus-guard/" >> .git/info/exclude   # 本地私有，不进版本库
> ```
>
> **不建议写进 `.gitignore`**：那等于向外界宣告"这里有私有数据"（分类暴露，内容虽看不到）。
> 本仓自己的 `privacy:gate` 断言 C 会因此直接判红。代价是 exclude 不随 clone 走——换机器要重装。
> 存量清理：`fg case rm <序号>` 逐条删，或直接删 `.focus-guard/workspace.json`（会自动重建）。

源码目录内跑质量闸（用例数随版本增长，以实际输出为准；仓库已带 CI，推送即自动跑）：

```bat
cd /d <仓库目录>
npm test         :: 全量测试（= npm run test:all；2026-11-08 起不再只跑 acceptance 一个文件）
npm run eval     :: 对抗评测：61 条高危写法 + 34 条良性命令，有漏检或误报即失败
npm run check    :: 整条闸（= check:inner，外面再套 audit-isolation）：test:all + eval + eval:dsh
                 :: + selftest + bridges + gate:fast（十一条静态闸）+ gate:slow（真装一遍）
npm run gate:fast :: 只跑静态闸（约 5s，pre-commit 跑的就是它；不联网）
npm run gate:slow :: 真装：npm pack + dsh plugin add（发布前/check 才跑，需 dsh 与网络）
```

## 二、DSH 安装（逐行可复制）

DSH 有**两条路，二选一、互斥**——两条都监听同一条 pre-execute 缝，**同时挂载即双跑**。

| 路径 | 拿到什么 |
|---|---|
| **A. 原生插件**（推荐，3.0.5 起） | `src/dsh/` 的 **8 个宿主事件 / 十余条监听**：`tools/pre-execute` 拦截判定（资格审核 `fg_apply` + 误伤申辩 `fg_appeal` + 模型画像 + 环境指纹命令硬校验 + 绝对红线上下文豁免）、`system-prompt/assemble` 规则与成本注入、`tools/post-execute` 成本与进度、`agent/pre-step` turn/step 留痕、`agent/turn-stopping` 熔断浪费结算、`agent/request-error` 撞窗告警、`session/event` 压缩监察（只读） |
| **B. 官方桥**（2.5.0 起） | Claude 方言六条钩子的**同级硬拦截**（exit 2 / `ask` 审批 / stderr 原文透传 / Stop 打回），但**不含** A 独有的资格审核与申辩 |

### 2A. 原生插件（推荐）

```text
1) 装（三选一，<name> 换成你的 profile 名，如 web / desktop）

   ① 普通用户：从 npm 装。最短，带 provenance 签名，版本 = 最近一次发版
      dsh plugin --profile <name> add focus-guard

   ② 跟仓库 main 上的未发布改动（monorepo，必须指到 packages/core）
      dsh plugin --profile <name> add github:irisblackwood/focus-guard#path:/packages/core

   ③ 改这个仓库：本地目录
      dsh plugin --profile <name> add E:\focus-guard-main\packages\core

2) 重启 DSH 会话生效。
```

要点：

1. **三种写法装的是同一个包，差别只在版本来源**：npm = 最近一次发版（当前 3.5.2）；
   `github:` = `main` 最新（可能领先已发布版本）；本地目录 = 你手上这份。
   `dsh plugin` 是 pnpm 的包装，`add` 后面就是 pnpm spec，所以裸包名天然合法。
2. **② 为什么必须带 `#path:/packages/core`**：本仓是 monorepo，仓库根的 `package.json` 不是插件包，
   插件在 `packages/core`。不指子目录会装到空壳。① 和 ③ 不需要，因为它们的入口本来就是包。
3. **装的是 `packages/core` 目录本身**（含 `package.json` 的那一层），不是仓库根、也不是 `hooks/`。它同时也是 DSH GUI 里显示的版本来源。
4. bundle 补丁由 `packages/core/package.json` 的 `dsh.bundle.patch` 指向 `src/dsh/cordis.patch.yml`，安装时自动生效，无需手工编辑 `cordis.patch.yml`。
5. **开发态可用 Junction link 挂载**：把 `packages/core` 链到 `<profile>\node_modules\focus-guard`，改代码**实时生效**；但**插件元数据（版本号等）需重启 DSH 才重读**。
6. 与 B 互斥——若 profile 的 `cordis.patch.yml` 里已有 `dsh-hooks-claude-code` 条目，**先删掉再装 A**。

### 2B. 官方桥（Claude 方言）

机制：DSH 官方桥 `@deepseek-ai/dsh-hooks-claude-code`（**由官方仓库维护**；部分发行版打在应用内、部分需单独安装，以官方说明为准）直接运行本仓库的 Claude 方言 `packages/core/hooks/hooks.json`——六条钩子在 DSH 上获得与 ZCode 同级的**硬拦截**：PreToolUse deny/ask、退出码 2 阻断、stderr 原文透传给模型、Stop 打回强制续步。

```text
1) 取得仓库到固定目录（示例 E:\focus-guard-main，git clone 或下载解压）
   git clone https://github.com/irisblackwood/focus-guard.git E:\focus-guard-main

2) 编辑 profile 补丁层（本机 desktop profile 示例）：
   %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
   在顶层数组末尾追加（路径按实际安装目录改，必须绝对路径）：

- insert:
    - name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: 'E:/focus-guard-main/packages/core/hooks/hooks.json'
        pluginRoot: 'E:/focus-guard-main'

3) 重启 DSH 会话生效。
```

⚠ **`- insert:` 这层不能省**。DSH 的补丁项分两类：带 `id` 的是「改已有条目」，带 `insert` 的是「追加新条目」。
直接写 `- name: ...` 属于第三类——既无 `id` 又无 `insert`，DSH 判为非法补丁项，**静默跳过**：

```text
dsh: [...\cordis.patch.yml] patch: id is required for non-insert patches
```

后果是桥根本没挂上、六条钩子一条都不跑，而启动过程不报错，只在 `dsh --dump-config` 的首行留一行提示。
自查方法：`dsh --profile <name> --dump-config`，在输出里找 `hooks-claude-code`（Windows 用 `findstr hooks-claude-code`，Git Bash 用 `grep`），**没有就是没挂上**。命令顺序是 `dsh --profile <name> --dump-config`（`--profile` 在前），写成 `dsh <name> --dump-config` 也可，但别把 `--dump-config` 放到名字前面。

要点与已知差异（相对 ZCode，均来自官方桥文档，逐条核实过）：

1. **硬拦截语义完整**：PreToolUse `deny`/`ask` 均支持；阻断原因 stderr 原文透传给模型（高危审批单、污染告警、委派提醒模型全部可见）；`deny > ask > allow` 合并。
2. **卷宗落点自动正确**：桥为每个钩子进程设置 `CLAUDE_PROJECT_DIR` = 会话工作区，卷宗/AUDIT.log 直接落工作区，无需手工设环境变量。
3. **PostToolUseFailure 无对应事件**（桥不支持 23 个 Claude 事件之一）：失败不计入停滞检测，停滞仅由重复/无进展触发。
4. **Stop 载荷无收尾文本**（`last_assistant_message` 恒缺、`transcript_path` 恒空串）：引擎 2.5.0 起按此签名自适应，2.5.2 起放宽为"**无收尾文本且 `transcript_path` 缺失或为空串**"，锚点/审批单打回一律降级为仅审计（`dsh-stop-observe` 留痕），避免桥接强制续跑死循环。
5. **SessionStart 为 detached**：注入可能错过首个请求，从第二条消息起生效；批示关键词（50/15/10）随 UserPromptSubmit 正常工作。
6. **configPath 只在进程加载时解析一次**，相对路径从启动目录解析——务必用绝对路径；修改后需重启 DSH。
7. `--dry-run` 等特例语义与 ZCode 完全一致（同一引擎）。
8. **不含资格审核与申辩**：`fg_apply` / `fg_appeal` 是原生插件的工具，桥只跑 `hooks.json` 的六条钩子——需要事前审核请改用 2A。

## 三、FAQ

### 1. Marketplace manifest not found（ZCode）

- 原因：添加插件市场时选择的目录里没有 `marketplace.json`——选到了子目录（如 `skills/`、`.zcode-plugin/`），或 zip 未解压。
- 修复：在仓库根执行 `dir /b marketplace.json` 确认存在；重新"添加插件市场"时选择这个文件夹本身。升级后报同样的错：先移除旧市场再重新添加，或直接在插件面板更新。
- 仍失败：检查 `marketplace.json` 是否被编辑损坏（合法 JSON），用 `node -e "JSON.parse(require('fs').readFileSync('marketplace.json','utf8'));console.log('ok')"` 验证。

### 1'. DSH 报"插件清单找不到 / 清单未命中"

DSH 按固定顺序查找清单（找不到才轮到下一级）：

```text
marketplace 清单：.agents/plugins/ → .claude-plugin/ → .cursor-plugin/ → .github/plugin/ → 根目录
插件清单：        .codex-plugin/ → .claude-plugin/ → 根目录
```

- ZCode 的 `.zcode-plugin/` 格式 **DSH 不认**，属正常；本仓库的 `.claude-plugin/plugin.json` 命中 DSH 插件清单查找第 2 位（兼容层加载），根 `marketplace.json` 命中 marketplace 第 5 位。
- 仍找不到：确认安装源指向仓库根目录（含 `package.json` 的那层），而不是 `hooks/`、`skills/` 等子目录。

### 1''. 装成功了，但 dsh 的插件清单里没有它

- **判据一条**：打开 `<profile>/package.json`，看 `dsh.profile.bundles` 数组里有没有目标包。
  只有 `dependencies` 里有**不算装上**——dsh 的 loader 清单是按 `bundles` 展开的。
- **已知病因（3.5.1 及以前）**：包里带 `postinstall`，pnpm 10 报 `ERR_PNPM_IGNORED_BUILDS`
  并非零退出；`dsh plugin` 是 pnpm 的薄转发器，pnpm 一失败，后面「把声明了 `dsh.bundle`
  的依赖对账进 `bundles`」那步就被整段跳过。**3.5.2 起包里已无任何 lifecycle 脚本。**
- **修复**：升级到 3.5.2 后重跑一次 `dsh plugin --profile <p> add focus-guard`；
  若 pnpm 仍拦脚本，先 `pnpm approve-builds` 再装。装完按上面那条判据核一次。

### 2. L3 熔断解除

- 表现：AI 输出『【熔断】无法通过现有资料定位核心问题』；改动类工具全部被拒，只读调查放行。
- 解除（一经拍板即解除，全部清零）：直接下达新任务即可；或短指令回复 `继续` / `放行` / `延长`（信用延期：停滞清零 + 预算 +10）。
- 确需放开证据要求（绝境模式）：≤30 字明示短指令——`启动绝境模式` / `允许基于有限信息猜测` / 【特赦】。豁免锚点检查，资源纪律（体积闸/预算上限）仍生效。
- 应急硬重置：关闭会话，删除状态文件 `%TEMP%\focus-guard-<会话ID>.json`（会话 ID 见 `.focus-guard/AUDIT.log` 的 `session` 字段），重开会话。

### 3. 环境误判修复

- 现象：Windows 上 PowerShell 专用的 `Select-Object` / `Get-ChildItem` 被误判成「bash 里没有」，或反过来 bash 命令被按 PowerShell 规则拦。
- 原因（2026-11-22 修）：执行体此前按**会话**猜——`expectedShellId()` 只要 PATH 里能解析到 bash 就认 bash，而本机装了 Git Bash；实际调用可能走 `pwsh` 工具。现在改为**按工具名判**（`env.mjs::shellIdForTool`：`pwsh`→PowerShell 规则、`bash`→bash 规则），会话指纹只影响没有工具名时的兜底。
- 修复：重启会话即可（旧进程仍加载旧代码）；旧逻辑下产生的误判可删除 `%TEMP%\focus-guard-<会话ID>.json` 强制重检（会话 ID 见 `.focus-guard/AUDIT.log` 的 `session` 字段）。
- 应急：若确属平台规则误报，按提示改用该 shell 的等价写法；`FG_SHELL` 仍可显式覆盖执行体标识（特殊部署/测试用）。

### 4. 升级后版本没变（部署漂移：源码与运行副本不一致）

- 表现：`.focus-guard/AUDIT.log` 的 `rules-registered` 事件仍记旧 `引擎vX.Y.Z`；ZCode 的 `installed_plugins.json` 里 `version` / `installPath` 仍指向旧版。
- 原因：宿主运行的是**插件安装副本**，改源码不会自动生效；DSH 原生插件则看 profile 的 `node_modules` 里装的是不是新版本。
- 修复：ZCode → 插件市场 → 刷新 → 更新 FocusGuard（必要时移除市场再重新添加）；DSH → `dsh plugin --profile <name> add focus-guard@<版本>` 或在插件面板更新；确认副本目录出现新版本号后重开会话。
- 自检：`node packages/core/tools/version.mjs` 打印 10 处版本面并校验一致（不一致 exit 1）；`node --test packages/core/tests/acceptance.test.mjs` 全绿即源码各清单（含 lock）与 CHANGELOG 最新条目一致。**不再有 SessionStart「部署版本核验」注入**——该注入已在 2026 年移除，以 `version.mjs` 与实际安装副本为准。

## 四、卸载

```text
ZCode：设置 → 插件 → FocusGuard 聚焦护栏 → 卸载
DSH·原生插件：dsh plugin --profile <profile> remove focus-guard，重启会话；
DSH·官方桥：  从 %USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml 中删除 dsh-hooks-claude-code 条目，重启会话。
```

工作区清理（可选）：删除 `<工作区>/.ai/`、`<工作区>/.focus-guard/` 与 `%TEMP%\focus-guard-*.json`。
