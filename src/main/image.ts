/** Pure image-header helpers (no electron): dimensions for decompression-bomb checks and EXIF orientation. */

export interface ImageInfo {
  width: number; // stored (un-rotated) pixel size
  height: number;
  /** EXIF orientation 1..8 (1 when absent / not JPEG) */
  orientation: number;
}

export const MAX_PIXELS = 100_000_000;

const u16be = (b: Buffer, o: number): number => b.readUInt16BE(o);

function jpegOrientation(b: Buffer, app1: number, len: number): number {
  // app1 = offset of "Exif\0\0"; TIFF header follows.
  const t = app1 + 6;
  const end = Math.min(b.length, app1 + len);
  if (t + 8 > end) return 1;
  const le = b.toString('latin1', t, t + 2) === 'II';
  if (!le && b.toString('latin1', t, t + 2) !== 'MM') return 1;
  const r16 = (o: number): number => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const r32 = (o: number): number => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = t + r32(t + 4);
  if (ifd + 2 > end) return 1;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** Returns null when the header is not a recognisable PNG / JPEG / WEBP. Never decodes pixels. */
export function readImageInfo(b: Buffer): ImageInfo | null {
  try {
    if (b.length >= 24 && b.toString('latin1', 1, 4) === 'PNG') {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), orientation: 1 };
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let o = 2;
      let orientation = 1;
      while (o + 4 <= b.length) {
        if (b[o] !== 0xff) {
          o++;
          continue;
        }
        const m = b[o + 1];
        if (m === 0xff) {
          o++;
          continue;
        }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
          o += 2;
          continue;
        }
        const len = u16be(b, o + 2);
        if (m === 0xe1 && b.toString('latin1', o + 4, o + 10) === 'Exif\0\0') {
          orientation = jpegOrientation(b, o + 4, len - 2);
        }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { height: u16be(b, o + 5), width: u16be(b, o + 7), orientation };
        }
        o += 2 + len;
      }
      return null;
    }
    if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const fourcc = b.toString('latin1', 12, 16);
      if (fourcc === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, orientation: 1 };
      if (fourcc === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, orientation: 1 };
      }
      if (fourcc === 'VP8X') {
        return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1, orientation: 1 };
      }
    }
  } catch {
    /* truncated */
  }
  return null;
}

/** Size after applying EXIF orientation (swapped for 5-8), i.e. python's exif_transpose frame. */
export function orientedSize(w: number, h: number, orientation: number): { width: number; height: number } {
  return orientation >= 5 && orientation <= 8 ? { width: h, height: w } : { width: w, height: h };
}

/** Rotate/flip a 4-byte-per-pixel bitmap into the EXIF-oriented frame. */
export function orientBitmap(src: Buffer, w: number, h: number, orientation: number): { data: Buffer; width: number; height: number } {
  if (orientation <= 1 || orientation > 8) return { data: src, width: w, height: h };
  const { width: dw, height: dh } = orientedSize(w, h, orientation);
  const dst = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      switch (orientation) {
        case 2: nx = w - 1 - x; ny = y; break;
        case 3: nx = w - 1 - x; ny = h - 1 - y; break;
        case 4: nx = x; ny = h - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = h - 1 - y; ny = x; break;
        case 7: nx = h - 1 - y; ny = w - 1 - x; break;
        default: nx = y; ny = w - 1 - x; break; // 8
      }
      src.copy(dst, (ny * dw + nx) * 4, (y * w + x) * 4, (y * w + x) * 4 + 4);
    }
  }
  return { data: dst, width: dw, height: dh };
}
