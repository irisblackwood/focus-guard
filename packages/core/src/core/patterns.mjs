// FocusGuard 母版层 · PATTERNS 经验库写入（2026-11-03）
//
// 为什么有这个模块：`.ai/PATTERNS.md` 建库 27 天（2026-10-07 → 2026-11-03）**零条**。
// 实测三处引用、零个追加点：两个写入点都是"不存在才建"，第三处只是提示词里一句承诺。
// 经验固化因此全靠模型自觉，而模型从不主动回写——**有入口、没出口**。
//
// 纪律（分层治理第四层的落地）：
//   引擎只写**事实**（时间 / 环境 / 触发 / 证据），**判断留给模型**。
//   理由：教训该记什么需要判断，引擎替模型写结论就是伪造经验；
//   但"发生过一次熔断"是事实，引擎不写就永远丢失。
//
// 本模块不判断"该不该记"，只保证**骨架一定在**。模型补「教训」那一行。

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 建库时的头部。原先写死「（79条）」——空库自称有 79 条经验，数字无人维护，已删。 */
export const PATTERNS_HEADER =
  "# PATTERNS 经验库\n\n> 格式：[环境:OS] [任务:类型] 以后遇到 X 必须先做 Y。熔断/返工后由 AI 追加；新任务不预读，卡点时 Grep 检索。\n";

/** 经验库路径（项目级，不是用户级）。 */
export function patternsPath(projDir) {
  return join(projDir, ".ai", "PATTERNS.md");
}

/** 确保文件存在；返回是否本次新建。顺带清理旧头部里的死数字。 */
export function ensurePatterns(projDir) {
  const pat = patternsPath(projDir);
  if (existsSync(pat)) {
    normalizeHeader(pat);
    return false;
  }
  mkdirSync(join(projDir, ".ai"), { recursive: true });
  writeFileSync(pat, PATTERNS_HEADER);
  return true;
}

/**
 * 旧头部残留「（79条）」的清理。
 *
 * 常量早就不写这个数字了，但 `ensurePatterns` 是「不存在才建」——已建好的库永远停在旧头部，
 * 于是空库继续对外声称有 79 条经验。判据：文件里的存量文本也得跟着常量走，不然改常量只对新库生效。
 * 只碰这一处标记，正文一个字节不动。
 */
function normalizeHeader(pat) {
  try {
    if (statSync(pat).size > 64 * 1024) return; // 库大了就不整读，正常库只有头部几十字节
    const t = readFileSync(pat, "utf8");
    if (!t.includes("（79条）")) return;
    writeFileSync(pat, t.replace("（79条）", ""));
  } catch {
    /* 头部清理失败不影响写入 */
  }
}

/**
 * 追加一条事实骨架。同一会话同一天只追加一次（重复声明不重复记账）。
 * @param {string} projDir 项目根
 * @param {{sid: string, reason: string, evidence?: string, task?: string}} info
 * @returns {boolean} 是否真的追加了
 */
export function appendPatternStub(projDir, info = {}) {
  const { sid = "", reason = "未注明", evidence = "", task = "熔断" } = info;
  ensurePatterns(projDir);
  const pat = patternsPath(projDir);

  // 去重判据：同一会话 + 同一天已有骨架 → 不再追加。
  const day = new Date().toISOString().slice(0, 10);
  try {
    const tail = readTail(pat, 4096);
    if (sid && tail.includes(`会话 ${sid}`) && tail.includes(day)) return false;
  } catch {
    /* 读不到就不去重，宁可多一条也不丢 */
  }

  const block = [
    "",
    `## ${new Date().toISOString()} [环境:${process.platform}] [任务:${task}]`,
    `- 触发：${reason}`,
    evidence ? `- 证据：${evidence}` : `- 证据：会话 ${sid || "未知"}`,
    "- 教训：<待补：以后遇到 X 必须先做 Y>",
    "",
  ].join("\n");

  appendFileSync(pat, block);
  return true;
}

/** 读文件尾部 N 字节（去重只看最近内容，不整读）。 */
function readTail(file, bytes) {
  const size = statSync(file).size;
  const len = Math.min(bytes, size);
  if (len <= 0) return "";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * 未回填的教训骨架条数（`- 教训：<待补…`）。0 = 干净。
 *
 * 2026-11-08：这个数字此前**没人算**。骨架写进去之后，`<待补>` 那一行只能靠模型自觉回填，
 * 而模型看不见"还有几笔欠着"——于是库能一直停在"有骨架、无教训"。计数交给引擎，
 * 判断（教训该写什么）仍留给模型。
 *
 * 每回合都会调一次，故按 `mtime+size` 缓存：库没变就不重读。
 */
let pendingCache = { key: "", n: 0 };
export function pendingPatternStubs(projDir) {
  if (!projDir) return 0;
  const pat = patternsPath(projDir);
  try {
    const st = statSync(pat);
    // key 里必须带路径：多个项目同尺寸同 mtime 的概率不低（空库都是同一个头部），
    // 只用 mtime+size 会让第二个项目读到第一个项目的计数。
    const key = `${pat}|${st.mtimeMs}:${st.size}`;
    if (key === pendingCache.key) return pendingCache.n;
    const n = (readFileSync(pat, "utf8").match(/^- 教训：<待补/gm) || []).length;
    pendingCache = { key, n };
    return n;
  } catch {
    return 0;
  }
}
