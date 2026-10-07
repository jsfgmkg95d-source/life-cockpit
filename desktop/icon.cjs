// Original Life Cockpit compass artwork. Copyright (c) Life Cockpit contributors.
// Released under the repository's MIT license. No external artwork is embedded.
const { deflateSync } = require('node:zlib');

const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="16" fill="#18253b"/><circle cx="32" cy="32" r="21" fill="none" stroke="#66c4b1" stroke-width="2"/><path d="m43 20-7 16-16 7 7-16Z" fill="#b9a9e9"/><path d="m43 20-7 16-9-9Z" fill="#f4f5f3"/><circle cx="32" cy="32" r="2.5" fill="#18253b"/></svg>\n';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const label = Buffer.from(type), result = Buffer.alloc(body.length + 12);
  result.writeUInt32BE(body.length, 0); label.copy(result, 4); body.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([label, body])), body.length + 8);
  return result;
}

function inPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Analytic rasterization of the SVG geometry, with 4x supersampling for tray sizes.
function colorAt(x, y) {
  const roundedX = Math.max(18 - x, 0, x - 46), roundedY = Math.max(18 - y, 0, y - 46);
  if (Math.hypot(roundedX, roundedY) > 16) return [0, 0, 0, 0];
  let color = [24, 37, 59, 255];
  if (Math.abs(Math.hypot(x - 32, y - 32) - 21) <= 1) color = [102, 196, 177, 255];
  if (inPolygon(x, y, [[43, 20], [36, 36], [20, 43], [27, 27]])) color = [185, 169, 233, 255];
  if (inPolygon(x, y, [[43, 20], [36, 36], [27, 27]])) color = [244, 245, 243, 255];
  if (Math.hypot(x - 32, y - 32) <= 2.5) color = [24, 37, 59, 255];
  return color;
}

function iconPng(size = 64) {
  if (!Number.isInteger(size) || size < 16 || size > 512) throw new RangeError('Icon size must be an integer from 16 to 512.');
  const rows = Buffer.alloc(size * (size * 4 + 1)), samples = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sum = [0, 0, 0, 0];
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const color = colorAt((x + (sx + .5) / samples) * 64 / size, (y + (sy + .5) / samples) * 64 / size);
      for (let channel = 0; channel < 3; channel++) sum[channel] += color[channel] * color[3] / 255;
      sum[3] += color[3];
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    for (let channel = 0; channel < 3; channel++) rows[offset + channel] = sum[3] ? Math.round(sum[channel] * 255 / sum[3]) : 0;
    rows[offset + 3] = Math.round(sum[3] / (samples * samples));
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function iconIco() {
  const sizes = [16, 24, 32, 48, 64, 128, 256], images = sizes.map(iconPng);
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  for (let index = 0; index < images.length; index++) {
    const start = 6 + index * 16;
    header[start] = sizes[index] % 256; header[start + 1] = sizes[index] % 256;
    header.writeUInt16LE(1, start + 4); header.writeUInt16LE(32, start + 6);
    header.writeUInt32LE(images[index].length, start + 8); header.writeUInt32LE(offset, start + 12);
    offset += images[index].length;
  }
  return Buffer.concat([header, ...images]);
}

function loadIcon(nativeImage, size = 256) {
  return nativeImage.createFromBuffer(iconPng(size));
}

module.exports = { iconSvg, iconPng, iconIco, loadIcon };
