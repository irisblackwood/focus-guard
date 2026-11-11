// 卷宗转义往返（2026-11-07）
//
// 起因：`.ai/CASE_FILE.md` 涨到 347 MB / 202 行，平均一行 1.7 MB。
// 根因不是行数（`CASE_MAX_ROWS` 早就封在 200），是 `cell()` 转义没有配对的反转义：
// `loadCaseRecords` 把**已转义**的文本当原值读回，`saveCaseRecords` 再转义一遍，
// 每保存一次反斜杠翻一倍（`C:\` → `C:\\` → `C:\\\\` …）——指数项，跑几十次就是 GB 级。
//
// 本文件只锁一条红路径：同一份记录连存三次，文件不得长大、路径不得变形。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCaseRecords, saveCaseRecords, casePath, fingerprint } from "../src/core/state.mjs";

test("卷宗往返：连存三次体积不变、路径还原", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-case-esc-"));
  try {
    const winPath = "C:\\Users\\tester\\AppData\\Local\\Temp\\a.txt";
    const rec = {
      path: winPath,
      readAt: Date.now(),
      mtime: 1,
      size: 3,
      sha: "abc",
      changes: 0,
      lastChange: 0,
      ttlOverride: "",
      via: "mtime+size",
    };

    saveCaseRecords(dir, { [winPath]: rec });
    const first = statSync(casePath(dir)).size;

    // 读回 → 再存，模拟真实调用序列（postProgress 每次都是 load 后 save）
    saveCaseRecords(dir, loadCaseRecords(casePath(dir)));
    saveCaseRecords(dir, loadCaseRecords(casePath(dir)));
    const third = statSync(casePath(dir)).size;

    assert.equal(third, first, `连存三次体积应稳定，实测 ${first} → ${third} 字节`);

    const back = loadCaseRecords(casePath(dir));
    // 2026-11-08：表格里路径统一存正斜杠——既省一半字符（`\\` 是转义出来的假字符），
    // 也让 Windows / POSIX 两种写法在卷宗里长得一样。Node 在 Windows 上认正斜杠，不影响 stat。
    assert.equal(Object.values(back)[0].path, winPath.replace(/\\/g, "/"), "路径必须原样还原（正斜杠归一）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-11-11 补：`\|` 必须在 split **之前**保护，否则含竖线的单元格整行被丢。
//
// 起因：`cell()` 把路径里的 `|` 写成 `\|`，而 `loadCaseRecords` 先 `line.split("|")`
// 再对 c[7] 做 `uncell`——顺序反了，`\|` 照样被劈开，列数 10≠9 → 整行 continue 掉。
// 后果不是报错，是**静默丢行**：该文件永远进不了 caseCache，免重读失效，每次重读都烧 token。
// POSIX 文件名合法含 `|`（Windows 不可能），所以这是跨平台潜在缺陷而非本机现象。
test("卷宗往返：含竖线的路径必须能读回（转义先保护再切列）", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-case-pipe-"));
  try {
    const posixPath = "/tmp/a|b/c.mjs";
    saveCaseRecords(dir, {
      [posixPath]: { path: posixPath, readAt: Date.now(), mtime: 1, size: 3, sha: "abc", changes: 0 },
    });
    const back = loadCaseRecords(casePath(dir));
    assert.equal(Object.values(back).length, 1, "含 `|` 的行不得被列数校验丢掉");
    assert.equal(Object.values(back)[0].path, posixPath, "竖线必须原样还原");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-11-08 补：毫秒取整口径必须与 `Date` 一致（截断），否则免重读会随机失效。
//
// 起因：`fingerprint` 一度用 `Math.round(st.mtimeMs)`。Windows 上 mtimeMs 的小数尾巴
// 集中在 .66 左右（实测 `…043.6836`），round 进位成 `…044`；而卷宗里存的是
// `new Date(ms).toISOString()`（TimeClip 截断）→ `…043`。差 1ms，`casefileChanged`
// 永远判"文件变了"，两个提示分支都进不去。手写卷宗/外部工具写的时间串全中招。
// 这里用带小数的秒数写 mtime，稳定造出小数毫秒，不靠运气。
test("指纹毫秒取整与 Date 截断一致（否则卷宗里的时间串永远对不上）", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg-case-fp-"));
  try {
    const f = join(dir, "doc.txt");
    writeFileSync(f, "v1\n");
    utimesSync(f, 1794132461.6836, 1794132461.6836); // mtimeMs ≈ …683.6
    const ms = statSync(f).mtimeMs;
    assert.ok(ms % 1 > 0.5, `夹具应造出小数尾巴 > .5，实测 ${ms}`);
    assert.equal(
      fingerprint(f).mtime,
      Date.parse(new Date(ms).toISOString()),
      "取整方式必须与 Date 的截断一致，否则 ISO 时间串写进去就再也读不回来"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
