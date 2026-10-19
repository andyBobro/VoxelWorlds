/**
 * FROZEN CONTRACT — owned by teamlead. Changes go through teamlead only.
 *
 * Transport: Electron main spawns `python -m voxelworlds` (cwd = ./python) and talks to it
 * over stdio as JSON Lines (one JSON object per line, UTF-8, "\n" terminated).
 *   - main -> python : stdin   (Request)
 *   - python -> main : stdout  (Event)   — stdout carries ONLY Event lines
 *   - python logs    : stderr  (free text, forwarded to the app log panel)
 * Bulk voxel data NEVER travels over stdio: python writes a `.vwg` file (see below)
 * to a temp path and returns that path in the `result` event.
 *
 * Renderer <-> main uses Electron IPC (contextBridge in preload) exposing `VoxelApi`.
 */

// ───────────────────────── Shared primitives ─────────────────────────

export interface BBox {
  latMin: number;
  lonMin: number;
  latMax: number;
  lonMax: number;
}

export type ExportFormat = 'vox' | 'schem' | 'json';

export interface GenerateParams {
  bbox: BBox;
  /** metres per voxel edge, 0.05 – 5.0 */
  voxelSize: number;
  /**
   * Edge length in metres of the square processing tiles the bbox is split into
   * (aligned to a global voxel grid so tiles merge seamlessly). Default 500, range 50 – 5000.
   * A bbox smaller than one tile is processed as a single tile.
   */
  tileSize?: number;
  /** worker processes for parallel tile processing; 0/undefined = auto (CPU count - 1, min 1, max 8) */
  workers?: number;
  features: {
    roads: boolean;
    elevation: boolean;
    /** procedural facade colours when no Mapillary imagery is available */
    proceduralFacades: boolean;
  };
  /** Mapillary v4 client token; empty/undefined => skip Mapillary entirely */
  mapillaryToken?: string;
  /** default metres per floor when only `building:levels` exists (default 3.5) */
  metersPerFloor: number;
  /** default building height in metres when no height/levels tag (default 10.5) */
  defaultBuildingHeight: number;
  /** hard safety cap on emitted voxels; python must fail fast with code VOXEL_LIMIT */
  maxVoxels: number;
  /** where OSM data comes from; default { kind: 'overpass' } (current behaviour) */
  dataSource?: DataSource;
}

/**
 * OSM data source. 'pbf' reads a locally stored Geofabrik extract (no network once downloaded).
 * The renderer supplies `regionId`; MAIN resolves it to `pbfPath` (a file under the geodata dir it manages,
 * verified to exist) before the request reaches python. python rejects kind 'pbf' without pbfPath (BAD_REQUEST)
 * and never reads other paths. Cached results are keyed by bbox AND source (pbf: regionId + file mtime/size).
 */
export type DataSource =
  | { kind: 'overpass' }
  | { kind: 'pbf'; regionId: string; pbfPath?: string };

// ───────────────────── main -> python (stdin) ─────────────────────

export type Request =
  | { id: string; type: 'generate'; params: GenerateParams }
  | { id: string; type: 'export'; format: ExportFormat; inputPath: string; outputPath: string }
  | { id: string; type: 'analyzeFacade'; params: AnalyzeFacadeParams }
  | { id: string; type: 'detail'; params: DetailParams }
  | { id: string; type: 'cancel'; target: string }
  | { id: string; type: 'ping' };

// ───────────────────── python -> main (stdout) ─────────────────────

export type Stage =
  | 'init' | 'osm' | 'dem' | 'mapillary' | 'project' | 'voxelize' | 'texture' | 'serialize' | 'export'
  | 'analyze' | 'facade' | 'interior' | 'pbf';

export type Event =
  | { id: string; type: 'ready'; version: string }                       // sent once at startup, id = "boot"
  | { id: string; type: 'pong' }
  | { id: string; type: 'progress'; stage: Stage; pct: number; message: string; tile?: { done: number; total: number } } // pct 0..100 within stage; `tile` present while tiled work runs
  | { id: string; type: 'result'; kind: 'generate'; vwgPath: string; stats: GenerateStats }
  | { id: string; type: 'result'; kind: 'export'; outputPath: string }
  | { id: string; type: 'result'; kind: 'analyzeFacade'; spec: FacadeSpec; rectifiedPath: string }
  | { id: string; type: 'result'; kind: 'detail'; vwgPath: string; stats: DetailStats }
  | { id: string; type: 'warning'; code: string; message: string }       // non-fatal, e.g. NO_MAPILLARY_COVERAGE
  | { id: string; type: 'error'; code: ErrorCode; message: string };

