import { describe, expect, it } from 'vitest';
import type { GeodataProgress, GeodataRegion } from '../src/shared/contract';
import {
  ancestorIds, buildRegionTree, chooseDefaultRegion, downloadedAlternative, downloadView, flattenTree, fmtBytes, fmtEta, fmtSpeed,
  loadSavedSource, needsDownloadConfirm, parseSavedSource, regionPath, saveSource, searchRegions, sortSuggestions, sourceBlockReason,
  stageLabel, SOURCE_KEY, extractChanged, friendlyWarning, isCovering,
} from '../src/renderer/lib/geodata';

const R = (id: string, name: string, parent?: string, sizeBytes?: number): GeodataRegion => ({ id, name, parent, pbfUrl: `https://x/${id}.pbf`, sizeBytes });
const CAT = [
  R('europe', 'Europe', undefined, 30e9), R('germany', 'Germany', 'europe', 4.3e9), R('germany/berlin', 'Berlin', 'germany', 82e6),
  R('switzerland', 'Switzerland', 'europe', 480e6), R('france/ile-de-france', 'Île-de-France', 'france', 330e6), R('france', 'France', 'europe', 4.4e9),
  R('orphan', 'Orphan Land', 'missing-parent', 5e6), R('antarctica', 'Antarctica'),
];

describe('region tree', () => {
  it('builds hierarchy sorted by name, orphans become roots', () => {
    const t = buildRegionTree(CAT);
    expect(t.map((n) => n.region.id)).toEqual(['antarctica', 'europe', 'orphan']);
    const eu = t.find((n) => n.region.id === 'europe')!;
    expect(eu.children.map((c) => c.region.id)).toEqual(['france', 'germany', 'switzerland']);
    expect(eu.children[1]!.children[0]!.region.id).toBe('germany/berlin');
  });
  it('flatten honours expanded set and depth', () => {
    const t = buildRegionTree(CAT);
    expect(flattenTree(t, new Set()).map((r) => r.region.id)).toEqual(['antarctica', 'europe', 'orphan']);
    const rows = flattenTree(t, new Set(['europe', 'germany']));
    expect(rows.map((r) => `${r.depth}:${r.region.id}`)).toEqual([
      '0:antarctica', '0:europe', '1:france', '1:germany', '2:germany/berlin', '1:switzerland', '0:orphan',
    ]);
    expect(rows.find((r) => r.region.id === 'germany')).toMatchObject({ hasChildren: true, expanded: true, path: 'Europe' });
  });
  it('is cycle safe', () => {
    const cyc = [R('a', 'A', 'b'), R('b', 'B', 'a')];
    expect(() => buildRegionTree(cyc)).not.toThrow();
    const m = new Map(cyc.map((r) => [r.id, r]));
    expect(regionPath(m, 'a').length).toBeGreaterThan(0);
    expect(ancestorIds(m, 'a').length).toBeLessThanOrEqual(2);
  });
  it('path and ancestors', () => {
    const m = new Map(CAT.map((r) => [r.id, r]));
    expect(regionPath(m, 'germany/berlin')).toBe('Europe > Germany');
    expect(ancestorIds(m, 'germany/berlin')).toEqual(['germany', 'europe']);
    expect(regionPath(m, 'europe')).toBe('');
  });
});

describe('search', () => {
  it('empty query -> nothing', () => expect(searchRegions(CAT, '  ')).toEqual([]));
  it('ranks exact > prefix > word > contains > id; diacritics folded', () => {
    expect(searchRegions(CAT, 'berlin')[0]!.region.id).toBe('germany/berlin');
    expect(searchRegions(CAT, 'ile de')[0]).toBeUndefined();
    expect(searchRegions(CAT, 'ile-de')[0]!.region.id).toBe('france/ile-de-france');
    expect(searchRegions(CAT, 'ÎLE')[0]!.region.id).toBe('france/ile-de-france');
    const r = searchRegions(CAT, 'ge'); // Germany (prefix) before Orphan? only Germany matches name prefix
    expect(r[0]!.region.id).toBe('germany');
  });
  it('contains + id match, with path labels', () => {
    const r = searchRegions(CAT, 'land');
    expect(r.map((x) => x.region.id)).toEqual(['orphan', 'switzerland']); // word prefix beats plain contains
    expect(r[1]!.path).toBe('Europe');
    expect(searchRegions(CAT, 'ile-de-france/').length).toBe(0);
    expect(searchRegions(CAT, 'germany/').map((x) => x.region.id)).toEqual(['germany/berlin']);
  });
});

