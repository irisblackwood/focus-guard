# 变更记录（CHANGELOG）

> 本文件按版本倒序记录面向使用者的变更。版本号与五处清单（`package.json`、根 `marketplace.json`、
> `.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`）
> 及引擎 `ENGINE_VERSION`、引擎头注释完全一致——该一致性由验收用例锁定。

## 勘误 · 历史 commit message 的行数口径（2026-10-09）

三条 `refactor(core)` 提交的 message 中，`guard.mjs` 行数与实际不符。**不改写历史**（不 force push），正确数字以下表为准：

| commit | message 声称 | 实际 | 差额 |
|---|---|---|---|
| `1f630c8` | 159 | **1707** | +1548（来源不明，疑为误抄） |
| `3aaf56d` | 1228 | **1348** | +120（≈ 该文件空行数） |
| `71199e7` | 1042 | **1142** | +100（≈ 该文件空行数） |

实测口径：已提交版本 `git grep -c '' <commit> -- packages/core/hooks/guard.mjs`；工作区版本 `(Get-Content <file>).Count`。父提交链 `1893 → 1707 → 1348 → 1142` 与三次拆分的 `git diff --numstat` 互相印证。

后两条差额与空行数吻合，说明当时用了**不数空行**的计数方式（如 `Measure-Object -Line`）。故立口径纪律：**`Measure-Object -Line` 禁止用于行数报告**（它漏数空行），一律用 `git grep -c ''`（已提交）或 `(Get-Content).Count`（工作区），改动量引用 `git diff --numstat`。

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
