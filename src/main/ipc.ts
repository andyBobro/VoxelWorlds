import { app, dialog, ipcMain, nativeImage, BrowserWindow, type WebContents } from 'electron';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CH } from '../shared/channels';
import type {
  AnalyzeFacadeParams,
  BBox,
  DataSource,
  DetailParams,
  DetailRecord,
  DetailStats,
  ExportFormat,
  GenerateParams,
  GenerateStats,
  WorldMeta,
} from '../shared/contract';
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
  validateBBox,
  validateGenerate,
  type LastGenerate,
} from './validate';
import { GeodataManager } from './geodata';
import { isInside, isInsideReal } from './fsutil';
import { isValidId, WorldStore } from './worlds';
import { errText } from './errors';
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

type GenerateOutcome = { vwgPath: string; stats: GenerateStats; world?: WorldMeta; saveError?: string };

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
  const userData = app.getPath('userData');
  const worldsRoot = join(userData, 'worlds');
  const geodataRoot = join(userData, 'geodata');
  // Persistent python cache (OSM chunks, pbf indexes): survives OS temp purges so saved worlds keep working.
  const cacheDir = join(userData, 'voxel-cache'); // NOT 'cache': Chromium owns userData/Cache and macOS is case-insensitive
  mkdirSync(cacheDir, { recursive: true });
  // The temp cleanup deletes files by pattern; make sure it can never be pointed at the persistent library.
  const tempIsSafe = !isInside(userData, tempDir) && !isInside(tempDir, userData);
  const send = (channel: string, payload: unknown): void => {
    const wc: WebContents | undefined = getWindow()?.webContents;
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  };
  const logMain = (m: string): void => {
    console.log(m);
    send(CH.log, m);
  };
  const worlds = new WorldStore(worldsRoot, (m) => logMain(m));
  const geodata = new GeodataManager({
    dir: geodataRoot,
    version: app.getVersion(),
    log: (m) => logMain(m),
    onProgress: (e) => send(CH.geodataProgress, e),
  });
  void worlds.init().catch((e: Error) => logMain(`[worlds] scan failed: ${e.message}`));

  /** Wrap a handler so failures reach the renderer as clean 'CODE: message' errors (see preload `job`). */
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        return { __voxelError: errText(e) };
      }
    });
  };

  /** Temp artefacts (vwg, sidecar json, rectified png) that must survive the next cleanup. */
  const keep = new Set<string>();
  let currentJob: string | null = null;
  const cleanTemp = (): void => {
    // Never while a job runs or is being finalised: its python output is not in `keep` yet.
    if (!tempIsSafe || currentJob) return;
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
    currentJob = null;
    cleanTemp();
  });
  // Drain queued library writes (bounded) before the app really quits.
  let quitReady = false;
  app.on('before-quit', (ev) => {
    geodata.cancelAll();
    if (quitReady) return;
    ev.preventDefault();
    void Promise.race([worlds.idle().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]).finally(() => {
      quitReady = true;
      app.quit();
    });
  });

  /** Job ids the user cancelled; their late progress/result is ignored. */
  const abandoned = new Set<string>();

  const bridge = new PythonBridge({
    root: app.getAppPath(),
    packaged: app.isPackaged,
    tempDir,
    cacheDir,
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

  let cancelJob: (() => void) | null = null;
  /** .vwg that exportAs uses by default: last generate, or whichever known .vwg the renderer last read. */
  let exportVwg: string | null = null;
  let genVwg: string | null = null;
  let detailVwg: string | null = null;
  let genIndex: string | null = null;
  let rectified: string | null = null;
  const knownVwg = new Set<string>();
  const knownIndex = new Set<string>();
  /** bbox + data source of the last generate or opened world: the only thing `detail` may reference. */
  let lastGen: LastGenerate | null = null;
  /** library world that is current (details are saved into it) */
  let currentWorldId: string | null = null;
  /** photoPath -> multipliers from preview pixels to python's (EXIF-oriented original) pixels */
  const knownPhotos = new Map<string, { sx: number; sy: number }>();

  const rekeep = (): void => {
    keep.clear();
    for (const p of [genVwg, detailVwg, genIndex, rectified]) if (p) keep.add(resolve(p));
    cleanTemp(); // no-op while a job holds the slot; runJob cleans after releasing it
  };

  // Library files are trusted by location: <worlds>/<validId>/world.vwg | world.buildings.json | details/<validId>.vwg
  // for a world that is in the library. Only main ever writes there, so no per-session bookkeeping is needed
  // (and opening another world can never invalidate a path the renderer legitimately holds).
  const libraryKind = (p: string): 'world' | 'index' | 'detail' | null => {
    const rel = relative(worldsRoot, resolve(p));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    const parts = rel.split(sep);
    if (!isValidId(parts[0]) || !worlds.has(parts[0])) return null;
    if (parts.length === 2 && parts[1] === 'world.vwg') return 'world';
    if (parts.length === 2 && parts[1] === 'world.buildings.json') return 'index';
    if (parts.length === 3 && parts[1] === 'details' && parts[2].endsWith('.vwg') && isValidId(parts[2].slice(0, -4))) return 'detail';
    return null;
  };
  // Library trust also resolves symlinks: a link inside the library pointing elsewhere is not trusted.
  const trustedVwg = async (p: string): Promise<boolean> =>
    knownVwg.has(resolve(p)) || (['world', 'detail'].includes(libraryKind(p) ?? '') && (await isInsideReal(worldsRoot, p)));
  const trustedIndex = async (p: string): Promise<boolean> =>
    knownIndex.has(resolve(p)) || (libraryKind(p) === 'index' && (await isInsideReal(worldsRoot, p)));

  /**
   * One long job at a time (generate, analyzeFacade, detail share the slot). Settles immediately on cancel;
   * a late result of an abandoned job is discarded via `discard`. `finalize` (persisting results, switching the
   * current scene) runs while the slot is STILL held, so no other job/open/delete can interleave with it.
   */
  async function runJob<R extends { kind: string }, T = R>(
    prefix: string,
    busyMsg: string,
    send_: (id: string) => Promise<R>,
    discard: (r: R) => string[],
    finalize?: (r: R) => Promise<T>,
  ): Promise<T | R | { __voxelError: string }> {
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
      let result: R;
      try {
        result = await Promise.race([req, cancelled]);
      } catch (e) {
        // The result arrived in the same tick as the cancel: treat it as success, do not discard its files.
        if (got !== undefined) result = got;
        else if (e instanceof BridgeError && e.code === 'BAD_REQUEST' && /already running/i.test(e.message)) {
          return {
            __voxelError:
              'BUSY: the previous (cancelled) job is still stopping in the backend, usually while a network request finishes. Wait a few seconds and try again.',
          };
        }
        // Expected rejection: hand it to the preload as data so Electron does not log a handler error.
        else if (e instanceof Error && e.message.startsWith('CANCELLED:')) return { __voxelError: e.message };
        else if (e instanceof BridgeError && e.code === 'CANCELLED') return { __voxelError: `${e.code}: ${e.message}` };
        else return fail(e);
      }
      return finalize ? await finalize(result) : result;
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
      cleanTemp(); // slot released: now it is safe to drop temp files that are no longer referenced
    }
  }

  const libWorld = (worldId: unknown): string => {
    if (!isValidId(worldId)) throw new Error('BAD_REQUEST: invalid world id');
    if (!worlds.has(worldId)) throw new Error('WORLD_NOT_FOUND: world not found');
    return worldId;
  };
  const busyGuard = (): void => {
    if (currentJob) throw new Error('BUSY: a generation or detail job is running; wait for it to finish or cancel it');
  };

  /** Make `vwg` (+ optional index) the scene that readVwg/readBuildingIndex/exportAs/detail work on. */
  const setCurrentScene = (vwg: string, index: string | null, gen: LastGenerate, worldId: string | null): void => {
    genVwg = exportVwg = vwg;
    genIndex = index;
    lastGen = gen;
    currentWorldId = worldId;
    detailVwg = rectified = null;
    knownVwg.clear();
    knownIndex.clear();
    if (!libraryKind(vwg)) knownVwg.add(resolve(vwg)); // temp fallback scene
    if (index && !libraryKind(index)) knownIndex.add(resolve(index));
    rekeep();
  };

  const normSource = (ds: DataSource | undefined): DataSource =>
    ds && ds.kind === 'pbf' ? { kind: 'pbf', regionId: ds.regionId } : { kind: 'overpass' };

  const warn = (code: string, message: string): void => send(CH.warning, { code, message });

  handle(CH.generate, async (params: GenerateParams) => {
    if (currentJob) throw new Error('BAD_REQUEST: a generation is already running');
    validateGenerate(params);
    // main (never the renderer) decides which file python reads
    const dataSource = await geodata.resolveDataSource(params.dataSource);
    const fwd: GenerateParams = { ...params, dataSource };
    const gen: LastGenerate = { bbox: { ...params.bbox }, dataSource: normSource(params.dataSource) };
    return runJob<GenerateResult, GenerateOutcome>(
      'gen',
      'a generation is already running',
      (id) => bridge.request<GenerateResult>({ id, type: 'generate', params: fwd }),
      (r) => [r.vwgPath, ...(r.stats.buildingIndexPath ? [r.stats.buildingIndexPath] : [])],
      async (out) => {
        // Auto-save into the library; the saved copies are what the renderer is given from now on.
        try {
          const sourceLabel = dataSource.kind === 'pbf' ? ((await geodata.entryFor(dataSource.regionId))?.name ?? dataSource.regionId) : 'Overpass';
          const srcEntry = dataSource.kind === 'pbf' ? await geodata.entryFor(dataSource.regionId) : null;
          const sourceInfo = srcEntry ? { sizeBytes: srcEntry.sizeBytes, ...(srcEntry.sourceDate ? { sourceDate: srcEntry.sourceDate } : {}) } : undefined;
          const saved = await worlds.saveWorld({ params, stats: out.stats, vwgPath: out.vwgPath, buildingIndexPath: out.stats.buildingIndexPath, sourceLabel, sourceInfo });
          const stats: GenerateStats = { ...out.stats };
          if (saved.buildingIndexPath) stats.buildingIndexPath = saved.buildingIndexPath;
          else delete stats.buildingIndexPath;
          setCurrentScene(saved.vwgPath, saved.buildingIndexPath ?? null, gen, saved.meta.id);
          send(CH.worldSaved, { world: saved.meta });
          return { vwgPath: saved.vwgPath, stats, world: saved.meta };
        } catch (e) {
          const saveError = errText(e).replace(/^[A-Z_]+: /, '');
          logMain(`[worlds] auto-save failed, continuing with the temporary result: ${saveError}`);
          // No world is current: later details cannot be saved (the renderer clears its current world).
          setCurrentScene(out.vwgPath, out.stats.buildingIndexPath ?? null, gen, null);
          return { vwgPath: out.vwgPath, stats: out.stats, saveError };
        }
      },
    );
  });

  handle(CH.analyzeFacade, async (params: AnalyzeFacadeParams) => {
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
    return runJob<AnalyzeFacadeResult, { spec: AnalyzeFacadeResult['spec']; rectifiedPath: string }>(
      'ana',
      'another job is already running',
      (id) => bridge.request<AnalyzeFacadeResult>({ id, type: 'analyzeFacade', params: fwd }),
      (r) => [r.rectifiedPath],
      async (out) => {
        validateFacadeSpec(out.spec);
        rectified = out.rectifiedPath;
        rekeep();
        return { spec: out.spec, rectifiedPath: out.rectifiedPath };
      },
    );
  });

  handle(CH.detail, async (params: DetailParams) => {
    if (currentJob) throw new Error('BAD_REQUEST: another job is already running');
    // Target world: explicit params.worldId (validated against the library) or the current one.
    const explicit = (params as { worldId?: unknown } | undefined)?.worldId;
    let worldId = currentWorldId;
    let against: LastGenerate | null = lastGen;
    if (explicit !== undefined) {
      worldId = libWorld(explicit);
      const meta = await worlds.get(worldId);
      against = { bbox: { ...meta.bbox }, dataSource: normSource(meta.params.dataSource) };
    }
    validateDetail(params, against); // bbox AND dataSource.kind/regionId must equal that world's / the current scene's
    const ref = { ...params.ref, dataSource: await geodata.resolveDataSource(against?.dataSource) };
    // pbf worlds: warn (but still run) when the local extract was replaced after the world was generated
    if (against?.dataSource?.kind === 'pbf' && worldId && worlds.has(worldId)) {
      const info = (await worlds.get(worldId)).sourceInfo;
      const now = await geodata.entryFor(against.dataSource.regionId);
      if (info && now && (now.sizeBytes !== info.sizeBytes || (info.sourceDate ?? now.sourceDate) !== (now.sourceDate ?? info.sourceDate))) {
        warn('SOURCE_CHANGED', 'The local extract was updated after this world was generated; buildings may differ.');
      }
    }
    // worldId is main-side routing only; python never sees it
    const { worldId: _w, ...pyParams } = params as DetailParams & { worldId?: string };
    void _w;
    const fwd: DetailParams = { ...pyParams, ref };
    return runJob<DetailResult, { vwgPath: string; stats: DetailStats; record?: DetailRecord }>(
      'det',
      'another job is already running',
      (id) => bridge.request<DetailResult>({ id, type: 'detail', params: fwd }),
      (r) => [r.vwgPath],
      async (out) => {
        validateDetailStats(out.stats);
        let why = 'no saved world is open (it was deleted or could not be saved), so this detail is not saved';
        if (worldId && worlds.has(worldId)) {
          try {
            const buildingName = await worlds.buildingName(worldId, params.ref.buildingId);
            const saved = await worlds.saveDetail({ worldId, params, stats: out.stats, vwgPath: out.vwgPath, buildingName });
            if (detailVwg) knownVwg.delete(resolve(detailVwg));
            detailVwg = null;
            rekeep();
            send(CH.worldSaved, { world: saved.world, detail: saved.record });
            return { vwgPath: saved.vwgPath, stats: out.stats, record: saved.record };
          } catch (e) {
            why = `saving the detail failed (${errText(e).replace(/^[A-Z_]+: /, '')}), so it is not saved`;
            logMain(`[worlds] detail auto-save failed, continuing with the temporary result: ${why}`);
          }
        }
        // Unsaved fallback: the temp result stays viewable/exportable; the renderer is told it has no `record`.
        warn('DETAIL_NOT_SAVED', why);
        if (detailVwg) knownVwg.delete(resolve(detailVwg));
        detailVwg = out.vwgPath;
        knownVwg.add(resolve(out.vwgPath));
        rekeep();
        return { vwgPath: out.vwgPath, stats: out.stats };
      },
    );
  });

  handle(CH.pickPhoto, async () => {
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

  handle(CH.readBuildingIndex, async (p: string) => {
    if (typeof p !== 'string' || !(await trustedIndex(p))) throw new Error('BAD_REQUEST: unknown building index path');
    let st;
    try {
      st = await stat(p);
    } catch {
      throw new Error('WORLD_NOT_FOUND: building index file is missing');
    }
    if (st.size > 200 * 1024 * 1024) throw new Error('BAD_REQUEST: building index too large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(p, 'utf8'));
    } catch {
      throw new Error('BAD_REQUEST: building index is not valid JSON');
    }
    return validateBuildingIndex(parsed);
  });

  handle(CH.cancel, () => {
    if (!currentJob) return;
    abandoned.add(currentJob);
    bridge.cancel(currentJob);
    cancelJob?.();
  });

  handle(CH.exportAs, async (format: ExportFormat, suggestedName: string, vwgPath?: string) => {
    const spec = FORMATS[format];
    if (!Object.hasOwn(FORMATS, format) || !spec) throw new Error('BAD_REQUEST: unknown format');
    let source: string | null = null;
    if (vwgPath !== undefined) {
      if (typeof vwgPath !== 'string' || !(await trustedVwg(vwgPath))) throw new Error('BAD_REQUEST: unknown .vwg path');
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

  handle(CH.readVwg, async (vwgPath: string) => {
    if (typeof vwgPath !== 'string' || !(await trustedVwg(vwgPath))) {
      throw new Error('BAD_REQUEST: unknown .vwg path');
    }
    let buf;
    try {
      buf = await readFile(vwgPath);
    } catch {
      throw new Error('WORLD_NOT_FOUND: that scene file no longer exists');
    }
    exportVwg = resolve(vwgPath); // the renderer is showing this scene; export defaults to it
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  });

  // ── Worlds library ──
  handle(CH.listWorlds, () => worlds.list());
  handle(CH.openWorld, async (id: string) => {
    busyGuard();
    const w = await worlds.open(id);
    busyGuard(); // a job may have started while the library was being read
    const stats: GenerateStats = { ...w.meta.stats };
    if (w.buildingIndexPath) stats.buildingIndexPath = w.buildingIndexPath;
    else delete stats.buildingIndexPath;
    setCurrentScene(w.vwgPath, w.buildingIndexPath ?? null, { bbox: { ...w.meta.bbox }, dataSource: normSource(w.meta.params.dataSource) }, w.meta.id);
    const meta: WorldMeta = w.meta;
    return { vwgPath: w.vwgPath, stats, ...(w.buildingIndexPath ? { buildingIndexPath: w.buildingIndexPath } : {}), meta };
  });
  handle(CH.renameWorld, (id: string, name: string) => {
    busyGuard();
    return worlds.rename(id, name);
  });
  handle(CH.deleteWorld, async (id: string) => {
    busyGuard();
    await worlds.deleteWorld(id);
    // The scene on screen (already in renderer memory) stays usable, but nothing more is saved into the deleted world:
    // later detail results come back without `record` plus a DETAIL_NOT_SAVED warning event.
    if (currentWorldId === id) currentWorldId = null;
  });
  // Detail calls are explicit about the world; ids are validated and must exist in the library.
  handle(CH.listDetails, (worldId: string) => worlds.listDetails(libWorld(worldId)));
  handle(CH.openDetail, async (worldId: string, detailId: string) => {
    const { record, vwgPath } = await worlds.openDetail(libWorld(worldId), detailId);
    return { vwgPath, stats: record.stats, record }; // trusted by library location (see libraryKind)
  });
  handle(CH.deleteDetail, async (worldId: string, detailId: string) => {
    busyGuard();
    const world = await worlds.deleteDetail(libWorld(worldId), detailId);
    send(CH.worldSaved, { world });
  });

  // ── Geodata (Geofabrik extracts) ──
  handle(CH.listGeodataRegions, (opts?: { refresh?: boolean }) => geodata.listRegions({ refresh: !!opts?.refresh }));
  handle(CH.suggestGeodataRegions, (bbox: BBox) => {
    validateBBox(bbox);
    return geodata.suggest(bbox);
  });
  handle(CH.listGeodata, () => geodata.listEntries());
  handle(CH.downloadGeodata, (regionId: string) => geodata.download(regionId));
  handle(CH.cancelGeodataDownload, (regionId?: string) => {
    if (regionId !== undefined && typeof regionId !== 'string') throw new Error('BAD_REQUEST: invalid regionId');
    geodata.cancel(regionId);
  });
  handle(CH.deleteGeodata, (regionId: string) => geodata.delete(regionId));

  // Warm up python so the first Generate is fast; failures surface on first request.
  bridge.ensureReady().catch((e: Error) => send(CH.log, `[bridge] ${e.message}`));
  return bridge;
}
