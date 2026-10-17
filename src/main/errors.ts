import { BridgeError } from './pythonBridge';

/** Error codes that may reach the renderer verbatim; everything else is wrapped as INTERNAL (no raw fs/OS messages). */
const KNOWN_CODES = new Set<string>([
  'BAD_REQUEST', 'OSM_FAILED', 'NO_DATA', 'VOXEL_LIMIT', 'CANCELLED', 'EXPORT_FAILED', 'INTERNAL',
  'BUILDING_NOT_FOUND', 'PHOTO_UNREADABLE', 'FACADE_ANALYSIS_FAILED',
  'PBF_UNREADABLE', 'PBF_NO_COVERAGE', 'DOWNLOAD_FAILED', 'WORLD_NOT_FOUND',
  'BUSY', 'SPAWN_FAILED', 'PROCESS_EXIT',
]);

/** 'CODE: message' with CODE from the known set, for anything thrown in a handler. */
export function errText(e: unknown): string {
  if (e instanceof BridgeError) return `${e.code}: ${e.message}`;
  const m = e instanceof Error ? e.message : String(e);
  const mm = /^([A-Z][A-Z_]+): /.exec(m);
  if (mm && KNOWN_CODES.has(mm[1])) return m;
  console.error('[ipc] unexpected error:', e);
  return `INTERNAL: ${m.replace(/\s+/g, ' ').slice(0, 300)}`;
}
