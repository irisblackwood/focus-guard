import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

// 成本台账「暂停中」标记（2026-10-29）。
//
// 病根：`usageLooksReal` 守卫拒绝假账后，卷宗【五】只剩一张空表，而章节标题仍写"自动追加"。
// 空表不会说话——读卷宗的人分不清"这阵子没用量"和"采集早就断了"。
// 本文件锁四件事：暂停时写出状态行、状态不变不重写、恢复记账自动转回、没有该节不擅自开节。
//
// 为什么用子进程：`warnedDegenerate` 是**每进程只标一次**的模块级守卫，
// 同一进程里第二次调用根本走不到标记逻辑——在进程内测幂等等于什么都没测。

const TMP = mkdtempSync(join(tmpdir(), "fg-cost-status-"));
const CASE = join(TMP, "CASE_FILE.md");
const PROBE = join(TMP, "probe.mjs");
const MODULE = pathToFileURL(join(import.meta.dirname, "..", "src", "dsh", "audit.mjs")).href;

writeFileSync(
  PROBE,
  [
    `const { appendCostRow } = await import(${JSON.stringify(MODULE)});`,
    "const [, , ts, model, input, output, cacheRead, projDir] = process.argv;",
    "appendCostRow(ts, model, false, {",
    "  input: Number(input),",
    "  output: Number(output),",
    "  cacheRead: cacheRead === 'null' ? undefined : Number(cacheRead),",
    "}, projDir || undefined);",
  ].join("\n"),
);

/** 在**新进程**里跑一次 appendCostRow，返回该进程的 stderr（warn 输出）。 */
function runProbe({ ts, model, input, output, cacheRead = null, projDir = null, env = {} }) {
  return execFileSync(
    process.execPath,
    [PROBE, ts, model, String(input), String(output), String(cacheRead), projDir || ""],
    {
      encoding: "utf8",
      env: { ...process.env, FG_CASE_FILE: CASE, FG_AUDIT_FILE: join(TMP, "audit.log"), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

const SECTION = [
  "# 卷宗",
  "",
  "### 【五】成本台账（DSH 原生插件自动追加；tokens / USD）",
  "",
  "| 时间 | 模型 | 时段 | 输入未缓存 | 缓存读 | 输出 | 成本USD |",
  "|---|---|---|---|---|---|---|",
  "",
  "> 说明：这一节由插件自动追加。",
  "",
].join("\n");

const statusOf = (text) => {
  const m = /台账状态：([^*]+)\*\*/.exec(text);
  return m ? m[1].trim() : null;
};

test("退化 usage → 写出「暂停中」，空表能自证是停摆", () => {
  writeFileSync(CASE, SECTION);
  runProbe({ ts: "2026-10-29T10:00:00.000Z", model: "unknown", input: 1, output: 1 });
  const text = readFileSync(CASE, "utf8");
  assert.equal(statusOf(text), "暂停中");
  assert.match(text, /model=unknown, input=1, output=1/, "状态行要写清为什么停");
  assert.match(text, /自动转回/, "状态行要写清怎么恢复");
  // 状态行必须在【五】节内、且在**表格之外**——插进表头与数据行之间会把 markdown 表格劈成两半，
  // 表头下面只剩一行裸文本（2026-11-09 模拟运行实测）。注只能挂节首或节尾。
  const titleAt = text.indexOf("### 【五】");
  const stAt = text.indexOf("台账状态");
  const sepAt = text.indexOf("|---|---|---|---|---|---|---|");
  assert.ok(titleAt < stAt, "状态行要在【五】标题之后");
  assert.ok(stAt < sepAt, "状态行要在表头之前（否则表格被劈开）");
  // 表格自身必须连续：分隔线之后只能是数据行（有记账）或空行（空表），
  // 出现 blockquote 就说明状态行插进了表格内部——正是这条判据要拦的形态。
  const afterSep = text.slice(sepAt).split("\n")[1];
  assert.ok(
    afterSep === "" || afterSep.startsWith("| "),
    `分隔线下一行只能是数据行或空行，实测：${afterSep.slice(0, 40)}`,
  );
});

test("已是「暂停中」→ 不重复改写（按状态名判等，不按整行）", () => {
  const before = statSync(CASE).mtimeMs;
  const beforeText = readFileSync(CASE, "utf8");
  runProbe({ ts: "2026-10-29T10:05:00.000Z", model: "unknown", input: 1, output: 1 });
  assert.equal(readFileSync(CASE, "utf8"), beforeText, "已暂停就不该再动卷宗");
  assert.equal(statSync(CASE).mtimeMs, before, "内容没变就不该动 mtime");
});

test("拿到可信 usage → 状态转回「记录中」并落行", () => {
  runProbe({ ts: "2026-10-29T10:10:00.000Z", model: "deepseek-flash", input: 1200, output: 300, cacheRead: 800 });
  const text = readFileSync(CASE, "utf8");
  assert.equal(statusOf(text), "记录中", "恢复记账后状态必须自己改回来");
  assert.match(
    text,
    /\| 2026-10-29T10:10:00\.000Z \| deepseek-flash \| 谷 \| 1200 \| 800 \| 300 \|/,
    "成本行应落表",
  );
  assert.equal((text.match(/台账状态/g) || []).length, 1, "状态行只能有一行，不能越写越多");
});

test("再次退化 → 又能转回「暂停中」（状态是现算的，不是一次性盖章）", () => {
  runProbe({ ts: "2026-10-29T10:20:00.000Z", model: "unknown", input: 1, output: 1 });
  assert.equal(statusOf(readFileSync(CASE, "utf8")), "暂停中");
});

test("卷宗里没有【五】→ 不擅自开节，也不崩", () => {
  writeFileSync(CASE, "# 卷宗\n\n### 【一】环境声明\n\n什么都没写。\n");
  assert.doesNotThrow(() =>
    runProbe({ ts: "2026-10-29T11:00:00.000Z", model: "unknown", input: 1, output: 1 }),
  );
  const text = readFileSync(CASE, "utf8");
  assert.equal(text.includes("台账状态"), false, "没有该节就不要建节");
  assert.equal(text.includes("【五】"), false);
});

// 落点必须与【一】【三】【四】同源（2026-11-08）。
//
// 病根：成本台账原用 `new URL('../../../../.ai/CASE_FILE.md', import.meta.url)` 定落点，
// 跟着**插件安装位置**走；而【一】【三】【四】都走 `projDirOf(agent)`（会话项目）。
// 开发仓里两者碰巧重合（`link:` 指向仓库自身），装到别处就分家：用户在自己项目里翻卷宗，
// 【五】永远是一张空表，成本行写进了插件目录下的另一个 `.ai/`。
test("成本行落进会话项目的卷宗，不是插件安装目录", () => {
  const proj = mkdtempSync(join(tmpdir(), "fg-cost-proj-"));
  runProbe({
    ts: "2026-11-08T10:00:00.000Z",
    model: "deepseek-flash",
    input: 900,
    output: 100,
    cacheRead: 0,
    projDir: proj,
    env: { FG_CASE_FILE: "" }, // 清掉重定向，走真实的「会话项目」分支
  });
  const landed = readFileSync(join(proj, ".ai", "CASE_FILE.md"), "utf8");
  assert.match(landed, /\| 2026-11-08T10:00:00\.000Z \| deepseek-flash \|/, "成本行应落进会话项目的卷宗");
  assert.equal(
    readFileSync(CASE, "utf8").includes("2026-11-08T10:00:00.000Z"),
    false,
    "不该再写 FG_CASE_FILE 指向的那一份",
  );
});
