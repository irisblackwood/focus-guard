#!/usr/bin/env node
/**
 * 皮层资产生成器（tools/make-cortex-asset.mjs，2026-11-11）
 *
 * ── 为什么要有这一步 ──────────────────────────────────────────────
 * 模板版（`brain-view.html`）的脑壳此前是 `cortexAt()` 算出来的光滑椭球：
 * 三个数学函数 + 0.022 的噪声起伏。它和本机皮层版（真 PLY 网格）摆在一起，
 * 一眼就是两个东西——用户的原话是「关键是从外观上也长得不一样啊」。
 *
 * 真 PLY 在仓库外（`pial_Full_ply/lh.pial.ply` + `rh.pial.ply`，
 * ASCII 19 MB / 289,561 顶点），既不能进 git 也不能进 npm。所以这里把它
 * **降采样 + 量化**成一份 200 KB 级的二进制资产，随仓库分发。
 *
 * ── 判据 ──────────────────────────────────────────────────────────
 * ① 只留**位置**与**沟深代理**，不留面片。模板版画的是点云，面片用不上；
 *    留面片要多 10 倍字节，换不来一个像素。
 * ② 位置量化到 uint16。脑壳归一化后落在 [-1,1]，2/65535 = 3e-5，
 *    比屏幕像素小两个数量级，肉眼无差。
 * ③ 沟深代理沿用 `build-brain2.mjs` 的口径：**法线与径向的夹角**。
 *    沟底的法线偏离径向，回顶的法线顺着径向——这是真几何给的，
 *    不是再拿噪声编一层。压成 1 字节（0..255 → 0.25..1.0 亮度）。
 * ④ 两半球**分别降采样**，步长各自算。混在一起按全局步长抽，
 *    点数少的那侧会被抽稀，左右不对称——那是最容易被一眼看穿的假。
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *   node packages/core/tools/make-cortex-asset.mjs <pial_Full_ply 目录>
 * 默认读 `--target=29000`（单侧约 14.5k）。产物：
 *   packages/core/assets/cortex.bin
 *
 * ── 许可 ──────────────────────────────────────────────────────────
 * 源数据 `pial_Full_ply` 属 CC BY-SA 3.0，与本仓 AGPL-3.0-only **不兼容**，
 * 因此产物放在 `assets/`（不进 npm `files`），只随 GitHub 分发，见同目录 NOTICE.md。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "assets", "cortex.bin");

const argv = process.argv.slice(2);
const srcDir = resolve(argv.find((a) => !a.startsWith("--")) || "");
const target = Number((argv.find((a) => a.startsWith("--target=")) || "--target=29000").split("=")[1]);

if (!existsSync(srcDir)) {
  process.stderr.write(
    `找不到皮层源目录：${srcDir || "(未给)"}\n` +
      `用法：node tools/make-cortex-asset.mjs <pial_Full_ply 目录> [--target=29000]\n` +
      `源数据不在版本库里（CC BY-SA 3.0，19 MB），只在本地实验目录。\n` +
      `没有它就只能用模板版的光滑椭球——这是已知且已如实标注的降级。\n`
  );
  process.exit(1);
}

/** 读一个 FreeSurfer ASCII PLY。返回顶点（已换成 three 坐标）与面。 */
function readPly(file) {
  const txt = readFileSync(file, "utf8");
  const headEnd = txt.indexOf("end_header");
  const header = txt.slice(0, headEnd).split("\n");
  const num = (kw) => Number((header.find((l) => l.trim().startsWith(kw)) || "").trim().split(/\s+/)[2]);
  const vcount = num("element vertex");
  const fcount = num("element face");
  /* `end_header` 之后还要吃掉它自己那一行的换行符——`+10` 只跳过 10 个字符，
     会把 `\n` 留在正文第一行，于是第 0 个顶点读到空串，整份坐标全是 NaN。
     按"下一个换行之后"取，且滤掉空行（PLY 正文里没有空行，有也是脏数据）。 */
  const body = txt.slice(txt.indexOf("\n", headEnd) + 1).split("\n").filter((l) => l.trim().length > 0);
  const verts = new Float64Array(vcount * 3);
  const faces = new Uint32Array(fcount * 3);
  let p = 0;
  for (let i = 0; i < vcount; i++, p++) {
    const t = body[p].trim().split(/\s+/);
    // FreeSurfer (x 右, y 前, z 上) → three (x, 上, 前)
    verts[i * 3] = +t[0];
    verts[i * 3 + 1] = +t[2];
    verts[i * 3 + 2] = +t[1];
  }
  for (let i = 0; i < fcount; i++, p++) {
    const t = body[p].trim().split(/\s+/);
    faces[i * 3] = +t[1];
    faces[i * 3 + 1] = +t[2];
    faces[i * 3 + 2] = +t[3];
  }
  return { verts, faces, vcount };
}

process.stdout.write("读 PLY…\n");
const LH = readPly(join(srcDir, "lh.pial.ply"));
const RH = readPly(join(srcDir, "rh.pial.ply"));

/* 两半球拼在一起先做**统一的**归一化：分别归一化会让左右大小不等。
   中心取包围盒中心而不是顶点质心——质心会被顶点密的地方拉偏。 */
