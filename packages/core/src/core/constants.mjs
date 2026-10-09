// FocusGuard 母版层 · 常量与模板（v3.0.5；《资料与代码分层总规范》二·1）
// 阈值、窗口、版本号、固定文本模板与规则类正则。纯数据：无逻辑、无外部依赖。

export const OUTPUT_GATE_BYTES = 50 * 1024; // 触发③：体积闸值
export const RANDOM_AUDIT_EVERY = 5; // 抽查A：每 N 次写操作全量审计 1 次
export const BUDGET_DEFAULT = 10; // 默认任务预算
export const BUDGET_CAP = 200; // 硬上限：达到强制熔断
export const REFILL = 10; // 自动续杯步长
export const STALL_FUSE = 3; // 连续无效调用 → L3 熔断
export const MERCY_SHORT = 30; // 特赦短语仅认短指令(trim 后 ≤30 字符)，防协议文本误触
export const ENGINE_VERSION = "3.0.6"; // 42条：部署版本核验基准（须与五处清单及本文件头注释一致，见验收"版本一致性"用例）
export const INV_POOL_DEFAULT = 15; // 20条：侦查池独立额度（批示可追加）
export const SHA_LIMIT = 200 * 1024; // 总纲四：SHA-256 校验上限（≤200KB）
export const CASE_MAX_ROWS = 200; // 卷宗【三】最大行数（超出淘汰最旧）
export const TTL_FIRST = 4 * 3600e3; // 自适应：首次 4h
export const TTL_RECENT = 2 * 3600e3; // 自适应：7天内有变 2h
export const TTL_WEEK = 24 * 3600e3; // 自适应：7-30天未变 24h
export const TTL_STABLE = 7 * 86400e3; // 自适应：30天未变 7天

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
export const SECRET_FILE_RE = /(^|\/)(?:\.env(?:\.[^\/]*)?|\.npmrc|\.netrc|\.git-credentials|\.pgpass|\.htpasswd|id_rsa|id_ed25519|id_ecdsa)$|[^\/]*\.(?:pem|key|pfx|p12|jks)$/i;
// 2.5.2 变更类命令判定：按"命令词"识别，并剥掉 sudo/env/xargs/时间前缀等外壳。
// 旧写法（`(^|[;&|]\s*)(rm|mv|…)`）要求命令词紧跟段首，于是 `sudo mv`、`xargs mv`、`cp`（当时根本不在表里）
// 全被判成"只读侦查"——既绕过触发①（未取证就改），又在熔断期拿到放行。
export const BACKUP_KEEP = 100; // 2.2.0：.ai/backup/ 最大保留份数（超出淘汰最旧）
export const DELEGATE_DEFAULT = 20; // 2.3.0：委托池默认额度（独立于执行池；批示『追加额度』三池各+10）
export const DOWNGRADE_MSG =
  "[触发⑤·熔断]改动类已拒（只读放行）。三选一各一行：" + FUSE_HINT +
  "。禁静默禁硬凑。解除后经验按 [环境:x][任务:y] 记入 .ai/PATTERNS.md。";

export const SESSION_RULES =
  "<focus-guard AI履职执法模型v3.0：日常零打扰，只看行为>" +
  "【触发】①未取证就改 ②≥5次收尾无[文件:行号]锚点且无【假设】 ③整读>50KB/Grep无head_limit/裸cat ④超预算 ⑤查无实据硬凑。" +
  "【额度】批示关键词定(50/15/10)，【任务规模】可上调；侦查/执行/委托三池分立，执行满+10上限200。" +
  "【进度】3次无效→熔断；停滞2次→【信用延期】(继续/放行/延长→+10)。" +
  "【处罚】L1打回→L2取证→L3熔断(只读放行)→L4记档→L5降权→L6上报；人类指令=批示。" +
  "【熔断出口】『" + FUSE_PHRASE + "』+三行降级方案。" +
  "【特赦】仅认短指令(绝境模式/允许猜测/【特赦】)；受权须先出【授权识别】(引原文+法条)，否则越权。" +
  "【留痕】全程记<工作区>/.focus-guard/AUDIT.log(因果链chain/seq)。细则见focus-thinking技能与docs/RULES.md。";

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
