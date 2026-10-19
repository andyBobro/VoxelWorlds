/** Human text for walking-window failures. Pure. */

/** Strip Electron's "Error invoking remote method ..." wrapper. */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function errorCode(e: unknown): string {
  return /^([A-Z][A-Z_]{3,}):/.exec(errorText(e))?.[1] ?? '';
}

export interface Explained {
  /** short, human, one line */
  text: string;
  /** technical detail for the log / tooltip */
  tech: string;
}

/** What to tell the user when an interior could not be generated. `null` = the user cancelled (say nothing alarming). */
export function explainInteriorError(e: unknown, maxVoxels?: number): Explained | null {
  const raw = errorText(e);
  const code = errorCode(e);
  const body = raw.replace(/^[A-Z][A-Z_]{3,}:\s*/, '');
  const tech = raw.slice(0, 400);
  if (/region not downloaded/i.test(body)) return { tech, text: 'The map extract for this area is not downloaded.' };
  switch (code) {
    case 'CANCELLED': return null;
    case 'VOXEL_LIMIT':
      return { tech, text: `Too large for an interior at 0.15 m${maxVoxels ? ` (limit ${(maxVoxels / 1e6).toFixed(0)} M voxels)` : ''}. Generate it from the main window with bigger voxels.` };
    case 'BUILDING_NOT_FOUND': return { tech, text: 'This building is not in the map data any more.' };
    case 'OSM_FAILED': case 'PBF_UNREADABLE': case 'PBF_NO_COVERAGE': return { tech, text: 'The map data for this area is not available.' };
    case 'BUSY': return { tech, text: 'Another job is running. Try again in a moment.' };
    case 'NO_DATA': return { tech, text: 'There is no map data for this building.' };
    case 'BAD_REQUEST': return { tech, text: 'The request was rejected. Press E to retry.' };
    default:
      if (/region not downloaded/i.test(body)) return { tech, text: 'The map extract for this area is not downloaded.' };
      return { tech, text: 'The interior generator stopped unexpectedly. Press E to retry.' };
  }
}

const KIND_LABEL: Record<string, string> = {
  residential: 'House', commercial: 'Shop', industrial: 'Industrial building', religious: 'Place of worship',
  civic: 'Public building', minor: 'Small building', generic: 'Building',
};

/** Display name of a building: its name, else a label from its kind (never the raw OSM id). */
export function buildingLabel(b: { name?: string; kind: string }): string {
  return b.name?.trim() || KIND_LABEL[b.kind] || 'Building';
}

/** Storey index (0-based) of a feet height given the floor-slab top voxel indices, or -1 when no floors are known. */
export function storeyAt(floorYs: readonly number[] | undefined, vs: number, feetY: number): number {
  if (!floorYs || floorYs.length === 0) return -1;
  let s = 0;
  for (let i = 0; i < floorYs.length; i++) if (feetY >= (floorYs[i]! + 1) * vs - 0.35) s = i;
  return s;
}