const NV = LH.vcount + RH.vcount;
const all = new Float64Array(NV * 3);
all.set(LH.verts, 0);
all.set(RH.verts, LH.vcount * 3);
const mn = [Infinity, Infinity, Infinity];
const mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < NV; i++) {
  for (let a = 0; a < 3; a++) {
    const v = all[i * 3 + a];
    if (v < mn[a]) mn[a] = v;
    if (v > mx[a]) mx[a] = v;
  }
}
const ctr = [0, 1, 2].map((a) => (mn[a] + mx[a]) / 2);
let ext = 0;
for (let i = 0; i < NV; i++) {
  for (let a = 0; a < 3; a++) ext = Math.max(ext, Math.abs(all[i * 3 + a] - ctr[a]));
}
const K = 1 / ext;
for (let i = 0; i < NV; i++) {
  for (let a = 0; a < 3; a++) all[i * 3 + a] = (all[i * 3 + a] - ctr[a]) * K;
}
process.stdout.write(`  ${NV} 顶点，归一化到最大半径 1.0（缩放 ${K.toExponential(3)}）\n`);

/* 顶点法线：按面积加权（叉积不归一化就是面积权重）。
   只在**各自半球内部**累加——跨半球的假面片会把法线拉向内侧，沟深代理就全错了。 */
process.stdout.write("算法线…\n");
const vn = new Float64Array(NV * 3);
const addNormals = (faces, offset) => {
  for (let f = 0; f < faces.length; f += 3) {
    const a = (faces[f] + offset) * 3;
    const b = (faces[f + 1] + offset) * 3;
    const c = (faces[f + 2] + offset) * 3;
    const e1x = all[b] - all[a], e1y = all[b + 1] - all[a + 1], e1z = all[b + 2] - all[a + 2];
    const e2x = all[c] - all[a], e2y = all[c + 1] - all[a + 1], e2z = all[c + 2] - all[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const o of [a, b, c]) { vn[o] += nx; vn[o + 1] += ny; vn[o + 2] += nz; }
  }
};
addNormals(LH.faces, 0);
addNormals(RH.faces, LH.vcount);

/* 降采样：两半球各自定步长，保证左右点数相当。 */
const half = Math.round(target / 2);
const stepOf = (n) => Math.max(1, Math.ceil(n / half));
const stepL = stepOf(LH.vcount);
const stepR = stepOf(RH.vcount);
const pickL = Math.ceil(LH.vcount / stepL);
const pickR = Math.ceil(RH.vcount / stepR);
const count = pickL + pickR;
process.stdout.write(`降采样：lh 步长 ${stepL}（${pickL} 点）· rh 步长 ${stepR}（${pickR} 点）· 合计 ${count}\n`);

/* 二进制布局（小端）：
 *   0   "FGCX"            magic
 *   4   u16  version = 1
 *   6   u16  保留
 *   8   u32  count
 *  12   f32 × 6           归一化用的包围盒（min xyz, max xyz），解码端据此还原
 *  36   count × 7 字节    x,y,z 各 u16 + grv u8
 * 取 12 而不是 8 起算，是为了让 f32 落在 4 字节边界上。 */
const HEAD = 36;
const buf = Buffer.alloc(HEAD + count * 7);
buf.write("FGCX", 0, "latin1");
buf.writeUInt16LE(1, 4);
buf.writeUInt16LE(0, 6);
buf.writeUInt32LE(count, 8);
/* 归一化后的真实包围盒（不是 [-1,1]——各轴半径不同，x 只有 0.84 那么长）。 */
const nmn = [Infinity, Infinity, Infinity];
const nmx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < NV; i++) {
  for (let a = 0; a < 3; a++) {
    const v = all[i * 3 + a];
    if (v < nmn[a]) nmn[a] = v;
    if (v > nmx[a]) nmx[a] = v;
  }
}
for (let a = 0; a < 3; a++) {
  buf.writeFloatLE(nmn[a], 12 + a * 4);
  buf.writeFloatLE(nmx[a], 24 + a * 4);
}
const span = [0, 1, 2].map((a) => nmx[a] - nmn[a] || 1);

let o = HEAD;
const put = (vi) => {
  for (let a = 0; a < 3; a++) {
    const q = Math.round(((all[vi * 3 + a] - nmn[a]) / span[a]) * 65535);
    buf.writeUInt16LE(Math.max(0, Math.min(65535, q)), o);
    o += 2;
  }
  /* 沟深代理 = |法线 · 径向|。顺着径向（回顶）→ 1，偏离（沟底）→ 0。
     映射到 0.25..1.0 的亮度区间，和 build-brain2 的 meshGrv 同一口径。 */
  const x = all[vi * 3], y = all[vi * 3 + 1], z = all[vi * 3 + 2];
  const rl = Math.hypot(x, y, z) || 1;
  const nx = vn[vi * 3], ny = vn[vi * 3 + 1], nz = vn[vi * 3 + 2];
  const nl = Math.hypot(nx, ny, nz) || 1;
  const align = Math.abs((nx * x + ny * y + nz * z) / (nl * rl));
  const grv = 0.25 + 0.75 * Math.min(1, align);
  buf.writeUInt8(Math.round(grv * 255), o);
  o += 1;
};
for (let i = 0, n = 0; n < pickL; i += stepL, n++) put(i);
for (let i = 0, n = 0; n < pickR; i += stepR, n++) put(LH.vcount + i);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buf);
process.stdout.write(`\n${OUT}\n  ${count} 点 · ${buf.length} 字节（${(buf.length / 1024).toFixed(0)} KB）\n`);
