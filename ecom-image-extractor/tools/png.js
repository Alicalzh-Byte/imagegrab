/**
 * 极简 PNG 编码器（无第三方依赖，仅用 Node 内置 zlib）
 * 供 tools/make-icons.js 生成扩展图标、test/serve.js 生成测试图片使用。
 */
'use strict';

const zlib = require('zlib');

/* CRC32 查表 */
const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG chunk：长度 + 类型 + 数据 + CRC */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * 把 RGBA 像素数组编码为 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度必须为 width*height*4
 * @returns {Buffer} 完整的 PNG 文件内容
 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  // 每行前加 1 字节的 filter 类型（0 = None）
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 过滤方法
  ihdr[12] = 0; // 隔行扫描

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 签名
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * 生成一张纯色 PNG（测试用的占位图）。
 */
function solidPng(width, height, rgb) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(width, height, rgba);
}

/** 校验一段 Buffer 是否是结构完整的 PNG */
function isValidPng(buf) {
  if (buf.length < 8 + 25) return false;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return false;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return false;
  if (buf.toString('latin1', buf.length - 8, buf.length - 4) !== 'IEND') return false;
  return true;
}

/** 读取 PNG 的宽高（仅支持我们生成的格式） */
function readPngSize(buf) {
  if (!isValidPng(buf)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

module.exports = { encodePng, solidPng, isValidPng, readPngSize };
