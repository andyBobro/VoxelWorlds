import type { VwgHeader } from './contract';

export interface VwgData {
  header: VwgHeader;
  x: Int32Array;
  y: Int32Array;
  z: Int32Array;
  c: Uint16Array;
}

const align4 = (n: number): number => (n + 3) & ~3;

/**
 * Parse a VWG1 container. Typed arrays are zero-copy views over `buf`
 * (host must be little-endian, which holds for every Electron target).
 */
export function parseVwg(buf: ArrayBuffer): VwgData {
  // Tolerate Node Buffers / typed-array views that slipped through IPC.
  if (!(buf instanceof ArrayBuffer) && ArrayBuffer.isView(buf as unknown)) {
    const v = buf as unknown as ArrayBufferView;
    buf = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  const total = buf.byteLength;
  if (total < 8) throw new Error(`VWG: file too small (${total} bytes)`);

  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'VWG1') throw new Error(`VWG: bad magic "${magic}", expected "VWG1"`);

  const headerLen = dv.getUint32(4, true);
  if (8 + headerLen > total) {
    throw new Error(`VWG: header length ${headerLen} exceeds file size ${total}`);
  }

  let header: VwgHeader;
  try {
    header = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(buf, 8, headerLen))) as VwgHeader;
  } catch (e) {
    throw new Error(`VWG: header JSON is invalid (${(e as Error).message})`);
  }
  if (!header || header.version !== 1) throw new Error(`VWG: unsupported version ${String(header?.version)}`);
  const n = header.voxelCount;
  if (!Number.isInteger(n) || n < 0) throw new Error(`VWG: invalid voxelCount ${String(n)}`);
  if (!(header.voxelSize > 0)) throw new Error(`VWG: invalid voxelSize ${String(header.voxelSize)}`);
  if (!Array.isArray(header.palette) || header.palette.length === 0) throw new Error('VWG: empty palette');

  const start = align4(8 + headerLen);
  const need = start + 12 * n + align4(2 * n);
  if (need > total) {
    throw new Error(
      `VWG: truncated payload, need ${need} bytes for ${n} voxels but file has ${total}`,
    );
  }

  const x = new Int32Array(buf, start, n);
  const y = new Int32Array(buf, start + 4 * n, n);
  const z = new Int32Array(buf, start + 8 * n, n);
  const c = new Uint16Array(buf, start + 12 * n, n);
  return { header, x, y, z, c };
}
