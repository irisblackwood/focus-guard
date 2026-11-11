// 用系统默认程序打开一个文件（2026-11-08）
//
// 为什么单独一个文件：`brain.mjs`（模板版）与 `brain-cosmic.mjs`（本地皮层版）
// 都要「生成完顺手打开」。同一个三行分支抄两遍，下一次改平台适配就会只改一处——
// 重复块是这么长出来的，不是一开始就想抄。
//
// 用 detached + unref：启动器是 GUI 进程，不该把 CLI 挂着等它退出。
// 打不开不抛错：headless / 无关联程序的环境里这是常态，不是故障；
// 调用方在输出里已经给了绝对路径，兜底靠那一行。

import { spawn } from "node:child_process";

/**
 * @param {string} file 绝对路径
 * @returns {boolean} 是否成功发起（不代表对方一定打开）
 */
export function openInBrowser(file) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", file]]
      : process.platform === "darwin"
        ? ["open", [file]]
        : ["xdg-open", [file]];
  try {
    const p = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    p.on("error", () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}
