// FocusGuard 母版层 · 陈旧状态清理（2026-11-01 从 state.mjs 抽出）
//
// 为什么抽出：红队补丁（A2 迁移标记 / R1 目录 chmod / R2 目录健康检查 / R3 淘汰年龄下界）
// 把 state.mjs 从 389 行推到 497 行，跨过 smells 的 400 行门槛，棘轮当场报红。
// 清理逻辑与状态读写**没有共享状态**（只共用 `stateDir()` 与 `audit()`），独立成文件即可。
// 切法同 `tempPath.mjs`：不是拆模块，是把一件独立的事挪出去。
//
// 判据（2026-11-01 红队结论，写死避免反复讨论）：
//   **这个插件删的每一个文件，都要能证明"是我建的"；证明不了，就只能删一次，不能永远删。**
import { readdirSync, statSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stateDir } from "./tempPath.mjs";
import { noteFail, audit } from "./audit.mjs";

// 2.5.3（61条落地）：清理陈旧的状态/回退档案。
// 2026-11-01（P0-1）三处改：
//   ① 保留期 30 天 → 7 天。状态文件只在会话存活期间有用，会话不会跨周；30 天 × 实测 1700 个/天
//      = 稳态 5 万个，等于没清。
//   ② 只扫自己的子目录，不再 readdirSync 整个 tmpdir——原来每次会话启动要对 1.2 万个匹配项
//      逐个 statSync，纯浪费且随文件数线性增长。
//   ③ 旧平铺位置（tmpdir 根）单独处理：新代码永不写那里，故匹配项一律清（升级的一次性迁移）。
//      **仅在未设 FG_STATE_DIR 时执行**——否则测试会把宿主的真实状态文件一起删掉。
//   ④ 匹配面补 `.tmp`：saveState 现在用随机名中间文件，进程被 kill 会留下 `<…>.json.<hex>.tmp`
//      孤儿。原先正则只认 `.json` / `-AUDIT.log`，这类孤儿永远清不掉。
//   ⑤ **加数量上限**（P0-1 的结构性补丁）。前四条全是"按年龄清"——而年龄判据的根本毛病是
//      写入量不受它约束：只要哪天又多出一条"每次测试写一份"的路径，7 天窗口照样能堆满。
//      上限判据与写入量无关，是唯一能给出稳态上界的东西。两条并用：过期即删 + 超出上限删最旧。
const STALE_MS = 7 * 86400e3;
const STATE_FILE_CAP = 500; // 正常一天约 20 个会话 × 7 天 ≈ 140，500 留足余量
const TEMP_ENTRY_RE = /^focus-guard-.*(\.json|-AUDIT\.log|\.tmp)$/;

// 2026-11-16（P0-1 第三刀）：tmpdir 根的**临时产物**数量兜底。
//
// 为什么前两刀没管住：
//   ① `purgeLegacyRoot` 是一次性迁移——清完落 `.legacy-purged`，之后**永不回扫** tmpdir 根；
//   ② `TEMP_ENTRY_RE` 只认 `focus-guard-*` 前缀 + 三种后缀，而测试里约 100 处用的是
//      `fg-*` 前缀、`.log` 后缀——**两条都不匹配**，从来就没被清过；
//   ③ `audit-isolation` 的沙箱只覆盖 `npm run check`。**手动跑单个测试**
//      （`node --test tests/xxx.mjs`）完全绕过它，而这类文件名带 `pid + Date.now()`，
//      每次都是新名字，测试自己只删当次那个——跑完必留，谁也删不掉谁。
//
// 判据仍是**数量**不是年龄：年龄管不住写入量（§1.5②-补 已论证）。后缀白名单是防误删的——
// `fg-` 只有 3 个字符，不像 `focus-guard-` 那样独特，A2 红队（`focus-guard-notes.json` 被误删）
// 就是这个坑。加上「1 小时内写的不碰」和「不超限一个都不删」，误伤面收窄到可接受。
const FG_SCRATCH_RE = /^(?:focus-guard|fg)-.*\.(?:log|json|md|mjs|tmp)$/;
const FG_SCRATCH_CAP = 200; // 手动跑一遍全量约留 100 个，200 留一倍余量

/** 上限淘汰的年龄下界：这个窗口内写过的状态文件可能属于活会话，不淘汰（R3）。 */
const EVICT_FLOOR_MS = 3600e3;

/** 迁移标记：旧平铺位置只清一次（A2，2026-11-01 红队）。 */
const LEGACY_MARK = ".legacy-purged";

/**
 * 清掉 dir 下的状态/档案：早于 cutoff 的删，且总量不超过 cap（超出部分删最旧的）。
 * cutoff 传 `Infinity` 即"全部删"（旧平铺位置的一次性迁移用）。目录不存在（首次运行）返回 0，不抛。
 * protect 为当前会话文件名，只豁免**上限淘汰**（不豁免过期——过期的本会话文件也没有用）。
 * 为什么必须豁免：活跃会话若长时间不写状态，磁盘上可能出现 500 个更年轻的文件，
 * 光看 mtime 它就是"最旧"的，会被上限误删——那等于把熔断状态清空。
 */
