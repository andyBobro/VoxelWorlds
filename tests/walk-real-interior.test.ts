import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseVwg } from '../src/shared/vwg';
import { buildChunkStore, buildLinearPalette, type ChunkStore } from '../src/renderer/walk/chunkStore';
import { Mover, scaleFromCityVoxel } from '../src/renderer/walk/physics';

/**
 * Regression on interiors written by the real Python generator, axis aligned and rotated 33 / 90 / 135 degrees, houses
 * and offices at 0.15 and 0.2 m voxels. Skipped unless WALK_INTERIOR_DIR points at the output of
 * scripts/walk-interior-fixture.py (see its header). With the real Mover (disc body, indoor step cap) and plain voxel
 * collision only (no door special-casing) it checks:
 *  1. walking from `outside` along `dir` enters the building through the carved doorway;
 *  2. from the entrance, steering along breadth-first routes reaches EVERY ground-floor room and the highest storey
 *     (the stairs), holding forward only (no jumping).
 */
const DIR = process.env.WALK_INTERIOR_DIR;
const NAMES = DIR ? fs.readdirSync(DIR).filter((n) => n.endsWith('.routes.json')).map((n) => n.replace('.routes.json', '')).sort() : [];
const IDLE = { wishX: 0, wishZ: 0, run: false, jump: false };

function load(name: string): { st: ChunkStore; ent: { inside: number[]; outside: number[]; dir: number[] }; routes: { unreachable: string[]; routes: Array<{ name: string; kind: string; path: number[][] }> } } {
  const b = fs.readFileSync(`${DIR}/${name}.vwg`);
  const d = parseVwg(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  const st = buildChunkStore(d, buildLinearPalette(d.header.palette));
  const stats = JSON.parse(fs.readFileSync(`${DIR}/${name}.json`, 'utf8'));
  return { st, ent: stats.entrances[0], routes: JSON.parse(fs.readFileSync(`${DIR}/${name}.routes.json`, 'utf8')) };
}

function mk(st: ChunkStore, x: number, y: number, z: number): Mover {
  const m = new Mover(st, scaleFromCityVoxel(1));
  m.indoor = true; m.speeds = { walk: 3, run: 6 };
  m.teleport(x, y + 0.002, z);
  for (let i = 0; i < 60; i++) m.step(1 / 60, IDLE);
  return m;
}

/** Steers along `path` (lookahead of one cell) with forward-only input; -> seconds taken, or -1 if it never arrived. */
function follow(m: Mover, path: number[][], maxSeconds = 180): number {
  const top = path[path.length - 1]!;
  let idx = 1;
  for (let t = 0; t < 60 * maxSeconds; t++) {
    while (idx < path.length - 1 && Math.hypot(path[idx]![0]! - m.p[0]!, path[idx]![2]! - m.p[2]!) < 0.12 && Math.abs(path[idx]![1]! - m.p[1]!) < 0.4) idx++;
    const look = path[idx]!;
    const dx = look[0]! - m.p[0]!, dz = look[2]! - m.p[2]!, l = Math.hypot(dx, dz) || 1;
    m.step(1 / 60, { ...IDLE, wishX: dx / l, wishZ: dz / l });
    if (Math.abs(m.p[1]! - top[1]!) < 0.2 && Math.hypot(top[0]! - m.p[0]!, top[2]! - m.p[2]!) < 0.45) return t / 60;
  }
  return -1;
}

describe.skipIf(!DIR)('real generated interiors (disc body)', () => {
  it('found fixtures', () => expect(NAMES.length).toBeGreaterThanOrEqual(12));
  for (const name of NAMES) {
    describe(name, () => {
      const f = DIR ? load(name) : null;
      it('walks in through the carved doorway along dir', () => {
        const { st, ent } = f!;
        const o = mk(st, ent.outside[0]!, ent.outside[1]!, ent.outside[2]!);
        for (let i = 0; i < 180; i++) o.step(1 / 60, { ...IDLE, wishX: ent.dir[0]!, wishZ: ent.dir[1]! });
        expect((o.p[0]! - ent.outside[0]!) * ent.dir[0]! + (o.p[2]! - ent.outside[2]!) * ent.dir[1]!).toBeGreaterThan(1.0);
      });
      it('reaches every ground-floor room and the top storey', () => {
        const { st, ent, routes } = f!;
        expect(routes.unreachable, 'destinations with no route for a 0.6 m disc').toEqual([]);
        const failed: string[] = [];
        for (const r of routes.routes) {
          const m = mk(st, ent.inside[0]!, ent.inside[1]!, ent.inside[2]!);
          if (follow(m, r.path) < 0) failed.push(`${r.name} stuck at ${Array.from(m.p).map((v) => v.toFixed(2)).join(',')}`);
        }
        expect(failed).toEqual([]);
        expect(routes.routes.length).toBeGreaterThan(0);
      });
    });
  }
});
