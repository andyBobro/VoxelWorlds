// Live check against download.geofabrik.de (tiny Monaco extract). Run: GEODATA_LIVE=1 npx vitest run tests/geodata.live.test.ts
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GeodataManager } from '../src/main/geodata';

describe.skipIf(!process.env.GEODATA_LIVE)('Geofabrik live (monaco)', () => {
  it('catalogue, suggestion, download, md5, resolve', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vw-geo-live-'));
    try {
      const events: string[] = [];
      const m = new GeodataManager({ dir, version: '0.0.0-test', log: console.log, onProgress: (e) => events.push(e.phase) });
      const regions = await m.listRegions();
      expect(regions.length).toBeGreaterThan(300);
      const s = await m.suggest({ latMin: 43.7370, lonMin: 7.4230, latMax: 43.7390, lonMax: 7.4260 });
      console.log('suggested:', s.map((r) => `${r.id} (${r.sizeBytes ?? '?'})`).join(', '));
      expect(s[0].id).toBe('monaco');
      const e = await m.download('monaco');
      expect(e.verified).toBe(true);
      expect(statSync(e.pbfPath).size).toBe(e.sizeBytes);
      expect(events.at(-1)).toBe('done');
      const ds = await m.resolveDataSource({ kind: 'pbf', regionId: 'monaco' });
      console.log('resolved:', ds, e.sizeBytes, 'bytes');
      // offline from cache
      const off = new GeodataManager({ dir, version: '0', indexUrl: 'http://127.0.0.1:1/x', urlPolicy: () => true });
      expect((await off.listRegions({ refresh: true })).find((r) => r.id === 'monaco')?.downloaded).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
