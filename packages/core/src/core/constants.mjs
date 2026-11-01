// FocusGuard 母版层 · 常量与模板（v3.0.5；《资料与代码分层总规范》二·1）
// 阈值、窗口、版本号、固定文本模板与规则类正则。纯数据：无逻辑、无外部依赖。

export const OUTPUT_GATE_BYTES = 50 * 1024; // 触发③：体积闸值
export const RANDOM_AUDIT_EVERY = 5; // 抽查A：每 N 次写操作全量审计 1 次
// 抽查B（反规避随机检查点，2026-10-19）：间隔在 [MIN, MAX] 次写操作之间随机，**与抽查A 完全独立**。
// **默认开启**（2026-10-19 晚人类批示；代码口径见 postProgress.mjs 的 randomFuseInterval）：
//   FG_RANDOM_FUSE=0 关闭；FG_RANDOM_FUSE_EVERY=N 固定间隔（运维/测试用）。
// 2026-10-27 改：检查点默认**只留痕不打断**——"拒一次"必然多一次工具往返，而它不核对任何内容；
//   旧语义保留在 FG_RANDOM_FUSE_BLOCK=1（见 pipeline.mjs 的 layer3Check）。
export const RANDOM_FUSE_MIN = 2; // 反规避抽查B：随机间隔下限（次写操作）
export const RANDOM_FUSE_MAX = 5; // 反规避抽查B：随机间隔上限（次写操作）
export const BUDGET_DEFAULT = 10; // 默认任务预算（关键词档位保持 50/15/10；放宽靠 REFILL 与回合清零）
export const BUDGET_CAP = 200; // 硬上限：达到强制熔断（回合级计数，换回合归零）
export const REFILL = 10; // 自动续杯步长（保持 10：放宽靠回合清零 + STALL_FUSE 5 + deny 豁免）
export const STALL_FUSE = 5; // 连续无效调用 → L3 熔断（3 → 5，2026-10-28：被拦≠空转）
export const MERCY_SHORT = 30; // 特赦短语仅认短指令(trim 后 ≤30 字符)，防协议文本误触
export const ENGINE_VERSION = "3.3.1"; // 42条：部署版本核验基准（须与七处清单一致，见验收"版本一致性""版本追赶"两条用例）
export const INV_POOL_DEFAULT = 15; // 20条：侦查池独立额度（批示可追加；放宽靠 REFILL 20）
export const SHA_LIMIT = 200 * 1024; // 总纲四：SHA-256 校验上限（≤200KB）
export const CASE_MAX_ROWS = 200; // 卷宗【三】最大行数（超出淘汰最旧）
// 3.4.0 半衰期（判据变更，2026-10-31 用户批示）：原先是四档阶梯（4h/2h/24h/7d），
// 在档位边界上跳变——age 从 6.99 天跨到 7.01 天，重读期限从 2h 跳到 24h，12 倍。
// 改成连续衰减：S = 该文件最近多久没变（夹在两端点内），R = 0.5^(已读时长/S)，
// 到期即 R < 0.5。语义是「已观察到多久没变，就假设还能保持多久」，不是拍脑袋分档。
export const TTL_FIRST = 4 * 3600e3; // 无变更历史（首次侦查）兜底 4h
export const TTL_FLOOR = 2 * 3600e3; // 半衰期下限：刚变过的文件，最多 2h 就要重读
export const TTL_CEIL = 7 * 86400e3; // 半衰期上限：长期不动的文件，7 天重读一次
export const TTL_GAIN = 0.1; // 变更次数增益：n 次变更各 +10% 半衰期（n 封顶 5 → 最多 +50%）

export const FUSE_PHRASE = "【熔断】无法通过现有资料定位核心问题";
export const FUSE_HINT = "1【最小复现】步骤/实验 2【联网证据】链接+原文 3【卡点记录】写HANDOFF.md"; // 各一行
// 3.0.5 资料分层（《资料与代码分层总规范》）：.ai/library 为外部原文静态区（只同步不就地改）；
// 派生积木视图由 library-build 生成到 .ai/output/library（R6 记忆更新隔离区的机械化）
export const LIBRARY_RE = /(^|[\\/])\.ai[\\/]library[\\/]/i;
export const BLOCKS_RE = /(^|[\\/])\.ai[\\/]output[\\/]library[\\/]/i;
// 3.0.0 解释器黑名单（R5-3 采纳）：解释器 -c/--eval 一类等价任意代码执行，不再判只读侦查（熔断期不放行、不进侦查池）
export const INTERP_EVAL_RE = /\b(?:python3?|py|node|perl|ruby|php|lua|pwsh|powershell)\b[^&|;]*(?:-c|-e|--eval|--command)\b/i;
// 2.4.0：标准审批单（一行，禁长篇解释）
export const HIGH_RISK_FORM =
  "【高危申请】命令：`<真实命令>` | 真实目的：<一句话> | 影响范围：<具体文件/表/系统> | 回滚方案：<可否回滚> | 允许执行？(y/n)";
