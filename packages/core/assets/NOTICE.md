# 第三方数据说明（`packages/core/assets/`）

## `cortex.bin`

| 项 | 值 |
|---|---|
| 内容 | 人脑 pial 表面（软膜面）点云，27,638 点，每点 `x,y,z`（uint16 量化）+ 沟深代理（uint8） |
| 来源 | FreeSurfer 导出的 `lh.pial.ply` / `rh.pial.ply`（ASCII PLY，289,561 顶点）降采样 |
| 生成 | `node packages/core/tools/make-cortex-asset.mjs <pial_Full_ply 目录>` |
| 许可 | **CC BY-SA 3.0**（源数据来自 memory-brain，Anderson Winkler） |
| 与主许可的关系 | 本仓代码为 **AGPL-3.0-only**。CC BY-SA 3.0 与 AGPL 不兼容，因此本目录**整体按 CC BY-SA 3.0 授权**，作为独立作品与代码并列分发（mere aggregation），不并入程序源码。 |

### 与 npm 包的关系

自 3.5.0 起 `assets/` **已列入 `packages/core/package.json` 的 `files` 白名单**，
npm 包与 GitHub clone 拿到的皮层资产完全一致，脑壳在两条路上都是真皮层网格。

两种互不兼容的 copyleft 靠**并列分发**处理，不靠把条款缝在一起：

- 代码（`src/` `hooks/` `tools/` …）按 **AGPL-3.0-only** 授权。
- 本目录（`assets/`）整体按 **CC BY-SA 3.0** 授权，**是独立作品**，不是程序的组成部分。
- 两者在同一 tarball 内属于 **mere aggregation**：聚合不产生衍生作品，各自条款只约束各自部分。
- 因此 `package.json` 的 `license` 字段仍只声明代码的 `AGPL-3.0-only`；本文件即为数据部分的
  完整许可声明与署名，二者缺一不可。

再分发时请保留本文件。若只取用代码、不需要皮层形状，删掉 `assets/` 即可——
脑会自动退回程序化沟回（解析椭球 + 噪声刻槽），输出明写
「解析椭球（未找到 assets/cortex.bin，形状是算的）」，不会静默降级。

### 再生成

源 PLY 不在版本库里（19 MB ASCII，且同属 CC BY-SA）。要重新生成，需自备
FreeSurfer 的 pial 表面（`lh.pial.ply` / `rh.pial.ply`），然后：

```bash
node packages/core/tools/make-cortex-asset.mjs <目录> --target=29000
```

`--target` 控制总点数（默认 29,000，实际产出约 27,600）。点数越多轮廓越细，
体积按每点 7 字节线性增长。

### 署名

> Cortical surface data derived from FreeSurfer `pial` surfaces distributed via
> memory-brain (Anderson Winkler), licensed CC BY-SA 3.0.
> Modifications: subsampled to 27,638 vertices, quantized to uint16, normals
> reduced to a single per-vertex depth proxy.