describe('suggestions', () => {
  it('sorted smallest first, unknown size last', () => {
    const s = sortSuggestions([CAT[0]!, CAT[7]!, CAT[2]!, CAT[1]!]);
    expect(s.map((r) => r.id)).toEqual(['germany/berlin', 'germany', 'europe', 'antarctica']);
  });
  it('default is the smallest covering, null for none', () => {
    expect(chooseDefaultRegion([CAT[1]!, CAT[2]!])!.id).toBe('germany/berlin');
    expect(chooseDefaultRegion([])).toBeNull();
  });
  it('offers an already downloaded alternative', () => {
    const l = [CAT[2]!, CAT[1]!, CAT[0]!];
    expect(downloadedAlternative(l, new Set(['germany']), 'germany/berlin')!.id).toBe('germany');
    expect(downloadedAlternative(l, new Set(['germany/berlin']), 'germany/berlin')).toBeNull();
  });
});

describe('formatting', () => {
  it('bytes', () => {
    expect(fmtBytes(undefined)).toBe('?');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(4_200_000)).toBe('4.2 MB');
    expect(fmtBytes(82_000_000)).toBe('82 MB');
    expect(fmtBytes(4_300_000_000)).toBe('4.30 GB');
  });
  it('speed + eta', () => {
    expect(fmtSpeed(0)).toBe('');
    expect(fmtSpeed(12_000_000)).toBe('12 MB/s');
    expect(fmtEta(45)).toBe('45 s');
    expect(fmtEta(200)).toBe('3 min 20 s');
    expect(fmtEta(3900)).toBe('1 h 05 min');
    expect(fmtEta(NaN)).toBe('');
    expect(fmtEta(-1)).toBe('');
  });
  it('confirm threshold 200 MB, unknown size confirms', () => {
    expect(needsDownloadConfirm(200_000_000)).toBe(false);
    expect(needsDownloadConfirm(200_000_001)).toBe(true);
    expect(needsDownloadConfirm(undefined)).toBe(true);
    expect(needsDownloadConfirm(82e6)).toBe(false);
  });
});

describe('downloadView', () => {
  const p = (o: Partial<GeodataProgress>): GeodataProgress => ({ regionId: 'x', phase: 'download', receivedBytes: 0, ...o });
  it('pct, amount, speed, eta', () => {
    const v = downloadView(p({ receivedBytes: 100e6, totalBytes: 400e6, bytesPerSec: 10e6 }));
    expect(v.pct).toBe(25);
    expect(v.amount).toBe('100 MB of 400 MB');
    expect(v.speed).toBe('10 MB/s');
    expect(v.eta).toBe('30 s');
  });
  it('unknown total -> indeterminate; verify phase has no eta', () => {
    expect(downloadView(p({ receivedBytes: 5e6 })).pct).toBeNull();
    const v = downloadView(p({ phase: 'verify', receivedBytes: 1, totalBytes: 1, bytesPerSec: 5 }));
    expect(v.eta).toBe('');
    expect(v.message).toMatch(/Verifying/);
  });
  it('clamps pct', () => expect(downloadView(p({ receivedBytes: 9, totalBytes: 3 })).pct).toBe(100));
});

