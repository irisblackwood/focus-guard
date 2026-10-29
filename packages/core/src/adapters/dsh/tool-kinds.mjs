/**
 * DSH 宿主的工具语义注册（2026-10-22）
 *
 * 母版 `core/risk.mjs` 只认语义类别；宿主方言（`write` / `pwsh` / `mcp__…`）在本文件登记。
 * 新增 DSH 工具时**只改这里**，母版不动。
 *
 * ⚠ 没登记的后果（2026-10-29 补记）：名字落成 `other`，而 `other` 不是"不管"——
 * ① 熔断期 `gateFused` 只放行 `isInvestigation`，`other` 落到 deny 分支
 *    （`dsh/preGuard.mjs`），外部插件的查询工具会被当成改动类拒掉；
 * ② `poolOf` 把它算进执行池而不是侦查池（`core/progressPolicy.mjs`），只读检索去抢写入配额。
 *
 * 装了新插件（尤其是带 MCP 工具的）后，会话启动会由 `dsh/toolKindAudit.mjs` 报一条
 * 「未登记语义类别」的 warn。看到就回来补登记，别当噪音。
 *
 * MCP 名字另有动词兜底（`risk.mjs` 的 `MCP_MUTATION_RE`）：`mcp__x__y_write` 能自动认成
 * 改动类。兜底是"别漏太狠"，不是"可以不登记"——显式登记优先，且能覆盖兜底认不出的命名。
 */

import { registerToolKind, registerReadOnlyActions } from '../../core/risk.mjs'

registerToolKind('mutation', [
  'write',
  'edit',
  'multiedit',
  'patch',
  'applypatch',
  'notebookedit',
  // 插件/迁移类（会写盘、装包、跑构建脚本）
  'plugin_manager',
  'move_run',
  'import_claude',
  'claude_export',
])

// 同名工具里的只读动作（2026-10-27）：`plugin_manager` 本身是改动类，
// 但列举类动作不写盘、也无文件路径，取证闸不应按"改动类无路径"挡死。
registerReadOnlyActions('plugin_manager', [
  'list_plugins',
  'list_bundles',
  'list_version_exemptions',
])

registerToolKind('shell', ['pwsh', 'bash', 'shell', 'sh', 'cmd', 'terminal', 'runcommand'])

registerToolKind('read', [
  'read',
  'grep',
  'glob',
  'read_image',
  'notebookread',
  'web_search',
  'web_fetch',
  'ask_user_question',
  'list_agents',
  'list_experts',
  'list_expert_teams',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'cordis_inspect_list',
  'cordis_inspect_query',
])

// MCP 只读工具逐个登记（2026-10-29）
//
// 名字兜底（`risk.mjs` 的 `MCP_READ_RE`）只认 `web` / `search`，于是 `get_*` / `list_*` /
// `query_*` / `analyze_*` 全落成 `other` —— 熔断期被当改动类拒掉、调用算执行池。
// 这里**逐个显式登记，不用正则猜只读**：猜错的代价是熔断期放行一个真会写盘的工具，
// 而写盘工具一旦漏拦，取证闸整条防线就绕过去了。
//
// 装新 MCP 后若 `agent/created` 报「未登记语义类别」，把只读的那几个加到这里，
// 写盘/构建/安装的那几个加到上面的 mutation 段。
registerToolKind('read', [
  'mcp__cities2-mcp__analyze_project',
  'mcp__cities2-mcp__get_encyclopedia_entry',
  'mcp__cities2-mcp__get_page',
  'mcp__cities2-mcp__get_snippets',
  'mcp__cities2-mcp__list_project_tree',
  'mcp__cities2-mcp__query_reference',
  'mcp__cities2-mcp__source_status',
])
