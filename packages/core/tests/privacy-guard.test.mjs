import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 私有面守卫（2026-10-30）
//
// 背景：私有忽略规则从 `.gitignore`（入库、公开）搬到 `.git/info/exclude`（本地、不入库）。
// 换来"外人看不到屏蔽了什么"，代价是 exclude 不随仓库走——换机器忘了装，`git add .`
// 就会把私有数据整包收进去。本文件锁住守卫本身，重点是**守卫不能是瞎的**：
//
//   ① 匹配器语义要与 git 一致（用真实 git 当 oracle 对拍，不信自己的直觉）
//   ② 三条断言各自能红（B 已跟踪命中 / C gitignore 点名 / D 清单未装）
//   ③ installRules 幂等（换机器重装不会重复追加）
//
// 为什么必须有 oracle 对拍：首版匹配器只拿完整文件路径去套规则，
// 而 `/docs/vault-notes/*` 是靠"父目录被忽略→子文件跟着忽略"生效的，
// 自写版跨不过 `/`，把嵌套文件全判成"没忽略"——守卫看着绿，其实瞎了。

const { compileRule, parseRules, isIgnored, findLeakedRules, installRules } = await import(
  "../tools/privacy-guard.mjs"
);

const RULES_TEXT = [
  ".focus-guard/",
  ".ai/",
  "/docs/vault-notes/*",
  "!/docs/vault-notes/README.md",
  "panel-runs*.json",
  "deploy.mjs",
  "build/**",
  "*.log",
].join("\n");

const rules = parseRules(RULES_TEXT);

// 覆盖每一类语义：目录规则（含非锚定）、取反、锚定通配、无斜杠文件名、`**`、后缀
// 第三列 `kind` 是**夹具形态**：`.ai` 这类路径本身就是目录，写文件会 EISDIR
const CASES = [
  [".ai/CASE_FILE.md", true, "file", "目录规则命中子文件"],
  [".ai", true, "dir", "目录规则命中目录本身"],
  ["x/.ai/y.md", true, "file", "无锚定的目录规则匹配任意深度"],
  ["docs/vault-notes/vendors/OpenAI.md", true, "file", "父目录被忽略 → 嵌套文件跟着忽略"],
  ["docs/vault-notes/README.md", false, "file", "取反规则最后命中 → 放行"],
  ["panel-runs-1.json", true, "file", "无斜杠通配匹配根下"],
  ["sub/panel-runs-2.json", true, "file", "无斜杠通配匹配任意深度"],
  ["deploy.mjs", true, "file", "无斜杠文件名匹配根下"],
  ["sub/deploy.mjs", true, "file", "无斜杠文件名匹配任意深度"],
  ["build/a/b.js", true, "file", "`**` 跨斜杠"],
  ["x/build/a.js", false, "file", "带斜杠规则从根锚定"],
  ["a.log", true, "file", "后缀通配"],
  ["src/a.mjs", false, "file", "未命中任何规则"],
];

test("匹配器：逐条语义", () => {
  for (const [path, want, , why] of CASES) {
    assert.equal(isIgnored(rules, path), want, `${why}：${path}`);
  }
});

