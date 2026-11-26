/**
 * 模块清单（tools/lib/modules-list.mjs，2026-11-19）
 *
 * **全仓唯一手写的模块划分**。算法在 `modules.mjs`，渲染在 `modules-doc.mjs`——
 * 清单是数据，那两个是代码，混在一起会让两边都改不动。
 *
 * ## 划分依据是「功能」，不是「目录」
 *
 * 2026-11-19 首版按目录切（core / dsh / tools …），切出 15 个大桶。问题有两个：
 *
 * ① **桶太大，个别文件一活跃就把整桶刷绿**。实测 `tools` 最新文件 0 天、中位文件 16 天；
 *    `src/core` 最新 0 天、中位 21 天。取「最新」等于只统计最勤快的那一个文件。
 * ② **一个桶里装着互不相干的东西**。`core` 里同时有红线、审批、资格、审计、状态机、清理、
 *    环境常量——它们各自该被独立盯，谁落后跟别人无关。
 *
 * 所以改按功能切：一个模块 = **一块会一起变的功能**。红线改了审批不该跟着动，
 * 压缩监控坏了跟会话诊断没关系。切细之后「中位文件」才有意义——同模块的文件本就同质。
 *
 * ## 路径必须互不重叠
 *
 * 一个文件只能属于一个模块，否则同一份改动会同时点亮两行，判定就假了。
 * `tests/modules-attribution.test.mjs` 会核对：无重叠、无遗漏（除 `META_FILES`）。
 */

/** 仓根元数据：不属于任何功能模块，但也是受管文件。列出来是为了「未归属」能归零。 */
export const META_FILES = [
  '.claude-plugin',
  '.githooks',
  '.github',
  '.zcode-plugin',
  '.gitattributes',
  '.gitignore',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'cordis.patch.yml',
  'marketplace.json',
  'package-lock.json',
  'package.json',
  'stryker.config.json',
  'packages/core/LICENSE',
  'packages/core/NOTICE',
  'packages/core/README.md',
  'packages/core/README.zh-CN.md',
  'packages/core/package.json',
  'packages/extended/LICENSE',
  'packages/extended/NOTICE',
  'packages/extended/package.json',
]

