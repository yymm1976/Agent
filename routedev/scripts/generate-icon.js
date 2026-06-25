// scripts/generate-icon.js
// 生成 RouteDev 应用图标：build/icon.png (512x512) 与 build/icon.ico (256x256)
// 设计：深蓝圆角方形背景 (#0a0e14) + 蓝色字母 "R" (#3b82f6)
// 纯 Node.js 实现，不依赖 canvas，使用 zlib 自行编码 PNG。

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, '../build');

// 品牌色
const BG = [0x0a, 0x0e, 0x14]; // 深蓝背景
const FG = [0x3b, 0x82, 0xf6]; // 蓝色字母 R

// "R" 字母位图（1=填充），12 宽 x 16 高
const R_BITMAP = [
  '............',
  '.11111111...',
  '.111...111..',
  '.111...111..',
  '.111...111..',
  '.111...111..',
  '.11111111...',
  '.111.111....',
  '.111..111...',
  '.111...111..',
  '.111....111.',
  '.111....111.',
  '.111....111.',
  '.111....111.',
  '............',
  '............',
];

/**
 * 计算 PNG chunk 的 CRC32
 */
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 构造一个 PNG chunk */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * 渲染一张 RGBA 位图
 * @param {number} size 边长（像素）
 * @returns {Buffer} 原始像素数据（含每行行首 filter 字节）
 */
function renderPixels(size) {
  // 圆角半径
  const radius = Math.round(size * 0.18);
  // 字母区域：留 12.5% 边距
  const pad = Math.round(size * 0.125);
  const letterArea = size - pad * 2;
  const bw = R_BITMAP[0].length;
  const bh = R_BITMAP.length;
  const scale = Math.floor(letterArea / Math.max(bw, bh));
  const letterW = bw * scale;
  const letterH = bh * scale;
  const offX = Math.round((size - letterW) / 2);
  const offY = Math.round((size - letterH) / 2);

  // 每行 = 1 字节 filter(0) + size*4 字节 RGBA
  const rowLen = 1 + size * 4;
  const raw = Buffer.alloc(rowLen * size);

  for (let y = 0; y < size; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      // 圆角判定：四角外的像素透明
      let alpha = 255;
      const inCorner =
        (x < radius && y < radius) ||
        (x >= size - radius && y < radius) ||
        (x < radius && y >= size - radius) ||
        (x >= size - radius && y >= size - radius);
      if (inCorner) {
        const cx = x < radius ? radius : size - 1 - radius;
        const cy = y < radius ? radius : size - 1 - radius;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > radius * radius) alpha = 0;
      }
      // 判定是否落在 R 字母上
      let isLetter = false;
      const lx = x - offX;
      const ly = y - offY;
      if (lx >= 0 && ly >= 0 && lx < letterW && ly < letterH) {
        const bx = Math.floor(lx / scale);
        const by = Math.floor(ly / scale);
        if (R_BITMAP[by][bx] === '1') isLetter = true;
      }
      const color = isLetter ? FG : BG;
      raw[px] = color[0];
      raw[px + 1] = color[1];
      raw[px + 2] = color[2];
      raw[px + 3] = alpha;
    }
  }
  return raw;
}

/** 编码 PNG 文件 */
function encodePng(size) {
  const raw = renderPixels(size);
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 编码 ICO 文件（内嵌一张 256x256 PNG） */
function encodeIco(pngSize) {
  const png = encodePng(pngSize);
  // ICO 头 6 字节 + 目录项 16 字节
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = ICO
  header.writeUInt16LE(1, 4); // count = 1
  const dir = Buffer.alloc(16);
  // 256 在字节中用 0 表示
  dir[0] = pngSize >= 256 ? 0 : pngSize;
  dir[1] = pngSize >= 256 ? 0 : pngSize;
  dir[2] = 0; // color count
  dir[3] = 0; // reserved
  dir.writeUInt16LE(1, 4); // planes
  dir.writeUInt16LE(0, 6); // bit count = 0 表示 PNG
  dir.writeUInt32LE(png.length, 8); // 数据大小
  dir.writeUInt32LE(6 + 16, 12); // 数据偏移
  return Buffer.concat([header, dir, png]);
}

async function main() {
  await mkdir(buildDir, { recursive: true });
  const png512 = encodePng(512);
  const ico = encodeIco(256);
  const pngPath = path.join(buildDir, 'icon.png');
  const icoPath = path.join(buildDir, 'icon.ico');
  await writeFile(pngPath, png512);
  await writeFile(icoPath, ico);
  // 校验：输出文件 hash 前几位，便于确认非空
  const pngHash = createHash('sha256').update(png512).digest('hex').slice(0, 12);
  const icoHash = createHash('sha256').update(ico).digest('hex').slice(0, 12);
  console.log(`[icon] 已生成 ${pngPath} (${png512.length} bytes, sha256:${pngHash})`);
  console.log(`[icon] 已生成 ${icoPath} (${ico.length} bytes, sha256:${icoHash})`);
}

main().catch((err) => {
  console.error('[icon] 生成失败:', err);
  process.exit(1);
});