export const MERCY_RE = /允许基于有限信息(进行)?猜测|(开启|启动|进入|批准|授予)绝境模式|【特赦】|(^|[\s，。！？,!?])特赦(?=$|[\s，。！？,!?])/;
export const CREDIT_RE = /继续|放行|延长/; // 信用延期批复（短指令）
export const STOP_ORDER_RE = /熔断|停止|^停$/; // 停止批复（短指令）
export const TASK_SCALE_RE = /【任务规模】[^0-9]{0,8}(\d{1,3})/;
export const KEY50_RE = /审计|红队|重构|全量|批量|探索|遍历|升级|补丁/;
export const KEY15_RE = /修复|添加|修改|重命名|删除/;
// 《授权识别与留痕条例》声明核验
export const PARDON_DECL_RE = /【授权识别】/;
export const PARDON_PENDING_RE = /【授权待确认】/;
export const PARDON_QUOTE_RE = /【授权识别】[\s\S]{0,60}?「([^「」\n]{2,120})」/;
export const PARDON_BASIS_RE = /依据[:：]\s*【?([^】\n，。；]{2,50})/;
export const AUTH_SEMANTICS_RE = /授权|特赦|赦免|批准|允许|豁免|跳过|绕过|无需|不用|猜测/;
export const DOWNGRADE_MARKERS = /最小复现|复现请求|排查实验|联网证据|外部搜寻|卡点记录|HANDOFF\.md|交接报告/i;
export const EVIDENCE_ANCHORS = /:\d+|日志原文|报错|HANDOFF\.md|交接报告|【假设】|【熔断】/;
export const RISKY_FILE_RE = /(^|\/)(package(-lock)?\.json|[^\/]*\.lock|tsconfig\.json|AGENTS\.md|CLAUDE\.md|Dockerfile|[^\/]*\.env[^\/]*|zcode\.json|[^\/]*\.csproj|[^\/]*\.sln)$|\.github\/|\.zcode-plugin\//i;
// 2.5.2：敏感文件（明文密钥与凭据）——改动前不做明文副本，只留痕（.pub 公钥不在此列）
// 2026-11-01 红队 A1：原表是枚举式，实测 21 种常见含密文件漏 9 种，其中**项目内真实存在**的是
// `*.tfvars`（Terraform 变量，常含密码）、`secrets.yaml`（k8s）、`*.ppk`（PuTTY 私钥）、
// `*.p8` / `*.keystore` / `*.jceks` / `*.kdbx` / `*.ovpn` / `*.mobileprovision`。
// 同日第二轮：**判据反过来**——枚举永远会漏，所以主判据改成白名单（见 BACKUP_ALLOW_RE），
// 本表降为第二道，只负责给"像密钥的"一个更具体的提示。
// 补的第三类：按**文件名前缀**判（`credentials.json` / `secrets.yaml` / `service-account.json`
// / `keyfile.*`）——这些扩展名本身是"无害"的 `.json`/`.yaml`，白名单会放行，必须在这里拦住。
// 代价：`secrets.py` 这类同名源码模块也拿不到备份副本。**少一份回滚副本** 好过 **明文密钥入库**。
export const SECRET_FILE_RE = /(^|\/)(?:\.env(?:\.[^\/]*)?|\.npmrc|\.netrc|\.git-credentials|\.pgpass|\.htpasswd|(?:credentials|secrets?|service-account|keyfile)[^\/]*|id_(?:rsa|dsa|ecdsa|ed25519))$|[^\/]*\.(?:pem|key|pfx|p12|p8|jks|jceks|keystore|kdbx|ppk|ovpn|tfvars|mobileprovision)$/i;

// ============ 备份白名单（2026-11-01 红队 A1 第二轮：判据反过来） ============
//
// 为什么反过来：黑名单是"列出所有危险的东西"，而危险的东西每天在长新格式；白名单是
// "列出所有安全的东西"，安全的东西几十年就这些。**枚举危险必然漏，枚举安全可以穷尽。**
//
// 覆盖面 = 源码 + 文档 + 配置模板。**不备份**二进制、媒体、压缩包、密钥、数据文件。
// 漏备一份源码副本的代价是"少一次回滚"，漏拦一份密钥的代价是"明文凭据被提交上远端"——
// 两害相权，白名单必须窄。
export const BACKUP_ALLOW_RE =
  /\.(?:[cm]?[jt]sx?|vue|svelte|py|rb|go|rs|java|kt|kts|cs|cpp|cc|cxx|c|h|hpp|hh|swift|php|pl|lua|sh|bash|zsh|fish|ps1|psm1|bat|cmd|sql|graphql|gql|proto|tf|hcl|gradle|cmake|mk|dart|scala|clj|ex|exs|erl|hs|ml|fs|r|jl|md|markdown|txt|rst|adoc|org|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|properties|xml|html?|css|scss|sass|less|styl)$/i;