export type ErrorCode =
  | 'BAD_REQUEST' | 'OSM_FAILED' | 'NO_DATA' | 'VOXEL_LIMIT' | 'CANCELLED' | 'EXPORT_FAILED' | 'INTERNAL'
  | 'BUILDING_NOT_FOUND' | 'PHOTO_UNREADABLE' | 'FACADE_ANALYSIS_FAILED'
  | 'PBF_UNREADABLE' | 'PBF_NO_COVERAGE' | 'DOWNLOAD_FAILED' | 'WORLD_NOT_FOUND';

export interface GenerateStats {
  voxelCount: number;
  buildingCount: number;
  buildingsWithPhotos: number;
  buildingsProcedural: number;
  elapsedMs: number;
  tileCount?: number;
  /** sidecar JSON (BuildingIndex) next to the .vwg; absent on old results */
  buildingIndexPath?: string;
}

// ───────────── Building detail: photo facades + interiors (additive; VWG1 unchanged) ─────────────

/**
 * Sidecar `<name>.buildings.json` written with every generate. Lets the renderer pick a building
 * (ray hit voxel -> point-in-footprint on x,z, y within [baseY, topY)) without a per-voxel id array.
 * All coordinates are in the .vwg voxel grid (header.origin-relative, same axes as the voxels).
 */
export interface BuildingIndex {
  version: 1;
  buildings: BuildingInfo[];
}

export interface BuildingInfo {
  /** stable id: OSM element, e.g. "way/123456" or "relation/789" (also the per-building seed key) */
  id: string;
  kind: string;                       // facade.building_kind(): residential | commercial | ...
  name?: string;
  levels: number;
  heightM: number;
  /**
   * outer ring, voxel-grid [x, z], NOT closed (last != first). Edge i = ring[i] -> ring[(i+1) % n].
   * WINDING IS NORMALISED: counter-clockwise seen from above (x east to the right, north = -z up).
   * Consequence: the outside is to the right of travel along each edge, and a viewer standing outside
   * facing the wall sees ring[i] on the LEFT and ring[i+1] on the RIGHT, i.e. FacadeSpec.u grows
   * from ring[i] towards ring[i+1]. A facade always spans the FULL edge.
   */
  footprint: Array<[number, number]>;
  baseY: number;                      // voxel y of the lowest wall voxel
  topY: number;                       // exclusive
}

/** Everything python needs to find the same building again (OSM is cache-hit by exact bbox). */
export interface BuildingRef {
  bbox: BBox;                         // the bbox used for the original generate
  buildingId: string;
  /** the values the original generate used; python falls back to its saved copy, then 3.5 / 10.5 */
  metersPerFloor?: number;
  defaultBuildingHeight?: number;
  /**
   * Set by MAIN (never the renderer) for the walking demo: the city world's voxel size (metres) and the city index's
   * `BuildingInfo.baseY` of this building. Python uses them to express WalkEntrance.city in the city frame.
   */
  cityVoxelSize?: number;
  cityBaseY?: number;
  /** same source as the original generate so detail sees identical OSM data (main fills pbfPath) */
  dataSource?: DataSource;
}

/** Photo coordinates are image pixels, origin top-left, +x right, +y down. */
export type PhotoQuad = [[number, number], [number, number], [number, number], [number, number]]; // TL, TR, BR, BL of the wall

export interface AnalyzeFacadeParams {
  photoPath: string;                  // local file chosen by the user (jpg/png/webp)
  corners: PhotoQuad;                 // the wall's 4 corners in the photo, user-marked
  wallWidthM: number;                 // real wall size; defaults come from the footprint edge + building height
  wallHeightM: number;
  floorsHint?: number;
}

/** Wall-local, metric: u = metres from the wall's LEFT edge (seen from outside), v = metres up from the wall base. */
export interface FacadeRect { u: number; v: number; w: number; h: number; }

export interface FacadeSpec {
  version: 1;
  wallWidthM: number;
  wallHeightM: number;
  floors: number;
  floorLinesV: number[];              // metres up, strictly increasing, excludes 0
  wallColour: [number, number, number];
  trimColour: [number, number, number];     // sills, cornice, frames
  glassColour: [number, number, number];
  material: 'plaster' | 'brick' | 'stone' | 'concrete' | 'glass' | 'wood' | 'metal';
  windows: FacadeRect[];
  doors: FacadeRect[];
  /** 0..1 per field; the UI shows low-confidence items highlighted for manual correction */
  confidence: { floors: number; windows: number; doors: number; colour: number };
}

