// FocusGuard 积木图书馆 ↔ OpenViking 同步桥 v3.0.2（总纲 3.0.0 十五·二）
//
// 把 .ai/output/library/ 的派生积木同步到 OpenViking（火山引擎开源的 Agent 上下文数据库，
// viking:// 虚拟文件系统）的 resources 作用域：
//   viking://resources/focus-guard-library/<积木文件>
//
// 对接真实 API（OpenViking 0.4.23，docs/zh/api/03-filesystem.md 与 12-content.md）：
//   POST /api/v1/fs/mkdir          {uri, description}
//   POST /api/v1/content/batch-write {root_uri, operations:[{uri, content, mode:"upsert"}], wait}
//   认证：X-API-Key 头；服务端默认 http://localhost:1933
//
// 两种用法：
//   1. 导出（默认）：生成 viking-import.json（batch-write 载荷）并打印等价的 ov 命令，
//      适合离线审阅后手工导入；
//   2. 直推：--push 通过 OPENVIKING_URL（默认 http://localhost:1933）与 OPENVIKING_API_KEY
//      直接同步（Node 18+ 原生 fetch，零依赖）。积木不可变（动静隔离），重复同步按 upsert 幂等。
//
// 阅读侧：OpenViking 侧可用 viking:// URI 语义检索积木；FocusGuard 侧引用仍以积木号
// （[经验:B003]）为准——图书馆是唯一事实源，OpenViking 是检索投影。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const ROOT_URI = "viking://resources/focus-guard-library";

// 解析 INDEX.md 积木清单 → [{id, file, title, sha, src}]
export function parseIndex(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.startsWith("| B")) continue;
    const c = line.split("|").map((x) => x.trim());
    // | id | 积木 | 标题 | sha256 | 源 | 状态 |
    if (c.length >= 7 && /^B\d+$/.test(c[1])) {
      rows.push({ id: c[1], file: c[2], title: c[3], sha: c[4], src: c[5] });
    }
  }
  return rows;
}

// 组装 batch-write 载荷（retired 积木跳过——源已移除，不向知识库投影陈旧块）
export function toOperations(rootUri, blocks, readContent) {
  const operations = [];
  for (const b of blocks) {
    if (!b.file || !b.file.endsWith(".md")) continue;
    const content = readContent(b.file);
    if (content == null) continue; // 积木文件缺失：跳过并在 stderr 告警
    operations.push({ uri: `${rootUri}/${b.file}`, content, mode: "upsert" });
  }
  return { root_uri: rootUri, operations, wait: true };
}

function main(argv) {
  const libDir = argv.includes("--lib") ? argv[argv.indexOf("--lib") + 1] : ".ai/output/library";
  const push = argv.includes("--push");
  const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "viking-import.json";
  const indexPath = join(libDir, "INDEX.md");
  if (!existsSync(indexPath)) {
    console.error(`viking-bridge：未找到 ${indexPath}——先运行 library-build 构建积木图书馆。`);
    process.exit(1);
  }
  const blocks = parseIndex(readFileSync(indexPath, "utf8"));
  const readContent = (file) => {
    try {
      return readFileSync(join(libDir, file), "utf8");
    } catch {
      process.stderr.write(`[viking-bridge]积木文件缺失，跳过：${file}\n`);
      return null;
    }
  };
  const payload = toOperations(ROOT_URI, blocks, readContent);

  if (!push) {
    writeFileSync(out, JSON.stringify(payload, null, 2), "utf8");
    console.log(`viking-bridge：已导出 ${payload.operations.length} 块 → ${out}`);
    console.log("手工导入（OpenViking 侧）：");
    console.log(`  ov mkdir ${ROOT_URI}/ --description "FocusGuard 静态知识图书馆积木"`);
    console.log(`  curl -X POST $OPENVIKING_URL/api/v1/content/batch-write -H "Content-Type: application/json" -H "X-API-Key: $OPENVIKING_API_KEY" --data @${out}`);
    return;
  }

  const base = (process.env.OPENVIKING_URL || "http://localhost:1933").replace(/\/+$/, "");
  const key = process.env.OPENVIKING_API_KEY || "";
  if (!key) {
    console.error("viking-bridge：--push 需要 OPENVIKING_API_KEY 环境变量。");
    process.exit(1);
  }
  const headers = { "Content-Type": "application/json", "X-API-Key": key };
  (async () => {
    const m = await fetch(`${base}/api/v1/fs/mkdir`, {
      method: "POST",
      headers,
      body: JSON.stringify({ uri: `${ROOT_URI}/`, description: "FocusGuard 静态知识图书馆积木（动静隔离，只读投影）" }),
    });
    if (!m.ok && m.status !== 409) {
      console.error(`viking-bridge：mkdir 失败 ${m.status} ${await m.text().catch(() => "")}`);
      process.exit(1);
    }
    const r = await fetch(`${base}/api/v1/content/batch-write`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`viking-bridge：batch-write 失败 ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
      process.exit(1);
    }
    const res = body.result || {};
    console.log(`viking-bridge：同步完成 新建=${(res.created || []).length} 更新=${(res.updated || []).length} 不变=${(res.unchanged || []).length} → ${ROOT_URI}`);
  })().catch((e) => {
    console.error(`viking-bridge：推送失败（${e.message}）——服务端未启动可用导出模式手工导入。`);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main(process.argv.slice(2));
}
