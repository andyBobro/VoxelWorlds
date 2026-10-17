import { describe, expect, it } from 'vitest';
import type { BuildingInfo, DetailRecord, WorldMeta } from '../src/shared/contract';
import {
  bboxCentre, detailLibraryBytes, detailSizeNote, libraryTooBig, filterWorlds, fmtBytesTotal, markerLegend, sortWorldsBy, detailRows, detailSummary, fmtCentre, groupDetailsByBuilding, markedBuildings, removeDetail, upsertDetail, upsertWorld, worldRow,
} from '../src/renderer/lib/worlds';
import { stripCode } from '../src/renderer/ui/dom';
import { buildMarkerGeometry, buildingFocus, pinHeightM } from '../src/renderer/preview/markerGeometry';

const D = (id: string, buildingId: string, createdAt: string, o: Partial<DetailRecord> = {}): DetailRecord => ({
  id, worldId: 'w1', buildingId, createdAt, voxelSize: 0.15, interior: false, sizeBytes: 2_400_000,
  stats: { voxelCount: 1000, levels: 3, rooms: 0, windows: 0, doors: 0, elapsedMs: 1, floorYs: [] }, ...o,
});
const W = (id: string, updatedAt: string, details: DetailRecord[] = []): WorldMeta => ({
  id, name: `World ${id}`, createdAt: updatedAt, updatedAt, bbox: { latMin: 47, lonMin: 8, latMax: 48, lonMax: 9 }, voxelSize: 1,
  params: { bbox: { latMin: 47, lonMin: 8, latMax: 48, lonMax: 9 }, voxelSize: 1, features: { roads: true, elevation: true, proceduralFacades: true }, metersPerFloor: 3.5, defaultBuildingHeight: 10.5, maxVoxels: 1e7, dataSource: { kind: 'pbf', regionId: 'switzerland' } },
  stats: { voxelCount: 1234567, buildingCount: 42, buildingsWithPhotos: 0, buildingsProcedural: 42, elapsedMs: 1 }, sizeBytes: 9_000_000, hasBuildingIndex: true, details,
});
const B = (id: string, fp: Array<[number, number]>, baseY = 1, topY = 11): BuildingInfo => ({ id, kind: 'residential', levels: 3, heightM: 10, footprint: fp, baseY, topY });

describe('world/detail list reducers', () => {
  it('upsertWorld replaces by id and sorts newest first', () => {
    let l = upsertWorld([], W('a', '2026-01-01T00:00:00Z'));
    l = upsertWorld(l, W('b', '2026-02-01T00:00:00Z'));
    expect(l.map((w) => w.id)).toEqual(['b', 'a']);
    l = upsertWorld(l, { ...W('a', '2026-03-01T00:00:00Z'), name: 'renamed' });
    expect(l.map((w) => w.id)).toEqual(['a', 'b']);
    expect(l[0]!.name).toBe('renamed');
    expect(l.length).toBe(2);
  });
  it('upsertDetail dedupes the detail() result against the saved event', () => {
    const r = D('d1', 'way/1', '2026-01-02T00:00:00Z');
    let l = upsertDetail([], r);
    l = upsertDetail(l, { ...r });
    expect(l.length).toBe(1);
    l = upsertDetail(l, D('d2', 'way/2', '2026-01-03T00:00:00Z'));
    expect(l.map((x) => x.id)).toEqual(['d2', 'd1']);
    expect(removeDetail(l, 'd2').map((x) => x.id)).toEqual(['d1']);
  });
});

describe('grouping by building id', () => {
  const recs = [D('d1', 'way/1', '2026-01-01T00:00:00Z'), D('d2', 'way/2', '2026-01-02T00:00:00Z'), D('d3', 'way/1', '2026-01-03T00:00:00Z')];
  it('groups newest first', () => {
    const g = groupDetailsByBuilding(recs);
    expect(g.size).toBe(2);
    expect(g.get('way/1')!.map((r) => r.id)).toEqual(['d3', 'd1']);
    expect(g.get('way/2')!.length).toBe(1);
  });
  it('marks only buildings present in the index', () => {
    const idx = [B('way/1', [[0, 0], [1, 0], [1, 1]]), B('way/9', [[0, 0], [1, 0], [1, 1]]), B('way/2', [[0, 0], [1, 0], [1, 1]])];
    expect(markedBuildings(idx, recs).map((b) => b.id)).toEqual(['way/1', 'way/2']);
    expect(markedBuildings(idx, [D('x', 'way/404', '2026-01-01T00:00:00Z')])).toEqual([]);
    expect(markedBuildings([], recs)).toEqual([]);
  });
});

