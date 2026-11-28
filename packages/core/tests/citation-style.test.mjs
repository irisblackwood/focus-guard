import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const { checkCitationStyle } = await import("../tools/lib/docs-core.mjs");

// 文档不得写「谁说的」（2026-11-28 扩表 + 扩范围）
//
// 规矩原就写在 `docs-core.mjs` 里：决策只写**规则 + 日期**，主语省略，原话归 HANDOFF。
// 但闸门有两个洞，2026-11-28 同时补上：
//   ① 词表只列了「批示 / 原话 / 报告」三种搭配 →「人类提议」「人类建议」「人类要求」
//      一路放行。CHANGELOG 与三份包内文档各躺着一处，闸门全绿。
//   ② 范围只认根目录 `docs/` → `packages/core/docs/` 下 60 多处从没扫过，
//      而 RULES / ARCH-MAP / THREAT-MODEL 这些权威文档全在那里。
//
// 本文件同时钉住**不该被拦的**：扩表第一次就误伤了 4 处术语
// （「待人类拍板」「需人类确认」「人类新指令即批示」「人类指令=批示」）。
// 闸门误伤的代价比漏报更高——被误伤的人会去加白名单，加着加着闸门就空了。
//
// 夹具用**非 git 临时目录**：`listMarkdownFiles` 优先枚举入库文件（保证 STATUS 可复现），
// 非 git 目录才回落磁盘遍历。用真仓库造夹具会被「未跟踪 = 不存在」骗过去，测不出范围。

const fixture = (files) => {
  const root = mkdtempSync(join(tmpdir(), "fg-citation-"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf8");
  }
  return root;
};

const hits = (root) => checkCitationStyle(root).map((f) => `${f.file}:${f.line}`);

test("引述人类主张的写法一律判违规", () => {
  const root = fixture({
    "CHANGELOG.md": "# 变更\n\n- 起因：人类建议把参数解析改表驱动。\n",
    "docs/a.md": "## 甲\n\n> 2026-10-30 人类提议用 hook 排序。\n",
    "packages/core/docs/b.md": "## 乙\n\n> 2026-10-30 人类要求（原话）：「记忆独立成模块」。\n",
  });
  try {
    const got = hits(root);
    assert.deepEqual(got.sort(), ["CHANGELOG.md:3", "docs/a.md:3", "packages/core/docs/b.md:3"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("包内权威文档也在范围内（packages/core/docs）", () => {
  const root = fixture({
    "packages/core/docs/RULES.md": "## 法条\n\n- 本条是 2026-11-01 人类原话。\n",
    "packages/core/docs/THREAT-MODEL.md": "> 判据定于 2026-11-01 人类定的原话：不防攻击者。\n",
  });
  try {
    assert.deepEqual(hits(root).sort(), [
      "packages/core/docs/RULES.md:3",
      "packages/core/docs/THREAT-MODEL.md:1",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("权限术语与法条定义不判违规（扩表时的误伤面）", () => {
  const root = fixture({
    // 流程术语：谁有权批，不是引用谁说了什么
    "packages/core/docs/RELEASE-POLICY.md": "## 发版\n\n- 触发条件：满 30 条 / 严重缺陷 / 人类拍板。\n",
    "packages/core/docs/PROFILE-TUNING.md": "## 流程\n\n1. 参数改动须人类确认后手动改。\n",
    // 法条定义：这里的「批示」是被定义的对象，不是引文
    "packages/core/docs/RULES.md": "## 硬线\n\n- ⑤人类指令=批示，受权即解除。\n",
    "docs/ARCHITECTURE.md": "## 熔断\n\n- 人类新指令即\"批示\"、全部解除。\n",
    // 角色描述
    "docs/ARCHITECTURE.md2": "## 层\n\n- L6 上报人类；人类在终端批准该次操作。\n",
  });
  try {
    assert.deepEqual(hits(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("归档与私有目录不纳入（不逼后人改历史）", () => {
  const root = fixture({
    "docs/archive/HANDOFF.md": "> 首行按人类要求写入英文条目。\n",
    ".workbuddy/memory/log.md": "> 人类建议这么做。\n",
  });
  try {
    assert.deepEqual(hits(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
