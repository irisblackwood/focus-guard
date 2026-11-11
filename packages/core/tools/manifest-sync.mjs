#!/usr/bin/env node
/**
 * 清单文案单点（2026-11-08）
 *
 * 为什么有这个工具：
 *   同一个插件的「名字 / 简介 / 显示名」曾经在 5 份 JSON 里各手写一遍——
 *   `packages/core/package.json`、仓库根 `marketplace.json`、
 *   `.claude-plugin/marketplace.json`、`.claude-plugin/plugin.json`、`.zcode-plugin/plugin.json`。
 *   它们不能合并（每个宿主生态各要一个固定文件名），但**内容该只有一份**。
 *   实测代价：自适应 TTL 早已从四档阶梯改成半衰期，`.zcode-plugin/plugin.json` 的简介
 *   还写着「4h~7天」；「上下文污染检测(58条)」的条号也对不上。改了代码忘改副本，
 *   这类漂移不会有任何闸门报错——因为每份副本都"自洽"。
 *
 * 真源：`packages/core/package.json` 的 `description` / `displayName` /
 *       `displayNameI18n` / `descriptionI18n`。
 *       不新开真源文件：那等于为了收敛再加一个 JSON，本末倒置。
 *
 * 边界：
 *   ① **只写各文件本来就有的字段**。没有 `displayName_i18n` 的清单不硬塞一个——
 *      不替宿主发明 schema，也不替它删字段。
 *   ② **不动 version**。版本归 `tools/version.mjs --set` 管，两个工具各写一份就是新的散乱。
 *   ③ **保留原缩进与行尾**。清单是 CRLF，`JSON.stringify` 吐 LF，写一次就留一条假改动。
 *
 * 用法：
 *   node tools/manifest-sync.mjs           # 只查，漂移即 exit 1
 *   node tools/manifest-sync.mjs --write   # 以真源为准写回副本
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const TRUTH = "packages/core/package.json";

/** 副本清单：`at` 指明文案落在顶层还是 `plugins[0]`（市场清单的形状）。 */
const COPIES = [
  { rel: "marketplace.json", at: "plugins" },
  { rel: ".claude-plugin/marketplace.json", at: "plugins" },
  { rel: ".claude-plugin/plugin.json", at: "top" },
  { rel: ".zcode-plugin/plugin.json", at: "top" },
];

/** 文案字段：真源键 → 清单键。只同步目标里**已存在**的那些。 */
const FIELDS = [
  ["description", "description"],
  ["displayName", "displayName"],
  ["displayNameI18n", "displayName_i18n"],
  ["descriptionI18n", "description_i18n"],
];

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

function targetOf(json, at) {
  return at === "plugins" ? json.plugins?.[0] : json;
}

function main() {
  const write = process.argv.includes("--write");
  const truth = readJson(TRUTH);
  const drifts = [];

  for (const { rel, at } of COPIES) {
    const path = join(ROOT, rel);
    const raw = readFileSync(path, "utf8");
    const json = JSON.parse(raw);
    const target = targetOf(json, at);
    if (!target) {
      drifts.push(`${rel}：找不到 plugins[0]，形状不对`);
      continue;
    }
    let touched = false;
    for (const [srcKey, dstKey] of FIELDS) {
      if (!(dstKey in target)) continue; // 不替宿主发明字段
      const want = truth[srcKey];
      if (want === undefined) continue;
      if (JSON.stringify(target[dstKey]) !== JSON.stringify(want)) {
        drifts.push(`${rel}  ${dstKey}`);
        target[dstKey] = want;
        touched = true;
      }
    }
    // 插件名必须一致；市场的 `name` 是市场标识，不在此列
    if (target.name !== truth.name) {
      drifts.push(`${rel}  name`);
      target.name = truth.name;
      touched = true;
    }
    if (!touched) continue;
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const after = (JSON.stringify(json, null, 2) + "\n").replace(/\n/g, eol);
    if (write && after !== raw) writeFileSync(path, after);
  }

  if (!drifts.length) {
    console.log(`✓ 清单文案与真源一致（${TRUTH}）：${COPIES.length} 份副本无漂移`);
    return 0;
  }
  const lines = drifts.map((d) => `  ✗ ${d}`).join("\n");
  if (write) {
    console.log(`✓ 已按真源写回 ${new Set(drifts.map((d) => d.split("  ")[0])).size} 份清单：\n${lines}`);
    return 0;
  }
  console.log(`✗ 清单文案与真源漂移 ${drifts.length} 处：\n${lines}\n\n  修法：node packages/core/tools/manifest-sync.mjs --write`);
  return 1;
}

process.exit(main());
