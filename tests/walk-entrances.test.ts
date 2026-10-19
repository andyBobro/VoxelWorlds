import { describe, expect, it } from 'vitest';
import type { BuildingInfo, DetailRecord, WalkEntrance } from '../src/shared/contract';
import {
  BuildingGrid, collectSavedEntrances, entranceInBounds, crossedDoor, findDoorCandidate, findEntrance, interiorEligibility,
  nearestEntrance, nearestOutwardEdge, triggerConfig, type SavedEntrance,
} from '../src/renderer/walk/entrances';
import { storeyAt, explainInteriorError, buildingLabel } from '../src/renderer/walk/messages';

// door on the south wall of a building at x 10..30, z 10..30 (voxel size 1): outside is +z
const ent: WalkEntrance = {
  edge: 0, city: [20, 5, 31], cityDir: [0, 1], inside: [3, 0, 2], outside: [3, 0, 4], dir: [0, -1], widthM: 1.2,
};
const saved: SavedEntrance[] = [{ buildingId: 'way/1', detailId: 'd1', entrance: ent }];
const cfg = triggerConfig(1);

describe('saved entrance trigger', () => {
  it('enters when walking into the zone towards the door', () => {
    const h = findEntrance(saved, 1, 20.5, 5, 32.5, 0, -3, cfg)!;
    expect(h.auto).toBe(true);
  });
  it('only prompts when standing still or moving away or passing sideways', () => {
    expect(findEntrance(saved, 1, 20.5, 5, 32.5, 0, 0, cfg)!.auto).toBe(false);
    expect(findEntrance(saved, 1, 20.5, 5, 32.5, 0, 3, cfg)!.auto).toBe(false);
    expect(findEntrance(saved, 1, 20.5, 5, 32.5, 3, 0, cfg)!.auto).toBe(false);
  });
  it('is silent beyond the prompt range or on another storey', () => {
    expect(findEntrance(saved, 1, 20.5, 5, 40, 0, -3, cfg)).toBeNull();
    expect(findEntrance(saved, 1, 20.5, 25, 32.5, 0, -3, cfg)).toBeNull();
  });
  it('prompts further away than it auto-enters', () => {
    const h = findEntrance(saved, 1, 20.5, 5, 35, 0, -3, cfg)!;
    expect(h).not.toBeNull();
    expect(h.auto).toBe(false);
  });
});

describe('leaving', () => {
  it('triggers when crossing the door plane outwards inside the opening only', () => {
    expect(crossedDoor(ent, 3, 0, 2.5)).toBe(false); // inside
    expect(crossedDoor(ent, 3, 0, 3.2)).toBe(true); // past the midpoint (z = 3), outside
    expect(crossedDoor(ent, 6, 0, 3.2)).toBe(false); // beside the opening
    expect(crossedDoor(ent, 3, 4, 3.2)).toBe(false); // other floor level
  });
  it('picks the entrance nearest to where the player stood', () => {
    const b: WalkEntrance = { ...ent, city: [60, 5, 31] };
    expect(nearestEntrance([b, ent], 22, 33)).toBe(ent);
    expect(nearestEntrance([], 0, 0)).toBeNull();
  });
});

const sq = (x0: number, z0: number, s: number): Array<[number, number]> => [[x0, z0 + s], [x0 + s, z0 + s], [x0 + s, z0], [x0, z0]]; // CCW from above
const bld = (id: string, over: Partial<BuildingInfo> = {}): BuildingInfo => ({
  id, kind: 'residential', levels: 2, heightM: 7, footprint: sq(10, 10, 20), baseY: 0, topY: 8, ...over,
});

