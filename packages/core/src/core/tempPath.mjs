// 临时状态目录（2026-11-01，缺陷 P0-1）
//
// 病根：状态文件原先平铺在 `tmpdir()` 根下。730 个测试每个写一份且不删，实测 11,856 个条目
// 堆在 %TEMP% 根目录——资源管理器打开即卡死，而 `cleanStaleTemp` 每次会话启动还要对它们
// 逐个 `statSync`（≈1.2 万次，纯浪费且随文件数线性增长）。
//
// 修法：独立子目录。%TEMP% 根只多 1 个条目，FG 只扫自己的目录。
// `FG_STATE_DIR` 供测试重定向到一次性目录——与 `FG_AUDIT_FILE`（audit.mjs）、
// `FG_CASE_FILE`（state.mjs::casePath）同一口径，此前唯独状态文件没有覆盖口。
//
// 独立成文件而不是塞进 constants.mjs：那边自我声明「纯数据：无逻辑、无外部依赖」，
// 加函数会破坏该契约；放 state.mjs 又会让 audit.mjs 反向依赖它，形成循环导入。
//
// 2026-11-01（P0-1 补②）：目录权限显式 0o700（建目录处见 state.mjs::saveState 与 audit.mjs）。
// 原 mkdirSync 用默认 mode（POSIX 上 0o755），而状态文件里装的是 `fused` / `probation` /
// `rejectedCmds`——**熔断决定的输入**。落在共享 /tmp 时可被同机其他用户读取（CWE-377）。
// Windows 忽略 mode，无害。
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function stateDir() {
  return process.env.FG_STATE_DIR || join(tmpdir(), 'focus-guard')
}
