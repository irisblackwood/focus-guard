import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 等变测试（invariance，2026-10-22）：同一个危险动作换六种写法，判定必须一致。
// 病根：判定常常只对"作者想到的那一种形态"生效（绝对路径拦、相对路径过；read 拦、read_file 过）。
// 等变测试不看实现，只看「语义等价 ⇒ 判定等价」。

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-inv-audit-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";

const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");

const DIR = mkdtempSync(join(tmpdir(), "fg-inv-"));
mkdirSync(join(DIR, "sub"), { recursive: true });
writeFileSync(join(DIR, "sub", "big.mjs"), Array.from({ length: 420 }, (_, i) => `// l${i + 1}`).join("\n"));
writeFileSync(join(DIR, "README.md"), "# readme\n");
const BIG = join(DIR, "sub", "big.mjs");

const listener = preExecuteListener({ warn: () => {} });
const allow = () => ({ kind: "allow" });
let seq = 0;

async function verdict(tool, args, seeded = true) {
  const sid = `inv-${process.pid}-${(seq += 1)}`;
  if (seeded) saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {} });
  const r = await listener(
    { sessionId: sid, name: tool, arguments: args, agent: { session: { header: { id: sid, cwd: DIR } } } },
    allow,
  );
  rmSync(statePath(sid), { force: true });
  return (r && r.kind) || "allow";
}

test("整读大文件：绝对/相对/工具名变体 → 一律 deny", async () => {
  const variants = [
    ["read", { file_path: BIG }],
    ["read", { file_path: "sub/big.mjs" }],
    ["Read", { file_path: join(DIR, "sub", "big.mjs") }],
    ["read_file", { file_path: "sub/big.mjs" }],
  ];
  for (const [tool, args] of variants) {
    assert.equal(await verdict(tool, args), "deny", `${tool} ${JSON.stringify(args)} 应被拦`);
  }
});

test("盲写已存在文件：六种等价写法 → 一律 deny", async () => {
  const variants = [
    ["pwsh", { command: `Add-Content -Path '${join(DIR, "README.md")}' -Value x` }],
    ["pwsh", { command: `Set-Content '${join(DIR, "README.md")}' 'x'` }],
    ["pwsh", { command: `"x" | Out-File '${join(DIR, "README.md")}'` }],
    ["pwsh", { command: `"x" | Tee-Object -FilePath '${join(DIR, "README.md")}'` }],
    ["pwsh", { command: `"x" > '${join(DIR, "README.md")}'` }],
    ["pwsh", { command: `Add-Content -Path README.md -Value x` }],
  ];
  for (const [tool, args] of variants) {
    assert.equal(await verdict(tool, args), "deny", `${args.command} 应被拦`);
  }
});

test("数据库破坏：psql/mysql 写法 → 一律 deny", async () => {
  const variants = [
    ["pwsh", { command: "psql -c 'DROP DATABASE prod'" }],
    ["bash", { command: "psql -c 'drop database prod'" }],
    ["pwsh", { command: 'mysql -e "drop database prod"' }],
  ];
  for (const [tool, args] of variants) {
    assert.equal(await verdict(tool, args), "deny", `${args.command} 应被拦`);
  }
});

test("表级破坏：DROP TABLE / TRUNCATE 各种写法 → 一律 deny（2026-10-22 补红线）", async () => {
  // 等变矩阵最初把这条钉成「已知缺口」；人类批示后补进 ABSOLUTE_REDLINES，
  // 现在它必须与 DROP DATABASE 同档拦截。
  const variants = [
    ["pwsh", { command: "sqlite3 db 'DROP TABLE users'" }],
    ["pwsh", { command: "sqlite3 db 'drop table users'" }],
    ["pwsh", { command: "psql -c 'TRUNCATE TABLE events'" }],
    ["pwsh", { command: "mysql -e 'DROP TABLE orders'" }],
  ];
  for (const [tool, args] of variants) {
    assert.equal(await verdict(tool, args), "deny", `${args.command} 应被拦`);
  }
});

test("发布动作：npm/yarn/pnpm 写法 → 一律需要授权", async () => {
  const variants = [
    ["pwsh", { command: "npm publish --access public" }],
    ["pwsh", { command: "npm publish --dry-run" }],
    ["bash", { command: "yarn publish" }],
    ["pwsh", { command: "pnpm publish --no-git-checks" }],
  ];
  for (const [tool, args] of variants) {
    assert.equal(await verdict(tool, args), "deny", `${args.command} 应被拦`);
  }
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