describe('on-demand: footprint edges', () => {
  it('finds the outward side of each wall (CCW ring) and rejects the inside', () => {
    const ring = sq(10, 10, 20);
    expect(nearestOutwardEdge(ring, 20, 31, 1.5, 2)!.nz).toBeCloseTo(1); // south wall: outward +z
    expect(nearestOutwardEdge(ring, 9, 20, 1.5, 2)!.nx).toBeCloseTo(-1); // west wall
    expect(nearestOutwardEdge(ring, 20, 29, 1.5, 2)).toBeNull(); // inside the building
    expect(nearestOutwardEdge(ring, 20, 33, 1.5, 2)).toBeNull(); // too far
    expect(nearestOutwardEdge(ring, 40, 31, 1.5, 2)).toBeNull(); // beside the wall's extent
  });
  it('grid query only returns nearby buildings and the candidate is the closest wall', () => {
    const b1 = bld('a'), b2 = bld('b', { footprint: sq(500, 500, 20) });
    const grid = new BuildingGrid([b1, b2], 1);
    const c = findDoorCandidate(grid, () => true, 1, 20, 2, 31)!;
    expect(c.building.id).toBe('a');
    expect(findDoorCandidate(grid, () => true, 1, 300, 2, 300)).toBeNull();
    expect(findDoorCandidate(grid, () => false, 1, 20, 2, 31)).toBeNull();
    expect(findDoorCandidate(grid, () => true, 1, 20, 60, 31)).toBeNull(); // far above (other storey / flying)
  });
  it('eligibility: levels, kind, size', () => {
    expect(interiorEligibility(bld('x'), 1).ok).toBe(true);
    expect(interiorEligibility(bld('x', { levels: 0 }), 1).ok).toBe(false);
    expect(interiorEligibility(bld('x', { kind: 'minor' }), 1).ok).toBe(false);
    expect(interiorEligibility(bld('x', { footprint: sq(0, 0, 3) }), 1).ok).toBe(false);
    expect(interiorEligibility(bld('x', { footprint: sq(0, 0, 100) }), 1).ok).toBe(false);
    expect(interiorEligibility(bld('x', { footprint: sq(0, 0, 20) }), 0.1).ok).toBe(false); // 2 m x 2 m at 0.1 m voxels
  });
});

describe('saved details', () => {
  const rec = (id: string, b: string, interior: boolean, entrances?: WalkEntrance[]): DetailRecord => ({
    id, worldId: 'w', buildingId: b, createdAt: '', voxelSize: 0.15, interior, sizeBytes: 0,
    stats: { voxelCount: 1, levels: 1, rooms: 1, windows: 0, doors: 1, elapsedMs: 1, floorYs: [3], ...(entrances ? { entrances } : {}) },
  });
  it('uses the newest interior with entrances; flags old details without entrances', () => {
    const r = collectSavedEntrances([rec('n', 'b1', true, [ent]), rec('o', 'b1', true), rec('p', 'b2', true), rec('f', 'b3', false)]);
    expect(r.entrances.map((e) => e.detailId)).toEqual(['n']);
    expect([...r.noEntrance]).toEqual(['b2']);
  });
});

describe('messages', () => {
  it('names the storey from floor slab tops', () => {
    expect(storeyAt([4, 24], 0.15, 0.7)).toBe(0);
    expect(storeyAt([4, 24], 0.15, 3.7)).toBe(1);
    expect(storeyAt(undefined, 0.15, 3)).toBe(-1);
  });
  it('explains limits in short human text and treats cancel as silent', () => {
    expect(explainInteriorError(new Error('CANCELLED: x'))).toBeNull();
    const e = explainInteriorError(new Error("Error invoking remote method 'x': Error: VOXEL_LIMIT: too many"), 12e6)!;
    expect(e.text).toMatch(/Too large.*12 M/);
    expect(e.tech).toMatch(/VOXEL_LIMIT/);
    const crash = explainInteriorError(new Error('INTERNAL: python exited with code -9'))!;
    expect(crash.text).toBe('The interior generator stopped unexpectedly. Press E to retry.');
    expect(crash.text.length).toBeLessThan(80);
    expect(explainInteriorError(new Error('BAD_REQUEST: region not downloaded'))!.text).toBe('The map extract for this area is not downloaded.');
  });
  it('labels unnamed buildings by kind, never by OSM id', () => {
    expect(buildingLabel({ kind: 'residential' })).toBe('House');
    expect(buildingLabel({ kind: 'commercial' })).toBe('Shop');
    expect(buildingLabel({ kind: 'weird' })).toBe('Building');
    expect(buildingLabel({ kind: 'generic', name: ' Town Hall ' })).toBe('Town Hall');
  });
});

describe('entrances outside the map', () => {
  it('drops doors whose city cell is outside the x/z extent', () => {
    const min = [0, 0, 0], max = [100, 50, 616];
    const at = (x: number, z: number): WalkEntrance => ({ ...ent, city: [x, 5, z] });
    expect(entranceInBounds(at(10, 615), min, max)).toBe(true);
    expect(entranceInBounds(at(10, 618), min, max)).toBe(false);
    expect(entranceInBounds(at(-30, 10), min, max)).toBe(false);
  });
});