export const MODULES = [
  {
    id: 'redline',
    name: '红线判定',
    note: '红线清单与匹配模式：哪些动作绝对不许做，命中即拦',
    paths: ['packages/core/src/core/redlines.mjs', 'packages/core/src/core/patterns.mjs', 'packages/core/src/dsh/guard/redline.mjs'],
  },
  {
    id: 'approval',
    name: '审批与授权',
    note: '审批单、一次性授权、按范围放行；谁能替谁点头',
    paths: ['packages/core/src/core/approvals.mjs', 'packages/core/src/core/approval.mjs', 'packages/core/src/core/grants.mjs', 'packages/core/src/dsh/guard/authz.mjs'],
  },
  {
    id: 'eligibility',
    name: '资格闸',
    note: '一个动作够不够格做：工具面翻译 + 资格判定，闸里最大的一块',
    paths: ['packages/core/src/core/checkEligibility.mjs', 'packages/core/src/adapters/dsh/eligibility-gate.mjs'],
  },
  {
    id: 'risk',
    name: '风险与体积',
    note: '风险分级、改动体积、工具分类、整文件判据——决定要不要拦',
    paths: [
      'packages/core/src/core/risk.mjs',
      'packages/core/src/dsh/guard/risk.mjs',
      'packages/core/src/dsh/guard/volume.mjs',
      'packages/core/src/dsh/guard/tooling.mjs',
      'packages/core/src/dsh/guard/wholeFile.mjs',
      'packages/core/src/dsh/guard/hardCheck.mjs',
      'packages/core/src/dsh/guard/writing-gate.mjs',
      'packages/core/src/dsh/guard/retryGuard.mjs',
    ],
  },
  {
    id: 'sentinel',
    name: '本地哨兵',
    note: '第 2 层风险后端：接一条待执行命令，回风险分与类别；Python 实现 + JS 调用方',
    paths: ['packages/core/src/dsh/sentinel.py', 'packages/core/tools/sentinel.mjs'],
  },
  {
    id: 'evidence',
    name: '取证与闸运行时',
    note: '拦之前先把证据抓实，以及闸的加载、版本、注册',
    paths: ['packages/core/src/dsh/guard/evidence.mjs', 'packages/core/src/dsh/guard/runtime.mjs'],
  },
  {
    id: 'audit',
    name: '审计写入与卷宗',
    note: 'AUDIT.log 的行契约、卷宗落盘、策略审计——出了事能倒查',
    paths: [
      'packages/core/src/core/audit-writer.mjs',
      'packages/core/src/core/audit.mjs',
      'packages/core/src/dsh/audit.mjs',
      'packages/core/src/dsh/policy-audit.mjs',
      'packages/core/tools/lib/case-tool.mjs',
      'packages/core/tools/case-audit.mjs',
      'packages/core/tools/verify-case-paths.mjs',
    ],
  },
  {
    id: 'state',
    name: '状态机与决策',
    note: '会话状态、阶段图、停止策略、决策引擎——下一步做什么',
    paths: [
      'packages/core/src/core/state.mjs',
      'packages/core/src/core/decisionEngine.mjs',
      'packages/core/src/core/stageGraph.mjs',
      'packages/core/src/core/stopPolicy.mjs',
      'packages/core/src/core/kpi.mjs',
    ],
  },
  {
    id: 'output',
    name: '输出闸与进度策略',
    note: '什么能说出口、说到第几步该收——管的是话，不是动作',
    paths: ['packages/core/src/core/outputGate.mjs', 'packages/core/src/core/progressPolicy.mjs'],
  },
  {
    id: 'env',
    name: '环境与常量',
    note: '宿主环境探测、全局常量、schema 漂移、临时路径',
    paths: [
      'packages/core/src/core/env.mjs',
      'packages/core/src/core/constants.mjs',
      'packages/core/src/core/schemaDrift.mjs',
      'packages/core/src/core/tempPath.mjs',
      'packages/core/src/core/session.mjs',
    ],
  },
  {
    id: 'profiles',
    name: '画像',
    note: '五份纯参数画像 + 加载器；只在有人批准调参时才会动',
    paths: ['packages/core/src/profiles', 'packages/core/src/core/profileLoader.mjs'],
  },
  {
    id: 'memory',
    name: '记忆与工作区',
    note: '记忆条目、标签、会话暂存、工作区快照与蒸馏',
    paths: [
      'packages/core/src/memory',
      'packages/core/src/core/sessionScratch.mjs',
      'packages/core/src/dsh/workspace.mjs',
      'packages/core/tools/memory-audit.mjs',
      'packages/core/tools/memory-distill.mjs',
      'packages/core/tools/memory-recall-eval.mjs',
    ],
  },
  {
    id: 'cleanup',
    name: '清理与备份',
    note: '陈旧产物清理、备份、首跑清扫——不显眼，脏了才发现',
    paths: ['packages/core/src/core/staleCleanup.mjs', 'packages/core/src/core/backup.mjs', 'packages/core/tools/first-run-sweep.mjs'],
  },
  {
    id: 'prefix',
    name: '前缀稳定',
    note: '系统提示前缀分歧点检测与审计；单文件，只在宿主改提示结构时才需要动',
    paths: ['packages/core/src/core/prefixStability.mjs', 'packages/core/tools/prefix-audit.mjs', 'packages/core/tools/prefix-drift.mjs'],
  },
  {
    id: 'cost',
    name: '峰谷成本',
    note: 'DeepSeek 峰谷价目核算与成本基准',
    paths: ['packages/core/src/peak-cost.mjs', 'packages/core/tools/bench-cost.mjs', 'packages/core/tools/lib/prefix-cost.mjs'],
  },
  {
    id: 'pipeline',
    name: '宿主编排',
    note: 'PRE_STAGES 编排、宿主入口、工具清单注入',
    paths: ['packages/core/src/dsh/pipeline.mjs', 'packages/core/src/dsh/index.js', 'packages/core/src/dsh/tools.mjs', 'packages/core/src/dsh/seams.mjs'],
  },
  {
    id: 'seams',
    name: '宿主缝',
    note: '挂到宿主生命周期上的入口：pre-step / pre-execute / session-start 等',
    paths: ['packages/core/src/dsh/seams', 'packages/core/src/dsh/bridgeCheck.mjs'],
  },
  {
    id: 'compaction',
    name: '压缩监控',
    note: '上下文压缩前后数锚点、报丢失——压缩是静默丢信息的高发区',
    paths: ['packages/core/src/dsh/compactionWatch.mjs', 'packages/core/src/dsh/compactionWatch'],
  },
  {
    id: 'progress',
    name: '进度与心跳',
    note: '任务进度上报、心跳、状态行',
    paths: ['packages/core/src/dsh/postProgress.mjs', 'packages/core/src/dsh/heartbeat.mjs', 'packages/core/src/dsh/status.mjs'],
  },
  {
    id: 'guards',
    name: '守卫入口',
    note: 'pre / stop / repeat 三道入口守卫与价值判定',
    paths: [
      'packages/core/src/dsh/preGuard.mjs',
      'packages/core/src/dsh/stopGuard.mjs',
      'packages/core/src/dsh/repeatGuard.mjs',
      'packages/core/src/dsh/value-gate.mjs',
    ],
  },
  {
    id: 'session',
    name: '会话与诊断',
    note: '会话作用域、追踪元数据、搜索提示、hook 顺序、工具分类审计',
    paths: [
      'packages/core/src/adapters/dsh/session.mjs',
      'packages/core/src/dsh/sessionScope.mjs',
      'packages/core/src/dsh/traceMeta.mjs',
      'packages/core/src/dsh/search-hints.mjs',
      'packages/core/src/dsh/hookOrder.mjs',
      'packages/core/src/dsh/toolKindAudit.mjs',
      'packages/core/src/dsh/testRuntime.mjs',
    ],
  },
  {
    id: 'adapters',
    name: '适配层（工具面）',
    note: '宿主工具名/参数 → 母版语义的翻译；宿主改名先炸这里',
    paths: ['packages/core/src/adapters/dsh/tool-kinds.mjs', 'packages/core/src/dsh/toolName.mjs'],
  },
  {
    id: 'brain',
    name: '3D 脑',
    note: '皮层可视化：资产构建、区域映射、文档生成',
    paths: [
      'packages/core/tools/brain-cosmic.mjs',
      'packages/core/tools/brain.mjs',
      'packages/core/tools/lib/brain-core.mjs',
      'packages/core/tools/lib/brain-docs.mjs',
      'packages/core/tools/lib/brain-regions.mjs',
      'packages/core/tools/lib/brain-relate.mjs',
      'packages/core/tools/lib/brain-text.mjs',
      'packages/core/tools/make-cortex-asset.mjs',
      'packages/core/tools/brain-view.html',
      'packages/core/assets',
    ],
  },
  {
    id: 'extended',
    name: '外接三包（桥接扩展）',
    note: 'Viking 积木同步桥 / Needle2 本地模型外判 / Semantica 图谱导出；核心包不依赖本包',
    paths: ['packages/extended/bridges', 'packages/extended/tests'],
  },
  {
    id: 'skill',
    name: '技能文本',
    note: 'focus-thinking 等 SKILL.md——写给模型的指令，不是代码',
    paths: ['packages/core/skills'],
  },
  {
    id: 'hooks',
    name: '封存引擎（ZCode 路径）',
    note: '已封存、版本独立。**故意不动**——久未动是它的正常状态，不是遗忘',
    paths: ['packages/core/hooks'],
  },
  {
    id: 'selfcheck',
    name: '自检与变异',
    note: '尺子本身：lint / 退役惯用法 / smells / selftest / mutate / 指纹 / 结构图',
    paths: [
      'packages/core/tools/lint.mjs',
      'packages/core/tools/lib/idioms.mjs',
      'packages/core/tools/smells.mjs',
      'packages/core/tools/selftest.mjs',
      'packages/core/tools/mutate.mjs',
      'packages/core/tools/health.mjs',
      'packages/core/tools/quality-audit.mjs',
      'packages/core/tools/capture-fixtures.mjs',
      'packages/core/tools/schema-fingerprint.mjs',
      'packages/core/tools/env-fingerprint.mjs',
      'packages/core/tools/lib/health-core.mjs',
      'packages/core/tools/lib/ratchet.mjs',
      'packages/core/tools/lib/source-text.mjs',
      'packages/core/tools/lib/reach.mjs',
      'packages/core/tools/lib/import-graph.mjs',
      'packages/core/tools/lib/envMap.mjs',
    ],
  },
  {
    id: 'structure-audit',
    name: '结构审计',
    note: '闸核对、分层、链路、死导出、模块台账、面板——量的是骨架',
    paths: [
      'packages/core/tools/gate-audit.mjs',
      'packages/core/tools/gate-inputs.mjs',
      'packages/core/tools/layering-audit.mjs',
      'packages/core/tools/audit-chain.mjs',
      'packages/core/tools/log-audit.mjs',
      'packages/core/tools/dead-export.mjs',
      'packages/core/tools/module-audit.mjs',
      'packages/core/tools/modules-audit.mjs',
      'packages/core/tools/lib/modules.mjs',
      'packages/core/tools/lib/modules-doc.mjs',
      'packages/core/tools/lib/modules-list.mjs',
      'packages/core/tools/lib/index-io.mjs',
      'packages/core/tools/lib/sessionDump.mjs',
      'packages/core/tools/collect-panel.mjs',
      'packages/core/tools/handoff.mjs',
    ],
  },
  {
    id: 'tools-docs',
    name: '文档与书',
    note: '文档判据、状态总表、退役台账、资料书与全仓成书——管的是文字产物',
    paths: [
      'packages/core/tools/docs-lint.mjs',
      'packages/core/tools/docs-drift.mjs',
      'packages/core/tools/legacy-audit.mjs',
      'packages/core/tools/lib/legacy-core.mjs',
      'packages/core/tools/docs-book.mjs',
      'packages/core/tools/lib/docs-core.mjs',
      'packages/core/tools/lib/docs-status.mjs',
      'packages/core/tools/lib/docs-version.mjs',
      'packages/core/tools/lib/docs-ack.mjs',
      'packages/core/tools/lib/markdown.mjs',
      'packages/core/tools/lib/book-style.mjs',
      'packages/core/tools/library-build.mjs',
      'packages/core/tools/library-index.mjs',
      'packages/core/tools/library-book.mjs',
      'packages/core/tools/knowledge.mjs',
      'packages/core/tools/lib/open.mjs',
    ],
  },
  {
    id: 'bench',
    name: '基准评测',
    note: 'A/B 与成本基准：证明改动真的更好，而不是感觉更好',
    paths: ['packages/core/tools/bench-ab.mjs', 'packages/core/tools/panel-baseline.mjs'],
  },
  {
    id: 'privacy',
    name: '隐私面',
    note: '私有规则与已跟踪文件扫描；一次泄漏就够致命',
    paths: ['packages/core/tools/privacy-guard.mjs'],
  },
  {
    id: 'install',
    name: '安装与清单',
    note: '装得上、清单对得上、版本一致；CLI 入口也在这里',
    paths: [
      'packages/core/tools/install-check.mjs',
      'packages/core/tools/manifest-sync.mjs',
      'packages/core/tools/version.mjs',
      'packages/core/tools/release.mjs',
      'packages/core/tools/focusguard.mjs',
      'packages/core/src/dsh/cordis.patch.yml',
    ],
  },
  {
    id: 'tests',
    name: '测试',
    note: '回归、等变、验收、真实参数夹具',
    paths: ['packages/core/tests', ':(exclude)packages/core/tests/fixtures'],
  },
  {
    id: 'fixtures',
    name: '真实参数夹具',
    note: '从宿主实际调用里采下来的参数；宿主 schema 一变它们就过期，最容易被忘',
    paths: ['packages/core/tests/fixtures'],
  },
  {
    id: 'docs',
    name: '文档',
    note: '权威文档与索引；由 `docs:lint` 另有判据，这里只看「多久没动」',
    paths: ['docs', 'packages/core/docs', 'README.md', 'INSTALL.md', 'CHANGELOG.md'],
  },
]