function purgeStaleIn(dir, cutoff, cap, protect) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const items = [];
  for (const f of names) {
    if (!TEMP_ENTRY_RE.test(f)) continue;
    const fp = join(dir, f);
    try {
      items.push({ fp, name: f, mt: statSync(fp).mtimeMs });
    } catch {}
  }
  items.sort((a, b) => a.mt - b.mt); // 最旧在前
  let n = 0;
  const alive = [];
  for (const it of items) {
    if (it.mt >= cutoff) {
      alive.push(it);
      continue;
    }
    try {
      rmSync(it.fp, { force: true });
      n++;
    } catch {}
  }
  let over = alive.length - cap;
  // R3（2026-11-01 红队）：原实现只按名字豁免自己，于是 505 个新文件能把一个**别人的活会话**
  // 当"最旧"删掉——那等于清空别人的熔断状态（实测：1 分钟前、完全没过期的状态被删）。
  // 判据改成**年龄下界**：1 小时内写过的状态一律不淘汰。活会话每次工具调用都会刷新 mtime，
  // 所以"1 小时内写过"是"可能还活着"的可靠近似。代价是上限变成软上限——某一小时内会话特别多
  // 时目录会暂时超出 500，等它们老去再收。**暂时超限**远好过**静默重置别人的熔断**。
  const evictBefore = Date.now() - EVICT_FLOOR_MS;
  for (const it of alive) {
    if (over <= 0) break;
    if (protect && it.name === protect) continue;
    if (it.mt > evictBefore) continue;
    try {
      rmSync(it.fp, { force: true });
      n++;
      over--;
    } catch {}
  }
  return n;
}

/**
 * 旧平铺位置（tmpdir 根）：新代码永不写那里，故匹配项一律清。
 *
 * A2（2026-11-01 红队）：原实现**每次会话启动都无条件清**，且正则只看文件名——
 * 实测 `focus-guard-notes.json`、`focus-guard-backup.json` 这类**不是 FG 写的**文件照样被删。
 * 注释说是"一次性迁移"，但没有迁移标记，所以它从来不是一次性的。
 * 现加 `.legacy-purged`：清完即落标记，之后永不扫 tmpdir 根。
 */
function purgeLegacyRoot() {
  const root = tmpdir();
  if (process.env.FG_STATE_DIR || root === stateDir()) return 0;
  const dir = stateDir();
  if (existsSync(join(dir, LEGACY_MARK))) return 0;
  const n = purgeStaleIn(root, Infinity, 0);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, LEGACY_MARK), new Date().toISOString());
  } catch {}
  return n;
}

/**
 * tmpdir 根的 FG 临时产物数量兜底（2026-11-16）。
 *
 * 与 `purgeLegacyRoot` 的分工：那条是**一次性迁移**（清完落标记，永不再扫）；
 * 这条是**常驻判据**，**不受 `.legacy-purged` 影响**——泄漏源会持续产生，一次性迁移治不了。
 *
 * 只删文件、不删目录：`rmSync(force)` 对非空目录会失败，加 `recursive` 又可能连带删掉
 * 别人的目录树。目录数量比文件少两个量级，先不动。
 * 1 小时内写过的不碰（`EVICT_FLOOR_MS`）：手动跑测试可能正在写，删了会让当次断言假红。
 *
 * `root` / `cap` 可注入仅为可测——生产调用不带参。
 */
export function capScratchRoot(root = tmpdir(), cap = FG_SCRATCH_CAP) {
  if (process.env.FG_STATE_DIR) return 0; // 测试沙箱：整个 tmpdir 都是临时的，跑完整体删
  if (root === stateDir()) return 0;
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  const items = [];
  for (const f of names) {
    if (!FG_SCRATCH_RE.test(f)) continue;
    const fp = join(root, f);
    try {
      const st = statSync(fp);
      if (!st.isFile()) continue;
      items.push({ fp, mt: st.mtimeMs });
    } catch {}
  }
  let over = items.length - cap;
  if (over <= 0) return 0; // 没超限：一个都不碰
  items.sort((a, b) => a.mt - b.mt); // 最旧在前
  const evictBefore = Date.now() - EVICT_FLOOR_MS;
  let n = 0;
  for (const it of items) {
    if (over <= 0) break;
    if (it.mt > evictBefore) continue;
    try {
      rmSync(it.fp, { force: true });
      n++;
      over--;
    } catch {}
  }
  return n;
}

/**
 * 状态目录健康检查（R1 / R2，2026-11-01 红队）。
 *
 * R1：`mkdirSync(dir, {mode:0o700})` 的 mode **只对新建生效**。目录已存在时既不报错也不改权限，
 * 于是共享 `/tmp` 上"别人先建一个 0o777 的 focus-guard/"就能让状态写进别人的目录。
 * 修法不是引入属主校验（插件背不动），而是**显式 chmod**——对已存在的目录也生效。
 *
 * R2：目录被同名**文件**占住时，`saveState` 每写必败且只留一行 stderr，后果是
 * 每个钩子进程都从零开始读状态 → 熔断等于没装。这里在会话启动时把原因说清楚，
 * 而不是让 `noteFail` 说一句"本次状态未保存"。
 */
function ensureStateDirHealthy(sid) {
  const dir = stateDir();
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return true; // 不存在 = 首次运行，saveState 会按需创建
  }
  if (!st.isDirectory()) {
    noteFail(
      sid,
      `状态目录 ${dir} 被同名${st.isSymbolicLink() ? "符号链接" : "文件"}占用——` +
        "熔断/预算状态无法跨调用持久化，本次会话的拦截判定不会累积",
    );
    return false;
  }
  try {
    chmodSync(dir, 0o700); // POSIX 有效；Windows 忽略 mode，无害
  } catch {}
  return true;
}

export function cleanStaleTemp(sid) {
  const protect = sid ? `focus-guard-${sid}.json` : null;
  ensureStateDirHealthy(sid);
  const cleaned =
    purgeStaleIn(stateDir(), Date.now() - STALE_MS, STATE_FILE_CAP, protect) +
    purgeLegacyRoot() +
    capScratchRoot();
  if (cleaned)
    audit(sid, "stale-cleaned", {
      level: null,
      evidence: `61条 清理 ${cleaned} 个陈旧临时状态/档案（>7天或超出上限；含 tmpdir 根 FG 产物，上限 ${FG_SCRATCH_CAP}）`,
    });
}
