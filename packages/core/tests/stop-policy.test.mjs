import { test } from "node:test";
import assert from "node:assert/strict";

// 收尾判定内核（母版唯一真源，2026-10-25 阶段 1）
// 判据：母版是逻辑，适配层只做翻译。此前同一套四件套判定在 guard.mjs 与 stopGuard.mjs 各写一份。
// 本组锁住判定语义（纯函数、无副作用），宿主缝只负责"取结果 → 打回/提示/审计"。

const sp = await import("../src/core/stopPolicy.mjs");

test("declaresFuse：显式熔断 / 未知声明都算", () => {
  assert.equal(sp.declaresFuse("【熔断】无法定位"), true);
  assert.equal(sp.declaresFuse("查无依据继续"), true);
  assert.equal(sp.declaresFuse("查无实据"), true);
  assert.equal(sp.declaresFuse("一切正常"), false);
});

test("needsDowngrade：熔断声明但缺三行降级 → true；带降级/已拦过/重入 → false", () => {
  assert.equal(sp.needsDowngrade({ text: "【熔断】卡住了", state: {} }), true);
  // 降级标记按引擎定义（最小复现/排查实验/卡点记录/HANDOFF.md…），不是任意"降级方案"字样
  assert.equal(sp.needsDowngrade({ text: "【熔断】卡住了\n最小复现：跑 npm test", state: {} }), false);
  assert.equal(sp.needsDowngrade({ text: "【熔断】卡住了", state: { stopBlocked: true } }), false);
  assert.equal(sp.needsDowngrade({ text: "【熔断】卡住了", state: {}, stopReentry: true }), false);
});

test("needsAccount：已 fused 且收尾无锚点 → true；有锚点/已拦过 → false", () => {
  assert.equal(sp.needsAccount({ text: "做完了", state: { fused: true } }), true);
  assert.equal(sp.needsAccount({ text: "已改 src/a.mjs:12", state: { fused: true } }), false);
  assert.equal(sp.needsAccount({ text: "做完了", state: { fused: true, stopBlocked: true } }), false);
  assert.equal(sp.needsAccount({ text: "做完了", state: { fused: false } }), false);
});

test("needsAnchorCheck：≥5 次且无锚点 → true；阈值可调；<阈值/有锚点 → false", () => {
  assert.equal(sp.needsAnchorCheck({ text: "做完了", state: { turnCount: 5 } }), true);
  assert.equal(sp.needsAnchorCheck({ text: "做完了", state: { turnCount: 4 } }), false);
  assert.equal(sp.needsAnchorCheck({ text: "改 src/a.mjs:3 完成", state: { turnCount: 9 } }), false);
  assert.equal(sp.needsAnchorCheck({ text: "做完了", state: { turnCount: 9, stopBlocked: true } }), false);
  assert.equal(sp.needsAnchorCheck({ text: "做完了", state: { turnCount: 2 }, min: 2 }), true);
});

test("hasAnchor：识别 [文件:行号] 形态", () => {
  assert.equal(sp.hasAnchor("见 src/a.mjs:12"), true);
  assert.equal(sp.hasAnchor("见 packages/core/tests/x.test.mjs:10-20"), true);
  assert.equal(sp.hasAnchor("改完了，应该没问题"), false);
});

// 回合出口（3.4）：被掐断的回合必须承认。
// 判据不是「必须调某工具才允许结束」（DSH 无 stop 拦截口，打回会死循环），
// 而是「必须承认怎么结束的」——所以只在 stopBlocked 时触发。
test("needsCutShortNotice：没被掐断就不提，被掐断且没交代才提", () => {
  assert.equal(sp.needsCutShortNotice({ text: "做完了", state: {} }), false);
  assert.equal(
    sp.needsCutShortNotice({ text: "做完了", state: { stopBlocked: true } }),
    true,
    "被拦住却声称做完了——这是烂尾"
  );
  assert.equal(
    sp.needsCutShortNotice({ text: "预算耗尽，剩下三个文件未改", state: { stopBlocked: true } }),
    false,
    "说明了剩余什么没做，算有出口"
  );
  assert.equal(
    sp.needsCutShortNotice({ text: "【熔断】无法定位核心问题", state: { stopBlocked: true } }),
    false,
    "已声明熔断，不再要求重复交代"
  );
  // 两个宿主缝信号不同：DSH 用 stopBlocked（无协议信号），Claude Code 用 stop_hook_active。
  assert.equal(
    sp.needsCutShortNotice({ text: "做完了", cutShort: true }),
    true,
    "Claude Code 侧靠 stop_hook_active，不依赖 state.stopBlocked"
  );
});
