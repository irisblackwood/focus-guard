import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 改动类工具分类补口（2026-10-22）
// 病根：取证闸/授权闸/批量待批只认 MUTATING_TOOL 的 8 个大写名字，真实目录里
// `mcp__cities2-mcp__write_project_file`、`plugin_manager`、`move_run`、`import_claude`、`claude_export`
// 全部被判为"非改动" → 天生免检。另：改动类工具若解析不出路径，旧行为直接放行。
// 本组用真实工具名与真实参数形状锁定：分类正确、无路径要求授权、read-only MCP 不受影响。

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-mut-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";

const { isMutatingTool, preExecuteListener } = await import("../src/dsh/pipeline.mjs");
// 2026-10-22 分层：母版只认语义，宿主工具名由适配层注册 —— 本组直接调 isMutating 前必须注册 DSH 方言。
await import("../src/adapters/dsh/tool-kinds.mjs");
const { isMutating, isReadOnlyCall } = await import("../src/core/risk.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");

test("分类：真实改动类工具全部命中", () => {
  const mutating = [
    "write",
    "Edit",
    "multiEdit",
    "mcp__cities2-mcp__write_project_file",
    "mcp__cities2-mcp__build_project",
    "mcp__cities2-mcp__package_project",
    "mcp__cities2-mcp__scaffold_project",
    "plugin_manager",
    "move_run",
    "import_claude",
    "claude_export",
  ];
  for (const t of mutating) assert.equal(isMutatingTool(t), true, `${t} 应判为改动类`);
});

test("分类：只读/协作类工具不得误判", () => {
  const readOnly = [
    "read",
    "grep",
    "mcp__cities2-mcp__read_project_file",
    "mcp__cities2-mcp__search",
    "team_task_create",
    "send_message",
    "wait_agent",
  ];
  for (const t of readOnly) assert.equal(isMutatingTool(t), false, `${t} 不应判为改动类`);
});

test("母版 risk.isMutating：小写与 MCP 写盘同样识别（ZCode 命名不回归）", () => {
  assert.equal(isMutating("Write", {}, false), true);
  assert.equal(isMutating("write", {}, false), true);
  assert.equal(isMutating("Write", {}, true), false, "handoff 语义保持");
  assert.equal(isMutating("mcp__cities2-mcp__write_project_file", {}, false), true);
  assert.equal(isMutating("mcp__cities2-mcp__read_project_file", {}, false), false);
  assert.equal(isMutating("pwsh", { command: "rm -rf ./dist" }, false), true);
});

const DIR = mkdtempSync(join(tmpdir(), "fg-mut-"));
writeFileSync(join(DIR, "a.txt"), "content\n");
const listener = preExecuteListener({ warn: () => {} });
const allow = () => ({ kind: "allow" });

function run(sid, tool, args) {
  saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {} });
  return listener(
    { sessionId: sid, name: tool, arguments: args, agent: { session: { header: { id: sid, cwd: DIR } } } },
    allow,
  );
}
test("MCP 写盘：给出 project_dir+relative_path 且文件已存在未读 → 取证闸拦", async () => {
  const sid = `mut-mcp-${process.pid}`;
  const r = await run(sid, "mcp__cities2-mcp__write_project_file", { project_dir: DIR, relative_path: "a.txt", content: "x" });
  assert.equal(r.kind, "deny");
  assert.match(String(r.reason), /取证|未读/);
  rmSync(statePath(sid), { force: true });
});

test("改动类工具无可解析路径（plugin_manager 写动作）→ 要求先授权", async () => {
  const sid = `mut-unmapped-${process.pid}`;
  // 2026-10-27：必须用真实参数形状 `target`（包名/安装 spec）。旧实现把 `target` 当文件路径，
  // 解析出一个不存在的"新文件"从而绕过本分支；现由 evidence 按工具名排除该键。
  const r = await run(sid, "plugin_manager", { action: "install_bundle", target: "@scope/pkg@1.0.0" });
  assert.equal(r.kind, "deny");
  assert.match(String(r.reason), /fg_apply|可解析/);
  rmSync(statePath(sid), { force: true });
});

test("plugin_manager 只读列举（list_*）→ 放行，不再要求路径或授权", async () => {
  for (const action of ["list_plugins", "list_bundles", "list_version_exemptions"]) {
    const sid = `mut-list-${action}-${process.pid}`;
    const r = await run(sid, "plugin_manager", { action });
    assert.notEqual(r && r.kind, "deny", `${action} 是只读动作，不应被拦`);
    rmSync(statePath(sid), { force: true });
  }
});

test("只读动作判定：list_* 只读，写动作/未知动作不算只读", () => {
  assert.equal(isReadOnlyCall("plugin_manager", { action: "list_plugins" }), true);
  assert.equal(isReadOnlyCall("plugin_manager", { action: "list_bundles" }), true);
  assert.equal(isReadOnlyCall("plugin_manager", { action: "install_bundle" }), false);
  assert.equal(isReadOnlyCall("plugin_manager", {}), false, "缺 action 一律按非只读（安全默认）");
  assert.equal(isReadOnlyCall("write", { action: "list_plugins" }), false, "未登记的工具不靠动作名放行");
});

test("显式放开 FG_MUTATION_UNMAPPED=allow → 退回旧行为（放行）", async () => {
  const sid = `mut-unmapped-allow-${process.pid}`;
  process.env.FG_MUTATION_UNMAPPED = "allow";
  const r = await run(sid, "import_claude", { path: "x.jsonl" });
  assert.notEqual(r.kind, "deny");
  delete process.env.FG_MUTATION_UNMAPPED;
  rmSync(statePath(sid), { force: true });
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