test("匹配器：与真实 git 对拍（oracle，不信自己的直觉）", () => {
  const root = mkdtempSync(join(tmpdir(), "fg-privacy-oracle-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    // 夹具参数必须抄真实调用记录：直接把同一份规则写给 git，两边吃同样的输入
    writeFileSync(join(root, ".git", "info", "exclude"), `${RULES_TEXT}\n`, "utf8");

    const mismatched = [];
    for (const [path, mine, kind] of CASES) {
      // 造出对应形态的路径，避免 check-ignore 因路径不存在而行为不一致
      const abs = join(root, path);
      mkdirSync(join(abs, ".."), { recursive: true });
      if (kind === "dir") mkdirSync(abs, { recursive: true });
      else writeFileSync(abs, "x");
      let theirs;
      try {
        execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: root, stdio: "ignore" });
        theirs = true;
      } catch {
        theirs = false;
      }
      if (mine !== theirs) mismatched.push(`${path}：自写=${mine} / git=${theirs}`);
    }
    assert.deepEqual(mismatched, [], `匹配器与 git 不一致：\n${mismatched.join("\n")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compileRule：锚定与目录语义", () => {
  assert.equal(compileRule(".ai/").dirOnly, true, "结尾斜杠 → 目录规则");
  assert.equal(compileRule("/docs/x").dirOnly, false);
  // 带斜杠自动锚定：`/docs/x` 与 `docs/x` 等价
  assert.equal(compileRule("docs/x").re.source, compileRule("/docs/x").re.source);
});

test("findLeakedRules：.gitignore 点名私有路径即泄漏", () => {
  const leaked = findLeakedRules("# 注释\nnode_modules/\n.ai/\n*.log\n", rules);
  assert.deepEqual(leaked, [".ai/"], "只该抓到 .ai/，node_modules 与 *.log 属通用规则");
});

test("findLeakedRules：通用规则不误报", () => {
  const leaked = findLeakedRules("node_modules/\n.DS_Store\n.vs/\n", rules);
  assert.deepEqual(leaked, [], "通用条目不该被当成泄漏");
});

test("findLeakedRules：取反规则也能抓到点名", () => {
  // 只放一条取反行，两条私有规则都该命中：
  //   `!/docs/vault-notes/README.md` 直接点名；
  //   `/docs/vault-notes/*` 因为 cand 以它的字面前缀开头，同样算目录被暴露。
  const leaked = findLeakedRules("!/docs/vault-notes/README.md\n", rules);
  assert.deepEqual(
    leaked.sort(),
    ["!/docs/vault-notes/README.md", "/docs/vault-notes/*"].sort(),
    "取反行点名同样暴露目录存在",
  );
});

test("findLeakedRules：通用后缀规则不误报（`*.log` 字面前缀为空的历史坑）", () => {
  // 首版把 `*.log` 的 needle.split(/[*?]/)[0] 当字面前缀，得到空串，
  // startsWith('') 恒真 → 任何 .gitignore 内容都被判成泄漏。这里锁住这个坑。
  const leaked = findLeakedRules("node_modules/\n.DS_Store\n.vs/\nreports/\n", rules);
  assert.deepEqual(leaked, [], "通用条目一个都不该报");
});

/** 在临时目录里摆一对 canonical/exclude 夹具，跑完自动清掉。 */
function withFixture(name, canonicalText, excludeText, fn) {
  const root = mkdtempSync(join(tmpdir(), `fg-privacy-${name}-`));
  try {
    const canonical = join(root, "canonical.exclude");
    const exclude = join(root, "exclude");
    writeFileSync(canonical, canonicalText, "utf8");
    writeFileSync(exclude, excludeText, "utf8");
    return fn({ canonical, exclude });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("installRules：幂等（重装不重复追加）", () => {
  withFixture("install", ".ai/\n.focus-guard/\n", ".dsh/runtime/\n", ({ canonical, exclude }) => {
    const first = installRules(canonical, exclude);
    assert.deepEqual(first.added, [".ai/", ".focus-guard/"], "首次装两条");
    const text1 = readFileSync(exclude, "utf8");
    assert.match(text1, /^\.dsh\/runtime\//m, "原有规则不能被冲掉");

    const second = installRules(canonical, exclude);
    assert.deepEqual(second.added, [], "第二次装应为空");
    assert.equal(readFileSync(exclude, "utf8"), text1, "文件内容不该变化");
  });
});

test("installRules：只补缺的，不覆盖已有的", () => {
  withFixture("partial", ".ai/\n.focus-guard/\n", ".ai/\n", ({ canonical, exclude }) => {
    const { added, skipped } = installRules(canonical, exclude);
    assert.deepEqual(added, [".focus-guard/"], "只补缺的那条");
    assert.equal(skipped, 1, "已有的算跳过");
    const lines = readFileSync(exclude, "utf8").split("\n").filter((l) => l === ".ai/");
    assert.equal(lines.length, 1, "已有的不该被重复追加");
  });
});

test("installRules：清单缺失时明确报错，不静默", () => {
  assert.throws(() => installRules("/nonexistent/canonical.exclude", "/tmp/x"), /清单备份不存在/);
});
