import { app, dialog, ipcMain, nativeImage, BrowserWindow, type WebContents } from 'electron';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { CH } from '../shared/channels';
import type { AnalyzeFacadeParams, BBox, DetailParams, ExportFormat, GenerateParams } from '../shared/contract';
import {
  BridgeError,
  PythonBridge,
  type AnalyzeFacadeResult,
  type DetailResult,
  type ExportResult,
  type GenerateResult,
} from './pythonBridge';
import {
  MAX_PHOTO_BYTES,
  PHOTO_EXTS,
  validateAnalyzeFacade,
  validateBuildingIndex,
  validateDetail,
  validateDetailStats,
  validateFacadeSpec,
  validateGenerate,
} from './validate';
import { MAX_PIXELS, orientBitmap, orientedSize, readImageInfo } from './image';

/** Preview limits for pickPhoto (data: URL; the CSP already allows `img-src data:`). */
const PREVIEW_MAX_SIDE = 2048;
const PREVIEW_RAW_MAX_BYTES = 6 * 1024 * 1024;
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const FORMATS: Record<ExportFormat, { name: string; ext: string }> = {
  vox: { name: 'MagicaVoxel', ext: 'vox' },
  schem: { name: 'Sponge Schematic', ext: 'schem' },
  json: { name: 'JSON', ext: 'json' },
};

