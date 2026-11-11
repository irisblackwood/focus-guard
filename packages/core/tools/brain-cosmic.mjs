#!/usr/bin/env node
/**
 * 本地皮层版脑的入口（2026-11-08）
 *
 * 为什么有这个文件：
 *   磁盘上那个 6.3 MB 的脑（带真 PLY 皮层网格）由 `.focus-guard/viz/build-brain2.mjs` 生成，
 *   而那个生成器**在隐藏目录里、被 `.git/info/exclude` 排除**——官方 `npm run brain`
 *   产出的是模板版（481 KB），两者不是同一个东西。
 *   结果是：看着最顺眼的那版，恰恰是唯一没有入口、也从未进过仓库的那版。
 *
 * 边界（硬性）：
 *   ① **不把资产搬进版本库**。皮层数据来自 `memory-brain`，是 CC BY-SA 3.0；
 *      把它请进公开仓库等于替使用者接下一份传染性授权，这个决定不该由工具悄悄做。
 *   ② **对没装资产的人不报错成崩溃**。文件不在就明说"这是本地实验产物"，exit 1 收工。
 *   ③ **不改判定**。只读审计、只写自己的 HTML，与 `brain.mjs` 同一口径。
 *
 * 用法：
 *   npm run brain:cosmic        # 用本地皮层版生成 → .focus-guard/brain.html，并打开
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openInBrowser } from "./lib/open.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const BUILDER = join(REPO, ".focus-guard", "viz", "build-brain2.mjs");
const OUT = join(REPO, ".focus-guard", "brain.html");

if (!existsSync(BUILDER)) {
  process.stderr.write(
    `找不到本地皮层版生成器：${BUILDER}\n` +
      `  它是本地实验产物，不入版本库（皮层数据为 CC BY-SA 3.0，不随仓库分发）。\n` +
      `  换官方模板版：npm run brain\n`,
  );
  process.exit(1);
}

await import(pathToFileURL(BUILDER).href);

process.stdout.write(`脑已更新：${pathToFileURL(OUT).href}\n  已请求用默认程序打开（没弹窗就点上面那个地址）\n`);
openInBrowser(OUT);
