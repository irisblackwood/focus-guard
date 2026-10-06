// FocusGuard Needle 2 外判运行器 v3.0.2（总纲 3.0.0 十五·二）
//
// 实现 sentinel 的外判模型契约（--model-cmd / FG_SENTINEL_CMD）：
//   stdin 收一行 JSON {"command": "..."}
//   stdout 回一行 JSON {"verdict": "allow|flag|block", "reasons": ["..."]}
//
// 本运行器把该契约接到 Needle 2（Cactus Compute 45M 参数 / 14MB，端侧 agent 小模型，
// 工具调用与结构化 JSON 判定）的本地推理运行时——离线、零 API 成本：
//   NEEDLE2_BIN    推理可执行文件（如 cactus 运行器 / llama.cpp 的 llama-cli 等兼容 CLI）
//   NEEDLE2_MODEL  模型文件路径（14MB 级 GGUF 等格式，以运行时要求为准）
//   NEEDLE2_ARGS   额外参数（可选，空格分隔；如温度、上下文长度）
//
// 契约保证：模型未配置 / 超时 / 输出不可解析 → stderr 说明 + 非零退出，
// sentinel 侧据此静默回退内建启发式（哨兵永不因外判层故障而阻塞或放行危险命令）。

import { spawnSync } from "node:child_process";

const SYSTEM_PROMPT =
  "你是命令风险哨兵。对给定命令做三档判定：" +
  "allow=常规开发操作；flag=需注意（外发数据、持久化通道、凭据出现）；block=危险（执壳、混淆、破坏、反连）。" +
  "只输出一行 JSON：{\"verdict\":\"allow|flag|block\",\"reasons\":[\"理由\"]}，不要输出其他文字。";

function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let cmd = "";
    try {
      cmd = String(JSON.parse(raw.trim()).command || "");
    } catch {
      process.stderr.write("[needle2-sentinel]输入不是合法 JSON 契约。\n");
      process.exit(3);
    }
    const bin = process.env.NEEDLE2_BIN || "";
    const model = process.env.NEEDLE2_MODEL || "";
    if (!bin || !model) {
      process.stderr.write("[needle2-sentinel]NEEDLE2_BIN / NEEDLE2_MODEL 未配置——外判跳过，由 sentinel 启发式兜底。\n");
      process.exit(3);
    }
    const extra = (process.env.NEEDLE2_ARGS || "").split(" ").filter(Boolean);
    const prompt = `${SYSTEM_PROMPT}\n命令：${cmd}`;
    const p = spawnSync(bin, [...extra, "-m", model, "-p", prompt], {
      encoding: "utf8",
      timeout: 5000,
      shell: process.platform === "win32",
    });
    const text = String(p.stdout || "");
    const m = text.match(/\{[\s\S]*\}/); // 模型输出中提取首个 JSON 对象
    if (!m) {
      process.stderr.write("[needle2-sentinel]模型输出不含 JSON，外判失败。\n");
      process.exit(3);
    }
    try {
      const v = JSON.parse(m[0]);
      if (!["allow", "flag", "block"].includes(v.verdict)) throw new Error("bad verdict");
      process.stdout.write(
        JSON.stringify({ verdict: v.verdict, reasons: (v.reasons || []).map(String).slice(0, 5) }) + "\n"
      );
    } catch {
      process.stderr.write("[needle2-sentinel]模型 JSON 解析失败，外判失败。\n");
      process.exit(3);
    }
  });
}

main();