export interface InteriorOptions {
  enabled: boolean;
  wallThicknessM?: number;            // default 0.2 (external), partitions are 0.1
  roomMinM?: number;                  // default 2.5
  levelsOverride?: number;
  seed?: number;
}

export interface DetailParams {
  ref: BuildingRef;
  /** world the result is saved into (and whose bbox/dataSource the ref must match); main rejects unknown ids */
  worldId?: string;
  /** metres per voxel for the detail scene, 0.05 – 0.5 (default 0.15) */
  voxelSize: number;
  /** repaint one wall from a photo-derived spec; edge indexes BuildingInfo.footprint */
  facade?: { edge: number; spec: FacadeSpec };
  interior?: InteriorOptions;
  /** keep neighbours' shells in the detail scene for context (default false) */
  includeNeighbours?: boolean;
  maxVoxels: number;                  // fail with VOXEL_LIMIT
}

export interface DetailStats {
  voxelCount: number;
  levels: number;
  rooms: number;
  windows: number;
  doors: number;
  elapsedMs: number;
  /** y voxel index of the top of each storey's floor slab, bottom -> top; exactly `levels` entries, the roof is NOT included (cutaway slider) */
  floorYs: number[];
  /**
   * Walking demo: every usable entrance of the building (>= 1 when `doors` > 0 and an interior exists), one per
   * door that leads from outside into a walkable ground-floor space. ABSENT on details saved before the walking
   * demo existed: such a detail is not enterable until it is regenerated. See WalkEntrance.
   */
  entrances?: WalkEntrance[];
}

/**
 * One door connecting the outdoors to the interior. Frames:
 *  - city scene: VOXEL INDICES of the city .vwg (world metres = index * city voxelSize), +x east, +z south, Y up
 *  - detail scene: METRES in the detail .vwg's own world frame (world metres = voxel index * detail voxelSize,
 *    the same convention the preview uses for any .vwg); the detail scene is flat, ground at the footprint base
 * "feet" = the lowest point of the character (standing on the floor).
 */
export interface WalkEntrance {
  /** BuildingInfo.footprint edge the door is in (edge i = ring[i] -> ring[i+1]) */
  edge: number;
  /** city scene: ground cell [x, y, z] directly outside the door (y = voxel index of the first free cell above ground). Walking into the trigger zone around it enters the building. */
  city: [number, number, number];
  // NOTE: city[1] is the building's baseY (python has no terrain): the walking client re-snaps y to the real ground of that column.
  /** city scene: unit vector [x, z] pointing from the building towards the outside (door normal, outward) */
  cityDir: [number, number];
  /** detail scene: feet position [x, y, z] in metres just INSIDE the door (spawn when entering); never inside a wall, with >= 2 m headroom and a walkable floor */
  inside: [number, number, number];
  /** detail scene: feet position [x, y, z] in metres just OUTSIDE the door (leaving trigger = walking out through the door plane) */
  outside: [number, number, number];
  /** detail scene: unit vector [x, z] pointing from outside to inside (looking direction when entering) */
  dir: [number, number];
  /** door opening width in metres (>= 0.9) */
  widthM: number;
}

// ───────────────────── Renderer API (preload) ─────────────────────

export interface VoxelApi {
  /**
   * The result is auto-saved as a world. On success `world` is that saved world (now the current one) and
   * vwgPath/stats.buildingIndexPath point into the library; if saving failed, `world` is absent, `saveError`
   * says why, vwgPath is a temp file and NO world is current.
   */
  generate(params: GenerateParams): Promise<{ vwgPath: string; stats: GenerateStats; world?: WorldMeta; saveError?: string }>;
  cancel(): Promise<void>;
  readBuildingIndex(buildingIndexPath: string): Promise<BuildingIndex>;
  /** opens a native file picker; returns a local path (+ a data: or file: URL the renderer can display) */
  pickPhoto(): Promise<{ photoPath: string; previewUrl: string } | null>;
  analyzeFacade(params: AnalyzeFacadeParams): Promise<{ spec: FacadeSpec; rectifiedPath: string }>;
  /** result is auto-saved into the current world (see worlds API); `record` is its saved entry */
  detail(params: DetailParams): Promise<{ vwgPath: string; stats: DetailStats; record?: DetailRecord }>;

