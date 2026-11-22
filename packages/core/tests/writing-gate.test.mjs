import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 第 1.3 层 动笔闸（2026-11-20 建组；同日改「自带方法论」）。
//
// 病根：本层**默认启用**（pipeline.mjs 无条件注册），却要求模型调用 `brainstorming` /
// `writing-plans` —— 这两个技能**不在 FG 的包里**，来自宿主的 `customSkillDirs`。
// 没装的用户会拿到一条不可执行的建议（"去调用一个不存在的工具"），与"整读闸写死 xerj"同病。
//
// 修法：FG 自带 `skills/focus-plan`，闸门认它。本组锁四件事：
//   ① `FG_WRITING_GATE=off` 直接放行（给彻底不想用的人一个出口）；
//   ② 判据三件套不误伤带验收词的请求；
//   ③ **focus-plan 真的在包里，且真的被认**——不靠文案声称"零依赖"；
//   ④ 提示把三条路都写出来（focus-plan / superpowers / 直接重试）。

const { writingGateStage, isVagueDevTask, writingGateEnabled, isMethodologySkill } = await import(
  "../src/dsh/guard/writing-gate.mjs"
);

function withEnv(k, v, fn) {
  const prev = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
}

test("FG_WRITING_GATE=off：整层直接放行，不看状态不写审计", async () => {
  assert.equal(writingGateEnabled(), true, "默认必须是开着的");
  await withEnv("FG_WRITING_GATE", "off", async () => {
    assert.equal(writingGateEnabled(), false);
    // 即使 exec 是动笔类工具，off 之后也不该拦——这里连状态文件都没有，放行即返回 null。
    const r = await writingGateStage({ exec: { name: "write", arguments: {} }, warn() {}, cmd: "" });
    assert.equal(r, null);
  });
});

test("判据三件套：模糊开发任务命中，带验收词的不命中", () => {
  assert.equal(isVagueDevTask("优化一下性能"), true, "开发动词 + 模糊标记、无验收词 → 应命中");
  assert.equal(isVagueDevTask("优化一下性能，p95 要低于 20ms"), false, "带了验收词（p95）→ 不拦");
  assert.equal(isVagueDevTask("今天天气不错"), false, "闲聊不该命中");
});

test("自带 focus-plan：文件在包里，名字被闸门认", () => {
  const skill = readFileSync(new URL("../skills/focus-plan/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^---\nname: focus-plan\n/, "技能名必须是 focus-plan（闸门认的就是这个名字）");
  assert.match(skill, /动笔闸/, "技能必须说明它与动笔闸的关系，否则用户不知道为什么被要求加载它");
  assert.equal(isMethodologySkill("focus-plan"), true);
  // 兼容面：已装 superpowers 的、以及别家方法论技能（按名字 token 认，不按子串）
  assert.equal(isMethodologySkill("writing-plans"), true);
  assert.equal(isMethodologySkill("spec-writing"), true);
  assert.equal(isMethodologySkill("inspect"), false, "inspect 含 spec 子串，但不是一个 token，不能认");
});

test("提示必须给出三条可执行的路（focus-plan / superpowers / 直接重试）", () => {
  const src = readFileSync(new URL("../src/dsh/guard/writing-gate.mjs", import.meta.url), "utf8");
  assert.match(src, /name=focus-plan/, "首选必须是包内自带的 focus-plan");
  assert.match(src, /brainstorming \/ writing-plans/, "装了 superpowers 的用户必须知道该调哪个");
  assert.match(src, /直接重试即放行/, "任务其实说得清的用户必须被告知可以直接重试");
  assert.match(src, /FG_WRITING_GATE=off/, "必须给出永久关闭本层的开关");
});