describe('row models', () => {
  it('detail rows', () => {
    const rows = detailRows([
      D('a', 'way/1', '2026-01-01T10:00:00Z', { interior: true, facade: { edge: 1 }, buildingName: ' Town hall ' }),
      D('b', 'way/2', '2026-02-01T10:00:00Z'),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(rows[0]).toMatchObject({ title: 'way/2', interior: 'no', facade: 'none', voxelSize: '0.15 m', size: '2.4 MB' });
    expect(rows[1]).toMatchObject({ title: 'Town hall', interior: 'yes', facade: 'wall 2' });
    expect(detailSummary(rows[1]!)).toBe('0.15 m, interior yes, facade wall 2, 2.4 MB');
  });
  it('world row', () => {
    const r = worldRow(W('a', '2026-01-01T00:00:00Z', [D('d', 'way/1', '2026-01-01T00:00:00Z')]));
    expect(r).toMatchObject({ voxels: '1,234,567', buildings: '42', details: 1, size: '9.0 MB', voxelSize: '1 m', source: 'Geofabrik: switzerland' });
    expect(r.centre).toBe('47.5000°N 8.5000°E');
    expect(worldRow({ ...W('b', '2026-01-01T00:00:00Z'), params: { ...W('b', '').params, dataSource: undefined } }).source).toBe('Overpass');
  });
  it('centre handles hemispheres', () => {
    expect(bboxCentre({ latMin: -2, lonMin: -4, latMax: 0, lonMax: -2 })).toEqual({ lat: -1, lon: -3 });
    expect(fmtCentre({ latMin: -2, lonMin: -4, latMax: 0, lonMax: -2 })).toBe('1.0000°S 3.0000°W');
  });
});

describe('marker geometry', () => {
  it('one outline loop + stem + pin per building, metres = voxels * size', () => {
    const g = buildMarkerGeometry([B('a', [[0, 0], [10, 0], [10, 10], [0, 10]], 1, 11), B('b', [[0, 0], [1, 1]]), B('c', [[20, 20], [30, 20], [25, 30]], 1, 6)], 2);
    expect(g.count).toBe(2); // 'b' has < 3 points and is skipped
    expect(g.lines.length).toBe((4 + 1 + 3 + 1) * 6);
    expect(g.pins.length).toBe(2 * 3);
    // pin of building a: centroid (5,5) voxel -> (10, ?, 10) m, above the roof (11 voxels = 22 m)
    expect(g.pins[0]).toBeCloseTo(10);
    expect(g.pins[2]).toBeCloseTo(10);
    expect(g.pins[1]).toBeGreaterThan(22);
    expect(Array.from(g.lines).every(Number.isFinite)).toBe(true);
  });
  it('empty input yields empty arrays', () => {
    const g = buildMarkerGeometry([], 1);
    expect(g.count).toBe(0);
    expect(g.lines.length).toBe(0);
  });
  it('pin height scales with building and stays bounded', () => {
    expect(pinHeightM(10, 1)).toBeGreaterThan(pinHeightM(2, 1));
    expect(pinHeightM(1000, 1)).toBe(30);
    expect(pinHeightM(0, 0.1)).toBeGreaterThan(0);
  });
  it('focus box', () => {
    const f = buildingFocus(B('a', [[0, 0], [10, 0], [10, 20], [0, 20]], 0, 10));
    expect(f).toMatchObject({ cx: 5, cy: 5, cz: 10 });
    expect(f.radius).toBeCloseTo(Math.sqrt(100 + 100 + 400) / 2);
  });
});

describe('defensive row models (legacy / partial metas never throw)', () => {
  it('worldRow with missing stats, params, bbox, details', () => {
    const bad = { id: 'x', name: '', createdAt: '', updatedAt: '' } as unknown as WorldMeta;
    const r = worldRow(bad);
    expect(r).toMatchObject({ name: 'Untitled world', voxels: '0', buildings: '0', details: 0, source: 'Overpass', centre: '?', date: '?' });
    expect(() => worldRow({ ...bad, stats: { voxelCount: NaN } as never, details: null as never, voxelSize: 'x' as never })).not.toThrow();
  });
  it('worldRow falls back to params.bbox / voxelSize', () => {
    const w = { ...W('a', '2026-01-01T00:00:00Z'), bbox: undefined, voxelSize: undefined } as unknown as WorldMeta;
    const r = worldRow(w);
    expect(r.centre).toBe('47.5000°N 8.5000°E');
    expect(r.voxelSize).toBe('1 m');
  });
  it('detailRows with partial stats', () => {
    const r = detailRows([{ id: 'a', worldId: 'w', buildingId: 'way/1', createdAt: 'bogus', interior: false } as unknown as DetailRecord]);
    expect(r[0]).toMatchObject({ voxels: '0', voxelSize: '0 m', date: 'bogus' });
  });
});

describe('library search / sort / totals', () => {
  const op = (id: string): WorldMeta['params'] => ({ ...W(id, '').params, dataSource: { kind: 'overpass' } });
  const a = { ...W('a', '2026-03-01T00:00:00Z'), name: 'Zurich', sizeBytes: 5_000_000, params: op('a') };
  const b = { ...W('b', '2026-01-01T00:00:00Z'), name: 'berlin 10', sizeBytes: 20_000_000, params: { ...W('b', '').params, dataSource: { kind: 'pbf' as const, regionId: 'germany/berlin' } } };
  const c = { ...W('c', '2026-02-01T00:00:00Z'), name: 'Berlin 2', sizeBytes: 1_000_000, params: op('c') };
  it('filters by name, region id and source', () => {
    expect(filterWorlds([a, b, c], 'berl').map((w) => w.id)).toEqual(['b', 'c']);
    expect(filterWorlds([a, b, c], 'germany/').map((w) => w.id)).toEqual(['b']);
    expect(filterWorlds([a, b, c], 'overpass').map((w) => w.id)).toEqual(['a', 'c']);
    expect(filterWorlds([a, b, c], '  ').length).toBe(3);
  });
  it('sorts newest, name (natural) and size', () => {
    expect(sortWorldsBy([a, b, c], 'newest').map((w) => w.id)).toEqual(['a', 'c', 'b']);
    expect(sortWorldsBy([a, b, c], 'name').map((w) => w.id)).toEqual(['c', 'b', 'a']);
    expect(sortWorldsBy([a, b, c], 'size').map((w) => w.id)).toEqual(['b', 'a', 'c']);
  });
  it('total size and marker legend', () => {
    expect(fmtBytesTotal([a, b, c])).toBe('26 MB');
    expect(markerLegend(2, 1)).toBe('Saved details: 2 on 1 building');
    expect(markerLegend(0, 0)).toBe('Saved details: 0 on 0 buildings');
  });
  it('stripCode removes internal error codes only', () => {
    expect(stripCode('PBF_NO_COVERAGE: region does not cover the bbox')).toBe('region does not cover the bbox');
    expect(stripCode('plain message')).toBe('plain message');
    expect(stripCode('Error: x')).toBe('Error: x');
  });
});

describe('library size notes', () => {
  it('detail size note appears above ~10 MB (20 B/voxel)', () => {
    expect(detailLibraryBytes(500_000)).toBe(10_000_000);
    expect(detailSizeNote(500_000)).toBeNull();
    expect(detailSizeNote(5_000_000)).toBe('This detail will use about 100 MB in your library.');
    expect(detailSizeNote(-1)).toBeNull();
  });
  it('library warning above 1.5 GB', () => {
    expect(libraryTooBig([{ ...W('a', '2026-01-01T00:00:00Z'), sizeBytes: 1_400_000_000 }])).toBe(false);
    expect(libraryTooBig([{ ...W('a', '2026-01-01T00:00:00Z'), sizeBytes: 1_000_000_000 }, { ...W('b', '2026-01-01T00:00:00Z'), sizeBytes: 600_000_000 }])).toBe(true);
  });
});
