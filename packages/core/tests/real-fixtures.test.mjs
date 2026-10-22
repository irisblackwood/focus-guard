import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// 真实调用回归（2026-10-22）：直接吃 `tools/capture-fixtures.mjs` 从**真实会话**导出的夹具。
// 纪律：本文件的输入不得手写；只允许跳过"依赖会话状态"的样本（取证闸第二次即放行那类）。
// 这样"实现作者手写参数"这条自欺路径就被堵死了。

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "real-calls");

process.env.FG_AUDIT_FILE = join(tmpdir(), `fg-real-fx-${process.pid}-${Date.now()}.log`);
process.env.FG_SHELL = "";

const { preExecuteListener } = await import("../src/dsh/pipeline.mjs");
const { statePath, saveState } = await import("../src/core/state.mjs");

// 只断言"判定与状态无关"的那几类；带「取证记录」字样的样本依赖同会话 readSet，跳过。
const DETERMINISTIC = /整文件闸|绝对红线|write-system-path|publish|Grep 未收窄|本机环境|整读/;
const STATE_DEPENDENT = /取证记录|状态校验|熔断|降权/;

if (!existsSync(FIXTURES)) {
  test("真实夹具目录缺失（先跑 capture-fixtures）", { skip: true }, () => {});
} else {
  const files = readdirSync(FIXTURES).filter((f) => f.startsWith("call-") && f.endsWith(".json"));
  const all = files.map((f) => JSON.parse(readFileSync(join(FIXTURES, f), "utf8")));
  const cases = all
    .filter((fx) => fx.verdict === "deny")
    .filter((fx) => DETERMINISTIC.test(String(fx.reason || "")))
    .filter((fx) => !STATE_DEPENDENT.test(String(fx.reason || "")))
    .slice(0, 40);

  test(`真实夹具：${cases.length} 条确定性 deny 样本重放仍须 deny（共 ${all.length} 条夹具）`, async () => {
    assert.ok(cases.length >= 5, `确定性样本太少（${cases.length}），夹具可能过期，请重跑 capture-fixtures`);
    const listener = preExecuteListener({ warn: () => {} });
    const misses = [];
    let i = 0;
    for (const fx of cases) {
      const sid = `fx-${process.pid}-${(i += 1)}`;
      saveState(statePath(sid), { fused: false, probation: false, readSet: {}, caseCache: {} });
      const r = await listener(
        {
          sessionId: sid,
          name: fx.tool,
          arguments: fx.args,
          agent: { session: { header: { id: sid, cwd: "E:\\DSH\\focus-guard-main" } } },
        },
        () => ({ kind: "allow" }),
      );
      const kind = (r && r.kind) || "allow";
      if (kind === "allow") misses.push(`${fx.tool} ${JSON.stringify(fx.args).slice(0, 80)} ← 来源 ${fx.source.session}`);
      try {
        const { rmSync } = await import("node:fs");
        rmSync(statePath(sid), { force: true });
      } catch {}
    }
    assert.deepEqual(misses, [], `这些真实被拦的调用现在放行了（漏拦回归）：\n${misses.join("\n")}`);
  });
}
