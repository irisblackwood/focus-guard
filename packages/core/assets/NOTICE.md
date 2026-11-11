# 第三方数据说明（`packages/core/assets/`）

## `cortex.bin`

| 项 | 值 |
|---|---|
| 内容 | 人脑 pial 表面（软膜面）点云，27,638 点，每点 `x,y,z`（uint16 量化）+ 沟深代理（uint8） |
| 来源 | FreeSurfer 导出的 `lh.pial.ply` / `rh.pial.ply`（ASCII PLY，289,561 顶点）降采样 |
| 生成 | `node packages/core/tools/make-cortex-asset.mjs <pial_Full_ply 目录>` |
| 许可 | **CC BY-SA 3.0**（源数据来自 memory-brain，Anderson Winkler） |
| 与主许可的关系 | 本仓代码为 **AGPL-3.0-only**。CC BY-SA 3.0 与 AGPL 不兼容，因此本目录**整体按 CC BY-SA 3.0 授权**，作为独立作品与代码并列分发（mere aggregation），不并入程序源码。 |

### 为什么不进 npm 包

`packages/core/package.json` 的 `files` 白名单不含 `assets/`。npm 上分发的是 AGPL 代码，
若把 CC BY-SA 数据一并打包，等于把两种互不兼容的 copyleft 条款压进同一个 tarball。

所以：

- **GitHub clone / 下载 release**：有 `assets/cortex.bin`，脑用真皮层网格渲染。
- **`npm i focus-guard`**：没有这个文件，脑退回程序化沟回（解析椭球 + 噪声刻槽），
  输出会明写「解析椭球（未找到 assets/cortex.bin，形状是算的）」。

两条路都可用，差别如实报出来，不假装一样。

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
