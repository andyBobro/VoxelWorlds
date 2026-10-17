// Generates build/icon.icns (placeholder isometric voxel cube) using zlib + sips + iconutil. Skips if present.
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build', 'icon.icns');
if (existsSync(out)) process.exit(0);
if (process.platform !== 'darwin') throw new Error('make-icon requires macOS (sips/iconutil)');

const S = 1024;
const px = Buffer.alloc(S * S * 4);
const inRoundRect = (x, y) => {
  const m = 80, r = 190;
  const cx = Math.min(Math.max(x, m + r), S - m - r), cy = Math.min(Math.max(y, m + r), S - m - r);
  return x >= m && x < S - m && y >= m && y < S - m && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
// isometric cube: hexagon split into top / left / right faces
const hx = S / 2, hy = S / 2, R = 300;
const sign = (px_, py_, ax, ay, bx, by) => (px_ - bx) * (ay - by) - (ax - bx) * (py_ - by);
const inTri = (x, y, a, b, c) => {
  const d1 = sign(x, y, ...a, ...b), d2 = sign(x, y, ...b, ...c), d3 = sign(x, y, ...c, ...a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const k = R * Math.sin(Math.PI / 3), h = R / 2;
const top = [[hx, hy - R], [hx + k, hy - h], [hx, hy], [hx - k, hy - h]];
const left = [[hx - k, hy - h], [hx, hy], [hx, hy + R], [hx - k, hy + h]];
const right = [[hx + k, hy - h], [hx + k, hy + h], [hx, hy + R], [hx, hy]];
const inQuad = (x, y, q) => inTri(x, y, q[0], q[1], q[2]) || inTri(x, y, q[0], q[2], q[3]);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (!inRoundRect(x, y)) continue;
    let c = [24 + (y / S) * 20, 28 + (y / S) * 22, 40 + (y / S) * 30];
    if (inQuad(x, y, top)) c = [124, 214, 120];
    else if (inQuad(x, y, left)) c = [80, 150, 90];
    else if (inQuad(x, y, right)) c = [56, 110, 70];
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  }
}
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k2 = 0; k2 < 8; k2++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

const set = join(root, 'build', 'icon.iconset');
rmSync(set, { recursive: true, force: true });
mkdirSync(set, { recursive: true });
const base = join(set, 'base.png');
writeFileSync(base, png);
for (const s of [16, 32, 128, 256, 512]) {
  for (const [sc, suf] of [[1, ''], [2, '@2x']]) {
    const px2 = s * sc;
    execFileSync('sips', ['-z', String(px2), String(px2), base, '--out', join(set, `icon_${s}x${s}${suf}.png`)], { stdio: 'ignore' });
  }
}
rmSync(base);
execFileSync('iconutil', ['-c', 'icns', set, '-o', out]);
rmSync(set, { recursive: true, force: true });
console.log('wrote', out);
