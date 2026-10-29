# Hook Ordering 核查：能不能让 FG「拓扑必然在前」

> 起因：2026-10-29 人类提出用 `@zfdx123/dsh-hooks-ordering` 把 FG 的 `pre-execute`
> 段声明为 `before` 其他参与者，「大哥的地位从碰巧先加载变成拓扑上必然在前」。
> 本文是核查结论。**先说结论，再说证据，最后说哪条路能走。**

## 一、结论

| # | 结论 | 依据 |
|---|---|---|
| 1 | 风险是真的：`tools/pre-execute` 的顺序确实由注册时机决定 | Cordis 按数组位置派发，`prepend` 是唯一调节手段 |
| 2 | **但不能按「注册成 participant」来接** | 协调器**丢弃** waterfall 参与者的返回值 |
| 3 | 丢弃返回值 = FG 的 deny 静默失效 | FG 的拦截靠 `return {kind:'deny'}` |
| 4 | serial 钩子（`agent/turn-stopping`）**可以** bail | 那条路有 `isBailed(result) return result` |

一句话：**这个包能排顺序，但排完序之后，跑在前面的参与者没有「否决权」。**
对 FG 这种靠返回值拦截的插件，`front` 阶段等于「说了一句没人听的话」。

## 二、证据（包版本 1.0.15，源码级）

`lib/waterfall-*.js` 的包夹实现：

```js
const bracket = (...args) => {
  const next = args[args.length - 1];
  if (front.length === 0 && back.length === 0) return next();
  const payload = args.slice(0, -1);
  return (async () => {
    await runPhase(front, payload);   // ← 返回值没人接
    const result = await next();
    await runPhase(back, payload);
    return result;                    // ← 只有原生链的结果被返回
  })();
};

async function runPhase(entries, payload) {
  for (const entry of topoSort(entries)) await entry.run(...payload);  // ← 丢弃
}
```

对照 serial（`lib/serial-*.js`）第 59 行：

```js
if (isBailed(result)) return result;   // ← serial 有短路，waterfall 没有
```

**两条路的差别不是配置，是设计。** waterfall 的 participant 是「旁路观察者」，
serial 的 participant 是「可否决的检查点」。

## 二·实测（真包 1.0.15，不是读代码推断）

搭最小 ctx（`on` 收集监听器、`prepend` 走 `unshift`、`effect` 直通），
跑包里的真 `HookOrdering` 类，模拟 waterfall 派发：

```js
// 先注册一个「别的护栏插件」的原生监听器
ctx.on('tools/pre-execute', (_p, next) => next())
ord.control('tools/pre-execute')
ord.register('tools/pre-execute', 'front', {
  name: 'focus-guard',
  run: () => ({ kind: 'deny', reason: 'FG 判定：禁止' }),
})
dispatch({ name: 'bash', args: {} })
```

输出：

```
plan(front) = [ 'focus-guard' ]
执行轨迹     = focus-guard(front) 返回 deny → native-guard
派发结果     = "HOST-DEFAULT"
```

**FG 排第一、返回了 deny、原生链照常跑到宿主默认。** 这就是 §三 那张表的实证版。

## 三、如果硬接会怎样

| 步骤 | 实际发生 |
|---|---|
| FG 调 `hooksOrdering.register('tools/pre-execute', 'front', { name:'focus-guard', run })` | 注册成功，`plan()` 里能看到自己排第一 |
| 工具调用进来 | bracket 先跑 front，FG 的 `run` 返回 `{kind:'deny'}` |
| 返回值 | **被 `runPhase` 丢掉**，`next()` 照常执行 |
| 结果 | **工具执行了，FG 的 deny 消失了**，日志里连一条 warn 都没有 |

这是最坏的失败形态：**看起来装好了、`plan()` 显示排第一、实际一次都没拦住。**
比不装更糟——不装至少知道自己没拦。

## 四、四条路

| 方案 | 做法 | 代价 | 结论 |
|---|---|---|---|
| **A 顺序自检** | FG 启动时探测 `hooksOrdering`，报自己是否受控、在不在场 | 零依赖、零行为变更 | ✅ **已落地** |
| **B FG 当控制者** | 用户配 `hooks: []` 让 dsh 层不接管 `pre-execute`；FG 自己 `control()` 并装 bracket，bracket 里跑判定后 `return decision` | FG 必须依赖该包；要改 profile 配置 | ⏸ 待批示 |
| **C 两阶段** | front 阶段算好判定存进 `WeakMap<exec, decision>`，原生链监听器只读结果并返回 | 顺序确定 + 语义正确，但装包 + 复杂度上升 | ⏸ 待批示 |
| **D 等上游** | 让 `runPhase` 消费返回值（`if (result) return result`） | 改别人的包 | ⏸ 可提 issue |

**B 是唯一能真正做到「拓扑必然在前」的路**，因为控制者自己就是那个 bracket，
它可以把判定放在 `next()` 之前并直接 `return`。代价是 FG 从「零依赖」变成
「依赖 hooks-ordering」——与 3.2.0 刚立的「无依赖」目标正面冲突。

**C 是不装依赖也能确定顺序的变体**，但 `WeakMap` 键是 `exec` 对象，跨监听器传递
依赖宿主不复制该对象——未实测，不能当已成立。

## 五、已落地：顺序自检

`src/dsh/hookOrder.mjs` + 在 `agent/created` 跑一次（只报不改，与 `policy-audit` 同纪律）。

报什么：

| 场景 | 输出 |
|---|---|
| 没装 hooks-ordering | `未受控：pre-execute 顺序由注册时机决定` |
| 装了但 FG 没接入 | `已受控但 FG 不在参与者列表（waterfall 参与者无法承载 deny）` |
| 装了且 FG 在列表里 | 报出 FG 的位置——**正常情况下不该出现**，出现即说明有人按 §三 的方式接了 |

第三种是**防回归**：如果哪天有人（包括未来的我）按错误方式接了，自检会当场指出来。

## 六、未做

- **没装包**。装了要重启 DSH 才生效，而结论是「装了也不该按 participant 接」；
  装与不装对 FG 的拦截能力没有区别，只影响自检能看到什么。装包命令与回滚见 §七。
- **没改 profile**。`dsh plugin --profile web add` 会写 `package.json` 的 bundles 与
  `cordis.patch.yml`，属用户环境变更，待批示。
- **没实现方案 B/C**。两者都要先决定「FG 能不能破零依赖」——这是立法级决定，不是实现问题。

## 七、如果决定要装

```sh
# 装（README 要求作为 bundle 装，不要手写 cordis.patch.yml，会 duplicate loader entry id）
dsh plugin --profile web add @zfdx123/dsh-hooks-ordering

# 重启 dsh（bundle 不做热加载）

# 回滚
dsh plugin --profile web remove @zfdx123/dsh-hooks-ordering
```

装完设置页会出现「钩子排序」。**在 FG 侧不做任何注册的前提下，它是透明直通**
（README §「已知限制」第一条：受控钩子在没有任何参与者时返回值不受影响）。