  // ── Worlds library: every generate is auto-saved; details (incl. interiors) are saved into their world ──
  listWorlds(): Promise<WorldMeta[]>;
  /** loads a saved world as the current one (readVwg/readBuildingIndex/detail/export trust it) */
  openWorld(worldId: string): Promise<{ vwgPath: string; stats: GenerateStats; buildingIndexPath?: string; meta: WorldMeta }>;
  renameWorld(worldId: string, name: string): Promise<WorldMeta>;
  deleteWorld(worldId: string): Promise<void>;
  /** details of the given world, newest first (all detail calls are explicit about the world; main keeps no hidden 'current' for them) */
  listDetails(worldId: string): Promise<DetailRecord[]>;
  /** opens a saved detail instantly (no python); the returned vwgPath works with readVwg/exportAs */
  openDetail(worldId: string, detailId: string): Promise<{ vwgPath: string; stats: DetailStats; record: DetailRecord }>;
  deleteDetail(worldId: string, detailId: string): Promise<void>;

  // ── Walking demo: a separate modal window; the main window is locked while it is open ──
  /**
   * Opens the walking window (modal child of the main window) for a saved world. Main resolves every path itself
   * from the library (the renderer never supplies a path). `spawn` = city voxel [x, z] to start at (ground is looked up);
   * absent = the world centre. Rejects: WORLD_NOT_FOUND, BUSY (a generate/detail job is running or a walk is already open),
   * NO_DATA (world has no voxels). Resolves once the window is created, not when it closes.
   */
  startWalk(worldId: string, spawn?: { x: number; z: number }): Promise<void>;
  /** true while the walking window is open (main window UI uses it to disable map editing, generate, tabs, worlds actions); fires immediately with the current value on subscribe */
  onWalkState(cb: (active: boolean) => void): () => void;
  /** WALK WINDOW ONLY (main rejects other callers with BAD_REQUEST): what to walk */
  walkSession(): Promise<WalkSession>;
  /** WALK WINDOW ONLY: close the walking window and return the app to normal */
  endWalk(): Promise<void>;
  /** fires after a generate or detail has been saved */
  onWorldSaved(cb: (e: { world: WorldMeta; detail?: DetailRecord }) => void): () => void;

  // ── Geodata: Geofabrik .osm.pbf extracts, downloaded once and reused offline ──
  /** Geofabrik region catalogue (index-v1.json, cached locally; works offline from cache) */
  listGeodataRegions(opts?: { refresh?: boolean }): Promise<GeodataRegion[]>;
  /** regions whose polygon covers the bbox, smallest first */
  suggestGeodataRegions(bbox: BBox): Promise<GeodataRegion[]>;
  listGeodata(): Promise<GeodataEntry[]>;
  downloadGeodata(regionId: string): Promise<GeodataEntry>;     // resumable; rejects DOWNLOAD_FAILED / CANCELLED
  cancelGeodataDownload(regionId?: string): Promise<void>;
  deleteGeodata(regionId: string): Promise<void>;
  onGeodataProgress(cb: (e: GeodataProgress) => void): () => void;
  /** vwgPath optional: export that known .vwg (e.g. a detail scene) instead of the last generate's */
  exportAs(format: ExportFormat, suggestedName: string, vwgPath?: string): Promise<{ outputPath: string } | null>; // null = user cancelled dialog
  readVwg(vwgPath: string): Promise<ArrayBuffer>;  // raw .vwg bytes; renderer parses with parseVwg()
  onProgress(cb: (e: { stage: Stage; pct: number; message: string; tile?: { done: number; total: number } }) => void): () => void; // returns unsubscribe
  onWarning(cb: (e: { code: string; message: string }) => void): () => void;
  onLog(cb: (line: string) => void): () => void;   // python stderr
}

// ───────────────────── Worlds library (persistence) ─────────────────────

/** Stored under the app's userData dir: worlds/<id>/{meta.json, world.vwg, world.buildings.json, details/<detailId>.{vwg,json}} */
export interface WorldMeta {
  formatVersion?: 1;                 // written by main; absent = legacy, normalised on load
  id: string;                         // uuid-ish, directory name
  name: string;                       // user-editable, default "<bbox centre> <date>"
  createdAt: string;                  // ISO
  updatedAt: string;
  bbox: BBox;
  voxelSize: number;
  /** generate params used (mapillaryToken is NEVER stored) */
  params: Omit<GenerateParams, 'mapillaryToken'>;
  stats: GenerateStats;
  sizeBytes: number;                  // world + all its details on disk
  hasBuildingIndex: boolean;
  /** for local-extract worlds: the extract's identity when the world was generated (staleness warning) */
  sourceInfo?: { sizeBytes: number; sourceDate?: string };
  details: DetailRecord[];            // newest first
}

