/**
 * DSH 宿主的工具语义注册（2026-10-22）
 *
 * 母版 `core/risk.mjs` 只认语义类别；宿主方言（`write` / `pwsh` / `mcp__…`）在本文件登记。
 * 新增 DSH 工具时**只改这里**，母版不动。
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
  'list_expert_teams',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'cordis_inspect_list',
  'cordis_inspect_query',
])