function fail(e: unknown): never {
  if (e instanceof BridgeError) throw new Error(`${e.code}: ${e.message}`);
  throw e instanceof Error ? e : new Error(String(e));
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export function registerIpc(getWindow: () => BrowserWindow | null): PythonBridge {
  const tempDir = join(app.getPath('temp'), 'voxelworlds');
  mkdirSync(tempDir, { recursive: true });

  /** Temp artefacts (vwg, sidecar json, rectified png) that must survive the next cleanup. */
  const keep = new Set<string>();
  const cleanTemp = (): void => {
    try {
      for (const f of readdirSync(tempDir)) {
        if (!/^vw-.*\.(vwg|json|png|part)$/.test(f)) continue;
        const full = resolve(tempDir, f);
        if (keep.has(full)) continue;
        try {
          unlinkSync(full);
        } catch {
          /* best effort */
        }
      }
    } catch {
      /* temp dir missing */
    }
  };
  cleanTemp(); // leftovers from a crashed session
  app.on('will-quit', () => {
    keep.clear();
    cleanTemp();
  });

  const send = (channel: string, payload: unknown): void => {
    const wc: WebContents | undefined = getWindow()?.webContents;
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  };

  /** Job ids the user cancelled; their late progress/result is ignored. */
  const abandoned = new Set<string>();

  const bridge = new PythonBridge({
    root: app.getAppPath(),
    packaged: app.isPackaged,
    tempDir,
    listeners: {
      onProgress: ({ id, stage, pct, message, tile }) => {
        if (!abandoned.has(id)) send(CH.progress, { stage, pct, message, ...(tile ? { tile } : {}) });
      },
      onWarning: ({ id, code, message }) => {
        if (!abandoned.has(id)) send(CH.warning, { code, message });
      },
      onLog: (line) => send(CH.log, line),
    },
  });

  let currentJob: string | null = null;
  let cancelJob: (() => void) | null = null;
  /** .vwg that exportAs uses by default: last generate, or whichever known .vwg the renderer last read. */
  let exportVwg: string | null = null;
  let genVwg: string | null = null;
  let detailVwg: string | null = null;
  let genIndex: string | null = null;
  let rectified: string | null = null;
  const knownVwg = new Set<string>();
  const knownIndex = new Set<string>();
  let lastBBox: BBox | null = null;
  /** photoPath -> multipliers from preview pixels to python's (EXIF-oriented original) pixels */
  const knownPhotos = new Map<string, { sx: number; sy: number }>();

  const rekeep = (): void => {
    keep.clear();
    for (const p of [genVwg, detailVwg, genIndex, rectified]) if (p) keep.add(resolve(p));
    cleanTemp();
  };

  /**
   * One long job at a time (generate, analyzeFacade, detail share the slot). Settles immediately on cancel;
   * a late result of an abandoned job is discarded via `discard`.
   */
  async function runJob<R extends { kind: string }>(
    prefix: string,
    busyMsg: string,
    send_: (id: string) => Promise<R>,
    discard: (r: R) => string[],
  ): Promise<R | { __voxelError: string }> {
    if (currentJob) throw new Error(`BAD_REQUEST: ${busyMsg}`);
    const id = bridge.newId(prefix);
    currentJob = id;
    const cancelled = new Promise<never>((_, reject) => {
      cancelJob = () => reject(new Error('CANCELLED: job cancelled'));
    });
    cancelled.catch(() => undefined);
    let got: R | undefined;
    const req = send_(id).then((r) => {
      got = r;
      return r;
    });
    try {
      return await Promise.race([req, cancelled]);
    } catch (e) {
      // The result arrived in the same tick as the cancel: treat it as success, do not discard its files.
      if (got !== undefined) return got;
      if (e instanceof BridgeError && e.code === 'BAD_REQUEST' && /already running/i.test(e.message)) {
        return {
          __voxelError:
            'BUSY: the previous (cancelled) job is still stopping in the backend, usually while a network request finishes. Wait a few seconds and try again.',
        };
      }
      // Expected rejection: hand it to the preload as data so Electron does not log a handler error.
      if (e instanceof Error && e.message.startsWith('CANCELLED:')) return { __voxelError: e.message };
      if (e instanceof BridgeError && e.code === 'CANCELLED') return { __voxelError: `${e.code}: ${e.message}` };
      return fail(e);
    } finally {
      if (abandoned.has(id) && got !== undefined) abandoned.delete(id);
      else if (abandoned.has(id)) {
        req.then(
          (r) => {
            abandoned.delete(id);
            for (const p of discard(r)) {
              try {
                unlinkSync(p);
              } catch {
                /* best effort */
              }
            }
          },
          () => abandoned.delete(id),
        );
      }
      if (currentJob === id) currentJob = null;
      cancelJob = null;
    }
  }

  ipcMain.handle(CH.generate, async (_e, params: GenerateParams) => {
    if (currentJob) throw new Error('BAD_REQUEST: a generation is already running');
    validateGenerate(params);
    const out = await runJob<GenerateResult>(
      'gen',
      'a generation is already running',
      (id) => bridge.request<GenerateResult>({ id, type: 'generate', params }),
      (r) => [r.vwgPath, ...(r.stats.buildingIndexPath ? [r.stats.buildingIndexPath] : [])],
    );
    if ('__voxelError' in out) return out;
    genVwg = exportVwg = out.vwgPath;
    lastBBox = { ...params.bbox };
    detailVwg = rectified = null;
    genIndex = out.stats.buildingIndexPath ?? null;
    knownVwg.clear();
    knownIndex.clear();
    knownVwg.add(resolve(out.vwgPath));
    if (genIndex) knownIndex.add(resolve(genIndex));
    rekeep();
    return { vwgPath: out.vwgPath, stats: out.stats };
  });

  ipcMain.handle(CH.analyzeFacade, async (_e, params: AnalyzeFacadeParams) => {
    if (currentJob) throw new Error('BAD_REQUEST: another job is already running');
    validateAnalyzeFacade(params);
    const path = resolve(params.photoPath);
    const scale = knownPhotos.get(path);
    if (!scale) throw new Error('BAD_REQUEST: photo was not chosen via pickPhoto');
    let st;
    try {
      st = await stat(path);
    } catch {
      throw new Error('PHOTO_UNREADABLE: photo no longer exists');
    }
    if (!st.isFile() || st.size > MAX_PHOTO_BYTES) throw new Error('BAD_REQUEST: photo is not a file or exceeds 40 MB');
    // Renderer works in preview pixels; python expects original-photo pixels.
    const corners = params.corners.map(([x, y]) => [x * scale.sx, y * scale.sy]) as AnalyzeFacadeParams['corners'];
    const fwd: AnalyzeFacadeParams = { ...params, photoPath: path, corners };
    const out = await runJob<AnalyzeFacadeResult>(
      'ana',
      'another job is already running',
      (id) => bridge.request<AnalyzeFacadeResult>({ id, type: 'analyzeFacade', params: fwd }),
      (r) => [r.rectifiedPath],
    );
    if ('__voxelError' in out) return out;
    validateFacadeSpec(out.spec);
    rectified = out.rectifiedPath;
    rekeep();
    return { spec: out.spec, rectifiedPath: out.rectifiedPath };
  });

  ipcMain.handle(CH.detail, async (_e, params: DetailParams) => {
    if (currentJob) throw new Error('BAD_REQUEST: another job is already running');
    validateDetail(params, lastBBox);
    const out = await runJob<DetailResult>(
      'det',
      'another job is already running',
      (id) => bridge.request<DetailResult>({ id, type: 'detail', params }),
      (r) => [r.vwgPath],
    );
    if ('__voxelError' in out) return out;
    validateDetailStats(out.stats);
    if (detailVwg) knownVwg.delete(resolve(detailVwg));
    detailVwg = out.vwgPath;
    knownVwg.add(resolve(out.vwgPath));
    rekeep();
    return { vwgPath: out.vwgPath, stats: out.stats };
  });

  ipcMain.handle(CH.pickPhoto, async () => {
    const win = getWindow();
    const opts = {
      title: 'Choose a photo of the wall',
      properties: ['openFile' as const],
      filters: [{ name: 'Images', extensions: PHOTO_EXTS }],
    };
    const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (canceled || !filePaths[0]) return null;
    const photoPath = resolve(filePaths[0]);
    const ext = extname(photoPath).slice(1).toLowerCase();
    if (!PHOTO_EXTS.includes(ext)) throw new Error('BAD_REQUEST: unsupported image type');
    const st = await stat(photoPath);
    if (!st.isFile()) throw new Error('BAD_REQUEST: not a file');
    if (st.size > MAX_PHOTO_BYTES) throw new Error('BAD_REQUEST: photo exceeds 40 MB');
    const bytes = await readFile(photoPath);
    // Header-only checks BEFORE any decode (decompression bombs).
    const info = readImageInfo(bytes);
    if (!info || info.width < 1 || info.height < 1) throw new Error('PHOTO_UNREADABLE: unrecognised or corrupt image header');
    if (info.width * info.height > MAX_PIXELS) throw new Error('PHOTO_UNREADABLE: image exceeds 100 megapixels');
    // Frame rule: the preview is always in the EXIF-ORIENTED frame (what the user sees, and what python's
    // exif_transpose yields; python swaps ow/oh for orientations 5-8). Corners are scaled from that frame.
    const oriented = orientedSize(info.width, info.height, info.orientation);
    let scale = { sx: 1, sy: 1 };
    let previewUrl: string;
    const side = Math.max(oriented.width, oriented.height);
    const small = side <= PREVIEW_MAX_SIDE && bytes.length <= PREVIEW_RAW_MAX_BYTES;
    if (small || ext === 'webp') {
      if (ext === 'webp' && bytes.length > 12 * 1024 * 1024) throw new Error('PHOTO_UNREADABLE: webp too large for preview');
      // Pass-through: Chromium's <img> honours EXIF orientation, so naturalWidth/Height == oriented size.
      previewUrl = `data:${MIME[ext]};base64,${bytes.toString('base64')}`;
    } else {
      const img = nativeImage.createFromBuffer(bytes); // does NOT apply EXIF orientation
      if (img.isEmpty()) throw new Error('PHOTO_UNREADABLE: cannot decode this image');
      const k = Math.min(1, PREVIEW_MAX_SIDE / Math.max(info.width, info.height));
      const rs = k < 1 ? img.resize({ width: Math.max(1, Math.round(info.width * k)), height: Math.max(1, Math.round(info.height * k)), quality: 'good' }) : img;
      const sz = rs.getSize();
      const o = orientBitmap(rs.toBitmap(), sz.width, sz.height, info.orientation);
      const outImg = nativeImage.createFromBitmap(o.data, { width: o.width, height: o.height });
      scale = { sx: oriented.width / o.width, sy: oriented.height / o.height };
      previewUrl = `data:image/jpeg;base64,${outImg.toJPEG(85).toString('base64')}`;
    }
    knownPhotos.set(photoPath, scale);
    return { photoPath, previewUrl };
  });

  ipcMain.handle(CH.readBuildingIndex, async (_e, p: string) => {
    if (typeof p !== 'string' || !knownIndex.has(resolve(p))) throw new Error('BAD_REQUEST: unknown building index path');
    const st = await stat(p);
    if (st.size > 200 * 1024 * 1024) throw new Error('BAD_REQUEST: building index too large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(p, 'utf8'));
    } catch {
      throw new Error('BAD_REQUEST: building index is not valid JSON');
    }
    return validateBuildingIndex(parsed);
  });

  ipcMain.handle(CH.cancel, () => {
    if (!currentJob) return;
    abandoned.add(currentJob);
    bridge.cancel(currentJob);
    cancelJob?.();
  });

  ipcMain.handle(CH.exportAs, async (_e, format: ExportFormat, suggestedName: string, vwgPath?: string) => {
    const spec = FORMATS[format];
    if (!Object.hasOwn(FORMATS, format) || !spec) throw new Error('BAD_REQUEST: unknown format');
    let source: string | null = null;
    if (vwgPath !== undefined) {
      if (typeof vwgPath !== 'string' || !knownVwg.has(resolve(vwgPath))) throw new Error('BAD_REQUEST: unknown .vwg path');
      if (!(await isFile(vwgPath))) throw new Error('BAD_REQUEST: that .vwg no longer exists; regenerate');
      source = vwgPath;
    } else {
      for (const c of [exportVwg, genVwg]) {
        if (c && (await isFile(c))) {
          source = c;
          break;
        }
      }
      if (!source) throw new Error('BAD_REQUEST: nothing to export; generate first');
    }
    const base = String(suggestedName ?? 'voxelworld').replace(/[\\/:*?"<>|]/g, '_') || 'voxelworld';
    const win = getWindow();
    const opts = {
      title: `Export ${spec.name}`,
      defaultPath: join(app.getPath('documents'), `${base}.${spec.ext}`),
      filters: [{ name: spec.name, extensions: [spec.ext] }],
    };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;
    const outputPath = filePath.toLowerCase().endsWith(`.${spec.ext}`) ? filePath : `${filePath}.${spec.ext}`;
    try {
      const res = await bridge.request<ExportResult>({
        id: bridge.newId('exp'),
        type: 'export',
        format,
        inputPath: source,
        outputPath,
      });
      return { outputPath: res.outputPath };
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(CH.readVwg, async (_e, vwgPath: string) => {
    if (typeof vwgPath !== 'string' || !knownVwg.has(resolve(vwgPath))) {
      throw new Error('BAD_REQUEST: unknown .vwg path');
    }
    exportVwg = resolve(vwgPath); // the renderer is showing this scene; export defaults to it
    const buf = await readFile(vwgPath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  });

  // Warm up python so the first Generate is fast; failures surface on first request.
  bridge.ensureReady().catch((e: Error) => send(CH.log, `[bridge] ${e.message}`));
  return bridge;
}
