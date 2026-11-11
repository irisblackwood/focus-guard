#!/usr/bin/env node
/**
 * 脑的**唯一入口**（2026-11-11 起）
 *
 * 两件事，按顺序：
 *   ① 数据层先跑（`brain.mjs --data-only`）——更新索引与出图数据，不写模板版 HTML；
 *   ② 有皮层资产就用皮层版渲染，没有就退回模板版。
 *
 * 为什么改成这样：此前 `brain` 与 `brain:cosmic` 是两个入口，默认那个出模板版（沟回 + 法线光照），
 * 皮层版另走一条。结果两版**各喂各的数据**——皮层版读的 `brain-data.json` 没有任何脚本在写，
 * 是某次手工导出的静态快照，审计日志天天长，它的节点却停在导出那天。
 * 看着最顺眼的那版，恰恰是唯一不接活数据的。现在数据只有一条链，两版永远是同一颗脑。
 *
 * 边界（硬性）：
 *   ① **不把资产搬进版本库**。皮层数据来自 `memory-brain`，CC BY-SA 3.0；
 *      请进公开仓库等于替使用者接下一份传染性授权，这个决定不该由工具悄悄做。
 *   ② **没资产不报错**。回退模板版而不是 exit 1——用户要的是"看到脑"，
 *      不是"知道有个更高级的版本自己装不起"。资产的有无在输出里如实说。
 *   ③ **不改判定**。只读审计、只写自己的 HTML，与 `brain.mjs` 同一口径。
 *
 * 用法：
 *   npm run brain            # 增量重算 → 渲染 → 打开
 *   npm run brain:build      # 同上，不打开（脚本 / 无桌面环境）
 *   npm run brain:cosmic     # 强制皮层版：没资产就明说并 exit 1（给有资产的人确认用）
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openInBrowser } from "./lib/open.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const BUILDER = join(REPO, ".focus-guard", "viz", "build-brain2.mjs");
const OUT = join(REPO, ".focus-guard", "brain.html");

const quiet = process.argv.includes("--quiet");
const strict = process.argv.includes("--strict");

const hasAsset = existsSync(BUILDER);
if (!hasAsset && strict) {
  process.stderr.write(
    `找不到本地皮层版生成器：${BUILDER}\n` +
      `  它是本地实验产物，不入版本库（皮层数据为 CC BY-SA 3.0，不随仓库分发）。\n` +
      `  换默认入口：npm run brain（没资产时自动用模板版）\n`,
  );
  process.exit(1);
}

/* 两条路各 import 一次 `brain.mjs`——**不能**先 data-only 再完整跑一遍：
   ESM 模块只执行一次，第二次 import 拿到的是缓存，什么也不会发生。 */
if (hasAsset) {
  process.argv.push("--data-only");
  await import("./brain.mjs");
  await import(pathToFileURL(BUILDER).href);
} else {
  await import("./brain.mjs");
}

process.stdout.write(`脑已更新：${pathToFileURL(OUT).href}\n`);
if (hasAsset) process.stdout.write("  皮层版（真 PLY 网格）\n");
else process.stdout.write("  模板版（未找到皮层资产，形状由程序化沟回撑住）\n");
if (!quiet) {
  process.stdout.write("  已请求用默认程序打开（没弹窗就点上面那个地址）\n");
  openInBrowser(OUT);
}
