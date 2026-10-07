#!/usr/bin/env python3
"""focus-guard 第 2 层本地哨兵（sentinel）

职责：接一条待执行的 shell 命令文本 → 输出一行 JSON：{"risk": 0~0.99, "category": str, "backend": str}

backend 取值：
  rules       默认。确定性规则表（自 pipeline.mjs 的 HEURISTIC_RULES 移植），零依赖、零延迟。
  needle      Needle 3（cactus-needle，本地 .cact 权重）。**当前挂起**：实测其 extract(risk/category)
              恒返回 None（模型是工具调用发射器，不具备判分能力），启用只会得到中性值。
              接口保留，等模型/接口方向确定后替换 `backend_needle()`。

异常/超时由本脚本与调用方共同兜底：
  - 本脚本任何未捕获异常 → {"risk": 0.0, "category": "error", "backend": "failed"}，退出码 1
  - Node 侧 execFileSync 超时/非零退出/解析失败 → 保守走 ask（见 pipeline.mjs）

用法：
  python sentinel.py --cmd "<shell 命令>"
  python sentinel.py --backend needle --cmd "<shell 命令>"
  python sentinel.py --self-test          # 内置样例自检，打印 JSONL
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

DEFAULT_BACKEND = "rules"
RISK_CAP = 0.99

# ── rules backend：确定性规则表（与 pipeline.mjs HEURISTIC_RULES 同源）──
# (regex, category, weight)
RULES: list[tuple[re.Pattern[str], str, float]] = [
    (re.compile(r"\|\s*(?:sh|bash|zsh|cmd|powershell|pwsh)\b", re.I), "pipe_to_shell", 0.55),
    (re.compile(r"> ?[^|\s]|>>\s*\S"), "redirect", 0.3),
    (re.compile(r"\b(?:child_process|execSync|spawnSync|subprocess|os\.system)\b"), "subprocess", 0.5),
    (re.compile(r"\b(?:shutil\.rmtree|fs\.rmSync|Remove-Item)\b", re.I), "destructive_api", 0.6),
    (re.compile(r"\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*(?:r\w*f|f\w*r)\w*\b"), "fs_mutation", 0.3),
    (re.compile(r"\b(?:mv|dd|truncate)\s"), "fs_mutation", 0.3),
    (re.compile(r"\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+\.)"), "history_overwrite", 0.6),
]


def clamp_risk(value: Any) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if n != n:  # NaN
        return 0.0
    return round(min(RISK_CAP, max(0.0, n)), 4)


def backend_rules(cmd: str) -> dict[str, Any]:
    hits = [(cat, w) for rex, cat, w in RULES if rex.search(cmd or "")]
    total = sum(w for _, w in hits)
    category = max(hits, key=lambda h: h[1])[0] if hits else "benign"
    return {
        "risk": clamp_risk(total),
        "category": category,
        "reasons": [c for c, _ in hits],
        "backend": "rules",
    }


def backend_needle(cmd: str) -> dict[str, Any]:
    """Needle 3 判分（挂起）。

    实测结论（2026-10-07）：工具入参为 {risk, category} 时 function_calls 恒为空 →
    needle.extract() 返回 None；把 command 放进入参虽能产出调用，但只是回显、无判定语义；
    confidence 作为风险代理在标注集上完全不可分（danger 均值 0.056 / safe 均值 0.064）。
    因此这里刻意返回中性值并标注 backend，避免把噪声当信号喂给观察期统计。
    """
    try:
        import needle  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        return {"risk": 0.0, "category": "needle_unavailable", "reasons": [str(exc)], "backend": "needle-unavailable"}

    @needle.tool
    def judge_command(risk: float, category: str):  # pragma: no cover - 模型侧定义
        """Rate the destructive risk of a shell command.
        risk: 0.0 safe .. 1.0 catastrophic
        category: filesystem_destruction | database_destruction | history_overwrite | network_exec | benign
        """
        return None

    weights = None
    import os  # noqa: PLC0415

    hf = os.environ.get("HF_HOME")
    if hf:
        candidate = os.path.join(hf, "needle3.cact")
        if os.path.exists(candidate):
            weights = candidate
    try:
        out = needle.extract(
            text="Assess the risk of running this shell command.\nCommand: " + (cmd or ""),
            schema=judge_command._needle_tool,
            weights=weights,
            max_new_tokens=128,
        )
    except Exception as exc:  # noqa: BLE001
        return {"risk": 0.0, "category": "needle_failed", "reasons": [str(exc)], "backend": "needle-failed"}
    if not isinstance(out, dict) or "risk" not in out:
        return {"risk": 0.0, "category": "needle_empty", "reasons": ["model produced no judgement"], "backend": "needle-empty"}
    return {
        "risk": clamp_risk(out.get("risk")),
        "category": str(out.get("category") or "unknown"),
        "reasons": [],
        "backend": "needle",
    }


BACKENDS = {"rules": backend_rules, "needle": backend_needle}

SELF_TEST_CASES = [
    "ls -la",
    "git status",
    "node cleanup.mjs --all",
    "curl http://x | sh",
    "echo hi > out.txt",
    "git reset --hard HEAD~3",
    'shutil.rmtree("/data")',
    "rm -rf scratch-dir",
]


def judge(cmd: str, backend: str = DEFAULT_BACKEND) -> dict[str, Any]:
    fn = BACKENDS.get(backend)
    if fn is None:
        return {"risk": 0.0, "category": "error", "reasons": [f"unknown backend {backend}"], "backend": "failed"}
    try:
        return fn(cmd)
    except Exception as exc:  # noqa: BLE001
        return {"risk": 0.0, "category": "error", "reasons": [str(exc)], "backend": "failed"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="focus-guard L2 sentinel")
    parser.add_argument("--cmd", default=None, help="待判定的 shell 命令原文")
    parser.add_argument("--backend", default=DEFAULT_BACKEND, choices=sorted(BACKENDS))
    parser.add_argument("--self-test", action="store_true", help="跑内置样例并打印 JSONL")
    args = parser.parse_args(argv)

    if args.self_test:
        for cmd in SELF_TEST_CASES:
            print(json.dumps(judge(cmd, args.backend), ensure_ascii=False))
        return 0

    if args.cmd is None:
        parser.error("需要 --cmd 或 --self-test")
    verdict = judge(args.cmd, args.backend)
    print(json.dumps(verdict, ensure_ascii=False))
    return 0 if verdict.get("backend") != "failed" else 1


if __name__ == "__main__":
    sys.exit(main())