/** 无扩展名但明确安全的文件名（构建脚本、许可、忽略规则等）。 */
export const BACKUP_ALLOW_NAME_RE =
  /^(?:Makefile|makefile|GNUmakefile|Dockerfile|Containerfile|LICEN[CS]E|NOTICE|README|CHANGELOG|AUTHORS|CONTRIBUTING|CODEOWNERS|Procfile|Gemfile|Rakefile|go\.mod|go\.sum|\.gitignore|\.gitattributes|\.editorconfig|\.prettierrc|\.eslintrc|\.babelrc)$/i;
// 2.5.2 变更类命令判定：按"命令词"识别，并剥掉 sudo/env/xargs/时间前缀等外壳。
// 旧写法（`(^|[;&|]\s*)(rm|mv|…)`）要求命令词紧跟段首，于是 `sudo mv`、`xargs mv`、`cp`（当时根本不在表里）
// 全被判成"只读侦查"——既绕过触发①（未取证就改），又在熔断期拿到放行。
export const BACKUP_KEEP = 100; // 2.2.0：.ai/backup/ 最大保留份数（超出淘汰最旧）
export const DELEGATE_DEFAULT = 20; // 2.3.0：委托池默认额度（独立于执行池；批示『追加额度』三池各+10）
export const DOWNGRADE_MSG =
  "[触发⑤·熔断]改动类已拒（只读放行）。三选一各一行：" + FUSE_HINT +
  "。禁静默禁硬凑。解除后经验按 [环境:x][任务:y] 记入 .ai/PATTERNS.md。";

// 熔断告知（2026-10-27）：熔断此前对模型**完全不可见**——postProgress 的熔断理由只进 warn，
// 模型要等到自己尝试写才被拒。实测 turn 128：熔断后仍白走 16 步（全是只读探索，闸不管）。
// 现于系统提示追加这一段（**仅熔断期间**出现，文案固定以免每步变化破坏前缀缓存）。
// 文案属母版层：宿主缝只负责"何时注入"，不负责措辞。
export const FUSE_NOTICE =
  "<focus-guard 熔断：本任务已终止>改动类调用已拒（只读放行）。不要再探索或取证——" +
  "直接输出结论 + 三行降级方案：① 已完成什么 ② 卡在哪 ③ 需要人类做什么。";

// 常驻注入（按需自证 Lazy Rules，2026-10-24 人类批示"按需注入"）
// 病根：完整条文 427 字常驻 system prompt，每步都付；而其中多数条目只在**被触发时**才有意义。
// 现只留"行为会因此改变"的硬线（222 字），完整条文见 docs/RULES.md 第一部分。
// 2026-10-31 删去 SESSION_RULES_FULL：未导出的死常量，注释称"供引用"实则无人可引用
//（HANDOFF-2026-10-27 R4 已记），留着只会诱使后续把它接进注入层（222 → 427 字符）。原文见 git 历史。
export const SESSION_RULES =
  "<focus-guard v3.0：日常零打扰，只看行为>" +
  "【硬线】①未取证不改进——先 read 再改；②收尾须带[文件:行号]锚点或标【假设】；" +
  "③禁整文件整读(>300行)、裸cat、无限量Grep；④超预算/停滞→熔断(只读放行)；⑤人类指令=批示，受权先引原文。" +
  "【额度】批示关键词定(50/15/10)，三池分立(侦查/执行/委托)。" +
  "【熔断出口】『" + FUSE_PHRASE + "』+三行降级方案。" +
  "细则见 docs/RULES.md。";

// ============ 2.0 卷宗（总纲二：.ai/CASE_FILE.md 四册） ============

export const CASE_TEMPLATE =
  "# FocusGuard 卷宗（CASE_FILE）\n\n" +
  "> 引擎自动维护【一】【三】【四】；【二】由人工填写。请勿手工重排结构。【三】TTL 列留空=自适应，人工填写（如 30天/1小时）=覆盖。\n\n" +
  "### 【一】环境声明（会话启动检测，全程复用）\n\n（SessionStart 自动写入检测结果并全程复用，人类可在此直接查阅）\n\n" +
  "### 【二】项目依赖声明（人工填写，可覆盖自动 TTL）\n\n" +
  "| 依赖名 | 版本 | 安装路径 | 更新频率 | 信任TTL | 备注 |\n|---|---|---|---|---|---|\n\n" +
  "### 【三】侦查取证记录（插件自动追加）\n\n" +
  "| 文件名 | 读取时间 | mtime | size | SHA-256 | 变更历史 | TTL | 验证方式 |\n|---|---|---|---|---|---|---|---|\n\n" +
  "### 【四】工作额度台账\n\n" +
  "| 任务 | 初始额度 | 已用额度 | 剩余额度 | 有效调用 | 无效调用 | 更新时间 | KPI |\n|---|---|---|---|---|---|---|---|\n";

export const HIGH_RISK_QUEUE_MAX = 10; // 待批队列上限（防状态无界）
