/**
 * 生成扩展图标 PNG（自绘光栅化，无第三方依赖）
 *
 * 图标设计：紫色渐变圆角方块 + 白色「照片卡片」+ 两个山形 + 一个太阳点，
 * 语义对应「从商品页里取出图片」。
 *
 * 用法：node tools/make-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { encodePng, isValidPng, readPngSize } = require('./png');

const OUT_DIR = path.join(__dirname, '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // 每像素 4x4 超采样，用于抗锯齿

/* ---------------- 几何判定（坐标均为 0..1 归一化） ---------------- */

function inRoundRect(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(u, v, cx, cy, r) {
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(u, v, ax, ay, bx, by, cx, cy) {
  const d1 = (u - bx) * (ay - by) - (ax - bx) * (v - by);
  const d2 = (u - cx) * (by - cy) - (bx - cx) * (v - cy);
  const d3 = (u - ax) * (cy - ay) - (cx - ax) * (v - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/* ---------------- 调色板 ---------------- */

const GRAD_FROM = [167, 139, 250]; // #a78bfa
const GRAD_TO = [109, 40, 217]; //   #6d28d9
const WHITE = [255, 255, 255];
const SUN = [167, 139, 250]; //     #a78bfa
const MOUNT_1 = [124, 58, 237]; //  #7c3aed
const MOUNT_2 = [196, 181, 253]; // #c4b5fd

function gradientColor(u, v) {
  const t = Math.min(1, Math.max(0, (u + v) / 2));
  return [
    Math.round(GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t),
    Math.round(GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t),
    Math.round(GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t)
  ];
}

/**
 * 对单个采样点求色；按「背景 → 卡片 → 太阳 → 山」的顺序绘制，后画的直接覆盖。
 * @returns {[number,number,number,number]} RGBA
 */
function sample(u, v) {
  // 背景：圆角方块 + 渐变
  if (inRoundRect(u, v, 0, 0, 1, 1, 0.22)) {
    const g = gradientColor(u, v);
    let rgb = g;

    // 白色照片卡片
    if (inRoundRect(u, v, 0.2, 0.24, 0.8, 0.76, 0.1)) {
      rgb = WHITE;

      // 太阳点
      if (inCircle(u, v, 0.34, 0.37, 0.055)) rgb = SUN;

      // 主山峰
      if (inTriangle(u, v, 0.22, 0.7, 0.5, 0.42, 0.78, 0.7)) rgb = MOUNT_1;

      // 次山峰（叠在主峰前面，形成层次）
      if (inTriangle(u, v, 0.44, 0.7, 0.61, 0.54, 0.78, 0.7)) rgb = MOUNT_2;
    }

    return [rgb[0], rgb[1], rgb[2], 255];
  }
  return [0, 0, 0, 0];
}

/** 渲染指定尺寸的图标像素 */
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const n = SS * SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const c = sample(u, v);
          r += c[0];
          g += c[1];
          b += c[2];
          a += c[3];
        }
      }

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = Math.round(a / n);
    }
  }

  return encodePng(size, size, rgba);
}

/* ---------------- 写入文件 ---------------- */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  SIZES.forEach(function (size) {
    const buf = render(size);
    const file = path.join(OUT_DIR, size + '.png');
    fs.writeFileSync(file, buf);

    // 回读校验：PNG 结构完整、宽高正确
    const back = fs.readFileSync(file);
    const dim = readPngSize(back);
    const ok = isValidPng(back) && dim && dim.width === size && dim.height === size;
    console.log(
      (ok ? 'OK   ' : 'FAIL ') + file + '  ' + back.length + ' bytes  ' + (dim ? dim.width + 'x' + dim.height : 'invalid')
    );
    if (!ok) process.exitCode = 1;
  });
}

main();
