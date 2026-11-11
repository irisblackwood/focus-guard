import { test, describe } from "node:test";
import assert from "node:assert/strict";

// 平台执行体探测与双向语法纠正（2026-11-09）
//
// 起因：DSH 的 Bash 工具执行 `["bash","-c",cmd]`（@deepseek-ai/dsh-bash-local），
// 而 `platformBashViolation` 只写了「bash 语法进了 PowerShell」这一半，
// 反向（PowerShell cmdlet 进了 bash）完全空缺——命令必然 command not found，FG 一声不吭。
// 同时 `expectedShellId()` 在 win32 上恒返回 'powershell'，把一个从未核对的假定写成了事实。
const { probeShells, platformBashViolation } = await import("../src/core/env.mjs");

describe("执行体探测", () => {
  test("扫 PATH 而不是拼安装路径：本机 pwsh 不在默认目录也能探到", () => {
    const shells = probeShells();
    assert.ok(Array.isArray(shells) && shells.length > 0, "至少要探到一个执行体");
    // cmd 是 Windows 的兜底，任何 win32 机器都有；非 win32 则不该出现。
    if (process.platform === "win32") assert.ok(shells.includes("cmd"), "win32 必须有 cmd 兜底");
    else assert.ok(!shells.includes("cmd"), "非 win32 不该出现 cmd");
    // 顺序即推荐顺序：pwsh7（若有）排在 powershell 之前
    const i7 = shells.indexOf("pwsh7");
    const i5 = shells.indexOf("powershell");
    if (i7 >= 0 && i5 >= 0) assert.ok(i7 < i5, "pwsh7 应排在 powershell 之前");
  });
});

describe("win32 + bash 的 PowerShell 语法拦截", () => {
  const env = {
    os: "win32",
    osLabel: "Windows/x64",
    shellIdKey: "bash",
    // 详情形状（2026-11-09 起）：id + origin。文案要区分自带/额外，模型才知道该不该建议"去装一个"。
    shells: [
      { id: "pwsh7", exe: "pwsh", origin: "extra" },
      { id: "powershell", exe: "powershell", origin: "builtin" },
      { id: "bash", exe: "bash", origin: "extra" },
      { id: "cmd", exe: "cmd", origin: "builtin" },
    ],
  };

  test("PowerShell cmdlet 进 bash → 拦，且提示里带本机实际可用的执行体", () => {
    const v = platformBashViolation(env, "Get-Content README.md");
    assert.ok(v, "Get-Content 在 bash 里不存在，必须拦");
    assert.match(v, /Get-Content/, "要点名是哪个 cmdlet");
    assert.match(v, /pwsh7/, "要告诉它本机能用什么");
    assert.match(v, /bash 等价写法/, "要给替代写法，不能只说不行");
  });

  test("bash 语法在 bash 里 → 不误伤", () => {
    assert.equal(platformBashViolation(env, "ls -la && cat README.md | head -5"), null);
  });
});

describe("BSD 规则按实际实现判，不按 OS 猜", () => {
  // 2026-11-09：原来只看 `os === 'darwin'`。macOS 上 `brew install gnu-sed` 之后
  // `sed -i` 就是 GNU 语义，按 OS 硬推会把合法写法误判；反过来也一样。
  test("macOS + GNU sed → 不报 BSD 后缀错误", () => {
    const env = { os: "darwin", shellIdKey: "zsh", commands: { sed: { impl: "gnu" }, grep: { impl: "gnu" } } };
    assert.equal(platformBashViolation(env, "sed -i.bak 's/a/b/' x.txt"), null);
  });

  test("macOS + BSD sed → 报", () => {
    const env = { os: "darwin", shellIdKey: "zsh", commands: { sed: { impl: "bsd" }, grep: { impl: "bsd" } } };
    assert.ok(platformBashViolation(env, "sed -i.bak 's/a/b/' x.txt"));
  });
});