/** Everything the walking window needs; paths are already trusted/resolved by main. */
export interface WalkSession {
  world: WorldMeta;                   // includes details (DetailRecord[]) at open time
  vwgPath: string;
  buildingIndexPath: string;          // '' when the world has none (nothing enterable)
  spawn?: { x: number; z: number };
}

export interface DetailRecord {
  id: string;
  worldId: string;
  buildingId: string;                 // BuildingInfo.id (renderer marks these buildings in the city view)
  buildingName?: string;
  createdAt: string;
  voxelSize: number;
  interior: boolean;
  facade?: { edge: number };          // present when a photo facade was painted
  stats: DetailStats;
  sizeBytes: number;
}

// ───────────────────── Geodata (Geofabrik extracts) ─────────────────────

export interface GeodataRegion {
  id: string;                         // Geofabrik id, e.g. "switzerland", "germany/berlin"
  name: string;
  parent?: string;                    // parent region id
  pbfUrl: string;                     // https://download.geofabrik.de/.../xxx-latest.osm.pbf
  sizeBytes?: number;                 // from HEAD/Content-Length when known
  downloaded?: boolean;               // filled by main
  /** only set by suggestGeodataRegions: true = fully covers the bbox, false = merely overlaps it */
  covers?: boolean;
}

export interface GeodataEntry {
  regionId: string;
  name: string;
  pbfPath: string;                    // under <userData>/geodata
  sizeBytes: number;
  downloadedAt: string;               // ISO
  /** Last-Modified of the remote file at download time (data freshness), when known */
  sourceDate?: string;
  verified: boolean;                  // md5 matched Geofabrik's .md5 (false if no .md5 available)
}

export interface GeodataProgress {
  regionId: string;
  phase: 'download' | 'verify' | 'done' | 'error';
  receivedBytes: number;
  totalBytes?: number;
  bytesPerSec?: number;
  message?: string;
}

// ───────────────────── .vwg voxel file format ─────────────────────
/**
 * VWG1 — sparse voxel container (little-endian throughout).
 *
 *   offset 0   : 4 bytes  ASCII magic "VWG1"
 *   offset 4   : uint32   headerLen (bytes of UTF-8 JSON, EXCLUDING padding)
 *   offset 8   : header JSON (VwgHeader), then zero-padded so payload starts 4-byte aligned
 *   payload    : structure-of-arrays, each array 4-byte aligned, in this order:
 *                  Int32Array  x[voxelCount]
 *                  Int32Array  y[voxelCount]
 *                  Int32Array  z[voxelCount]
 *                  Uint16Array c[voxelCount]   (palette index; padded to 4 bytes)
 *
 * Coordinates: integer voxel indices, relative to header.origin, *Y-UP*:
 *   +x = east, +y = up, -z = north (i.e. +z = south). Right-handed, Three.js-native.
 * Voxel (x,y,z) occupies world box [x,x+1)*voxelSize etc. relative to origin.
 * Only non-air voxels are stored. Order: sorted by (x, z, y) so columns are contiguous.
 * Palette index 0 is reserved/unused (never emitted).
 */
export interface VwgHeader {
  version: 1;
  voxelSize: number;                       // metres
  voxelCount: number;
  /** georeference of voxel (0,0,0)'s min corner */
  origin: {
    utmZone: number;                       // e.g. 36
    hemisphere: 'N' | 'S';
    easting: number;                       // metres
    northing: number;                      // metres
    elevation: number;                     // metres (ground datum at y=0)
    epsg: number;                          // e.g. 32636
  };
  bbox: BBox;
  /** inclusive-exclusive extents in voxels: x∈[min,max) etc. */
  extent: { min: [number, number, number]; max: [number, number, number] };
  /** palette[i] = [r,g,b] 0..255; index 0 is a placeholder [0,0,0] */
  palette: Array<[number, number, number]>;
  /** optional semantic tag per palette entry, same length as palette */
  materials?: Array<'ground' | 'road' | 'wall' | 'roof' | 'water' | 'vegetation' | 'other'>;
  stats: GenerateStats;
}

// The parser (parseVwg) lives in src/shared/vwg.ts, owned by threejs-voxel-renderer.
// The writer lives in python/voxelworlds/voxel/vwg.py, owned by python-gis-voxel.
