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
}

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
  | 'analyze' | 'facade' | 'interior';

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
  | 'BUILDING_NOT_FOUND' | 'PHOTO_UNREADABLE' | 'FACADE_ANALYSIS_FAILED';

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
}

// ───────────────────── Renderer API (preload) ─────────────────────

export interface VoxelApi {
  generate(params: GenerateParams): Promise<{ vwgPath: string; stats: GenerateStats }>;
  cancel(): Promise<void>;
  readBuildingIndex(buildingIndexPath: string): Promise<BuildingIndex>;
  /** opens a native file picker; returns a local path (+ a data: or file: URL the renderer can display) */
  pickPhoto(): Promise<{ photoPath: string; previewUrl: string } | null>;
  analyzeFacade(params: AnalyzeFacadeParams): Promise<{ spec: FacadeSpec; rectifiedPath: string }>;
  detail(params: DetailParams): Promise<{ vwgPath: string; stats: DetailStats }>;
  /** vwgPath optional: export that known .vwg (e.g. a detail scene) instead of the last generate's */
  exportAs(format: ExportFormat, suggestedName: string, vwgPath?: string): Promise<{ outputPath: string } | null>; // null = user cancelled dialog
  readVwg(vwgPath: string): Promise<ArrayBuffer>;  // raw .vwg bytes; renderer parses with parseVwg()
  onProgress(cb: (e: { stage: Stage; pct: number; message: string; tile?: { done: number; total: number } }) => void): () => void; // returns unsubscribe
  onWarning(cb: (e: { code: string; message: string }) => void): () => void;
  onLog(cb: (line: string) => void): () => void;   // python stderr
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