describe('source gating + persistence', () => {
  const regions = new Map(CAT.map((r) => [r.id, r]));
  it('overpass never blocked', () => expect(sourceBlockReason({ kind: 'overpass' }, regions, new Set(), null)).toBe(''));
  it('pbf needs a downloaded region', () => {
    expect(sourceBlockReason({ kind: 'pbf', regionId: '' }, regions, new Set(), null)).toMatch(/Choose/);
    expect(sourceBlockReason({ kind: 'pbf', regionId: 'switzerland' }, regions, new Set(), null)).toMatch(/Download the Switzerland/);
    expect(sourceBlockReason({ kind: 'pbf', regionId: 'switzerland' }, regions, new Set(['switzerland']), 'switzerland')).toMatch(/Downloading/);
    expect(sourceBlockReason({ kind: 'pbf', regionId: 'switzerland' }, regions, new Set(['switzerland']), null)).toBe('');
  });
  it('parse is defensive', () => {
    expect(parseSavedSource(null)).toEqual({ kind: 'overpass' });
    expect(parseSavedSource('{oops')).toEqual({ kind: 'overpass' });
    expect(parseSavedSource('{"kind":"pbf","regionId":"germany"}')).toEqual({ kind: 'pbf', regionId: 'germany' });
    expect(parseSavedSource('{"kind":"pbf","regionId":5}')).toEqual({ kind: 'pbf', regionId: undefined });
    expect(parseSavedSource('{"kind":"nope"}')).toEqual({ kind: 'overpass' });
  });
  it('storage access is guarded', () => {
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadSavedSource(throwing)).toEqual({ kind: 'overpass' });
    expect(() => saveSource(throwing, { kind: 'pbf', regionId: 'a' })).not.toThrow();
    expect(loadSavedSource(null)).toEqual({ kind: 'overpass' });
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveSource(st, { kind: 'pbf', regionId: 'germany' });
    expect(mem.has(SOURCE_KEY)).toBe(true);
    expect(loadSavedSource(st)).toEqual({ kind: 'pbf', regionId: 'germany' });
  });
});

describe('stageLabel', () => {
  it('pbf scan gets a clear label', () => {
    expect(stageLabel('pbf', '10% scanned')).toBe('Reading local OSM data… 10% scanned');
    expect(stageLabel('pbf', '')).toBe('Reading local OSM data…');
    expect(stageLabel('osm', 'fetching')).toBe('osm: fetching');
  });
});

describe('covering vs overlapping suggestions', () => {
  const cov = { ...R('a', 'Cover big', undefined, 900e6) };
  const small = { ...R('b', 'Overlap small', undefined, 10e6), covers: false } as GeodataRegion;
  const cov2 = { ...R('c', 'Cover small', undefined, 100e6) };
  it('covering first (smallest first), overlapping after', () => {
    expect(sortSuggestions([small, cov, cov2]).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(isCovering(small)).toBe(false);
    expect(isCovering(cov)).toBe(true);
  });
  it('default pick is a covering region only', () => {
    expect(chooseDefaultRegion([small, cov, cov2])!.id).toBe('c');
    expect(chooseDefaultRegion([small])).toBeNull();
  });
  it('downloaded alternative never an overlapping one', () => {
    expect(downloadedAlternative([small, cov], new Set(['b']), null)).toBeNull();
  });
});

describe('warnings and extract staleness', () => {
  it('friendly warning text, unknown codes pass through', () => {
    expect(friendlyWarning('SOURCE_CHANGED', '')!.text).toMatch(/updated since/);
    expect(friendlyWarning('OSM_CACHE_STALE', '')!.text).toMatch(/out of date/);
    expect(friendlyWarning('DETAIL_NOT_SAVED', 'DOWNLOAD_FAILED: disk full')!.text).toBe('The detail was generated but could not be saved to the library (disk full).');
    expect(friendlyWarning('NO_MAPILLARY_COVERAGE', 'x')).toBeNull();
  });
  it('extractChanged compares size and date, ignores unknowns', () => {
    expect(extractChanged(undefined, { sizeBytes: 1 })).toBe(false);
    expect(extractChanged({ sizeBytes: 1 }, undefined)).toBe(false);
    expect(extractChanged({ sizeBytes: 1, sourceDate: 'a' }, { sizeBytes: 1, sourceDate: 'a' })).toBe(false);
    expect(extractChanged({ sizeBytes: 1, sourceDate: 'a' }, { sizeBytes: 2, sourceDate: 'a' })).toBe(true);
    expect(extractChanged({ sizeBytes: 1, sourceDate: 'a' }, { sizeBytes: 1, sourceDate: 'b' })).toBe(true);
    expect(extractChanged({ sizeBytes: 1 }, { sizeBytes: 1, sourceDate: 'b' })).toBe(false);
  });
});
