import { describe, expect, it } from 'vitest';
import { GRAVITY, HEIGHT, HALF_W, JUMP_APEX_M, Mover, scaleFromCityVoxel, type CollisionWorld, type MoveInput } from '../src/renderer/walk/physics';

/** Flat ground (y < 0 solid) over a 400 x 400 voxel area plus arbitrary extra solids. */
function world(vs: number, extra: (x: number, y: number, z: number) => boolean = () => false, half = 200): CollisionWorld {
  return {
    vs,
    min: [-half, -10, -half], max: [half, 200, half],
    materials: [],
    cell: (x, y, z) => (y < 0 || extra(x, y, z) ? 1 : 0),
  };
}
const IDLE: MoveInput = { wishX: 0, wishZ: 0, run: false, jump: false };
const FWD: MoveInput = { wishX: 1, wishZ: 0, run: false, jump: false };

function settle(m: Mover, dt = 1 / 60, secs = 1): void {
  for (let i = 0; i < secs / dt; i++) m.step(dt, IDLE);
}
function mover(vs: number, ex?: (x: number, y: number, z: number) => boolean, cityVs = vs): Mover {
  const m = new Mover(world(vs, ex), scaleFromCityVoxel(cityVs));
  m.teleport(0.5 * vs, 0, 0.5 * vs);
  settle(m);
  return m;
}
const walk = (m: Mover, inp: MoveInput, secs: number, dt = 1 / 60): void => {
  for (let i = 0; i < secs / dt; i++) m.step(dt, inp);
};

describe('scaleFromCityVoxel', () => {
  it('clamps outdoor step height to [0.25, 2.0] m, caps the indoor step at 0.35 m and jumps a constant 0.5 m', () => {
    expect(scaleFromCityVoxel(0.1).stepUp).toBe(0.25);
    expect(scaleFromCityVoxel(0.5).stepUp).toBe(0.5);
    expect(scaleFromCityVoxel(2).stepUp).toBe(2);
    expect(scaleFromCityVoxel(5).stepUp).toBe(2);
    expect(scaleFromCityVoxel(1).indoorStepUp).toBe(0.35);
    expect(scaleFromCityVoxel(0.25).indoorStepUp).toBe(0.25);
    expect(scaleFromCityVoxel(1).jumpHeight).toBeCloseTo(0.5);
    expect(scaleFromCityVoxel(0.1).jumpHeight).toBeCloseTo(0.5);
    expect(scaleFromCityVoxel(5).jumpHeight).toBeCloseTo(0.5);
    const s = scaleFromCityVoxel(0.5);
    expect(s.jumpHeight).toBeCloseTo(0.5);
    expect(s.jumpSpeed ** 2 / (2 * GRAVITY)).toBeCloseTo(s.jumpHeight);
  });
});

describe('ground', () => {
  it('lands on the ground and stays there', () => {
    const m = new Mover(world(0.5), scaleFromCityVoxel(0.5));
    m.teleport(0, 3, 0);
    settle(m, 1 / 60, 2);
    expect(m.onGround).toBe(true);
    expect(m.p[1]).toBeCloseTo(0, 5);
    expect(m.vy).toBe(0);
  });

  it('is lifted out of a wall it was teleported into', () => {
    const m = new Mover(world(0.5, (x, y) => y >= 0 && y < 4), scaleFromCityVoxel(0.5));
    m.teleport(0, 0, 0);
    expect(m.overlaps()).toBe(false);
    expect(m.p[1]).toBeGreaterThanOrEqual(2);
  });
});

describe('step-up', () => {
  // 1 voxel = stepUp exactly (vs 0.5 -> stepUp 0.5). Ledge wall at x >= 3 (1.5 m).
  it('climbs a ledge of exactly stepUp', () => {
    const m = mover(0.5, (x, y) => x >= 3 && y < 1);
    walk(m, FWD, 1.5);
    expect(m.p[0]).toBeGreaterThan(1.9);
    expect(m.p[1]).toBeCloseTo(0.5, 5);
    expect(m.onGround).toBe(true);
  });

  it('does not climb stepUp + epsilon', () => {
    // vs 0.1 world, stepUp forced to 0.3 m: a 3-voxel ledge (0.3) passes, a 4-voxel ledge (0.4) does not
    const s = { stepUp: 0.3, jumpHeight: 0.66, jumpSpeed: Math.sqrt(2 * GRAVITY * 0.66) };
    const ok = new Mover(world(0.1, (x, y) => x >= 10 && y < 3), s);
    ok.teleport(0.5, 0, 0.05); settle(ok);
    walk(ok, FWD, 1.5);
    expect(ok.p[0]).toBeGreaterThan(1.5);
    expect(ok.p[1]).toBeCloseTo(0.3, 5);

    const tooHigh = new Mover(world(0.1, (x, y) => x >= 10 && y < 4), s);
    tooHigh.teleport(0.5, 0, 0.05); settle(tooHigh);
    walk(tooHigh, FWD, 1.5);
    expect(tooHigh.p[0]).toBeCloseTo(1.0 - HALF_W, 4);
    expect(tooHigh.p[1]).toBeCloseTo(0, 5);
  });

  it('climbs 0.2 m stair risers indoors while holding forward, using the city step height', () => {
    // detail voxels 0.15 m... use 0.2 m risers on a 0.1 m grid: each stair is 2 voxels high, 3 voxels (0.3 m) deep
    const stairs = (x: number, y: number): boolean => x >= 10 && y < Math.floor((x - 10) / 3 + 1) * 2;
    const m = mover(0.1, stairs, 1.0);
    m.indoor = true;
    walk(m, FWD, 3);
    expect(m.p[1]).toBeGreaterThan(2.0);
    expect(m.onGround).toBe(true);
  });

  it('walks back down the stairs without bouncing (stays grounded)', () => {
    const stairs = (x: number, y: number): boolean => x >= 10 && y < Math.floor((x - 10) / 3 + 1) * 2;
    const m = mover(0.1, stairs, 1.0);
    m.indoor = true;
    walk(m, FWD, 3);
    const back: MoveInput = { ...FWD, wishX: -1 };
    let airFrames = 0;
    for (let i = 0; i < 240; i++) { m.step(1 / 60, back); if (!m.onGround) airFrames++; }
    expect(m.p[1]).toBeLessThan(0.05);
    expect(airFrames).toBe(0);
  });

  it('does not step up while airborne', () => {
    const m = mover(0.5, (x, y) => x >= 6 && y < 1);
    m.vy = 4; m.onGround = false; m.airTime = 1;
    // mid-air next to a 1-voxel ledge: stays blocked until it clears the top by itself
    let blockedAtGroundLevel = true;
    for (let i = 0; i < 6; i++) { m.step(1 / 60, FWD); if (m.p[0] > 3 - HALF_W + 1e-3 && m.p[1] < 0.5) blockedAtGroundLevel = false; }
    expect(blockedAtGroundLevel).toBe(true);
  });
});

describe('indoor step cap', () => {
  it('does not auto-climb a 0.45 m box indoors but does outdoors (stepUp 1 m)', () => {
    const box = (x: number, y: number): boolean => x >= 10 && y < 3; // 3 voxels of 0.15 = 0.45 m
    const out = mover(0.15, box, 1.0);
    walk(out, FWD, 1.5);
    expect(out.p[1]).toBeCloseTo(0.45, 5);
    const inn = mover(0.15, box, 1.0);
    inn.indoor = true;
    walk(inn, FWD, 1.5);
    expect(inn.p[1]).toBeCloseTo(0, 5);
    expect(inn.p[0]).toBeLessThan(1.5);
  });
  it('indoor jump apex is also 0.5 m', () => {
    const m = mover(0.15, undefined, 1.0);
    m.indoor = true;
    let max = 0;
    m.step(1 / 120, { ...IDLE, jump: true });
    for (let i = 0; i < 400; i++) { m.step(1 / 120, IDLE); max = Math.max(max, m.p[1]!); }
    expect(Math.abs(max - 0.5)).toBeLessThanOrEqual(0.02);
  });
});

/**
 * Real-interior stair profile: a 45 degree ramp (tread = riser = 1 voxel) in a 5-voxel wide corridor with a soffit
 * (the underside of the storey above) `soffit` metres over the treads, level landing at the top.
 */
function stairWorld(vs: number, soffitM: number, steps: number): { ex: (x: number, y: number, z: number) => boolean; topY: number } {
  const x0 = 20, sv = Math.round(soffitM / vs), len = steps, topVox = steps + 1;
  const h = (x: number): number => (x < x0 ? 0 : Math.min(topVox, x - x0 + 1));
  const ex = (x: number, y: number, z: number): boolean => {
    if (z < -3 || z > 3) return y < 80; // corridor walls
    if (x >= x0 && x < x0 + len + 12 && y >= h(x) + sv) return true; // soffit / next storey slab
    if (x >= x0 + len + 12) return y < 80; // end wall behind the landing
    return y < h(x) && y >= 0;
  };
  return { ex, topY: topVox * vs };
}

describe('real stair profile (45 degree ramp with a soffit)', () => {
  for (const vs of [0.15, 0.2]) {
    for (const soffit of [2.5, 2.8]) {
      it(`climbs every start offset at ${vs} m voxels, soffit ${soffit} m, holding W`, () => {
        const { ex, topY } = stairWorld(vs, soffit, 22);
        let worst = Infinity;
        for (const dx of [0, 0.2, 0.4, 0.6, 0.8]) {
          for (const dz of [-0.06, 0, 0.06]) {
            const m = new Mover(world(vs, ex), scaleFromCityVoxel(1));
            m.indoor = true;
            m.speeds = { walk: 3, run: 6 };
            m.teleport(1.2 * vs * 10 + dx * vs * 4 + 0.05, 0, dz + 0.5 * vs);
            settle(m);
            walk(m, FWD, 14, 1 / 60);
            worst = Math.min(worst, m.p[1]!);
          }
        }
        expect(worst).toBeGreaterThanOrEqual(topY - 1e-3);
      });
    }
  }

  it('documents the geometric limit: over a 45 degree ramp the rear of the 0.6 m box sits 0.6 m lower, so the soffit must be >= 1.8 + 0.6 = 2.4 m; 2.25 m is not climbable', () => {
    const vs = 0.15;
    const { ex } = stairWorld(vs, 2.25, 22);
    const m = new Mover(world(vs, ex), scaleFromCityVoxel(1));
    m.indoor = true;
    m.speeds = { walk: 3, run: 6 };
    m.teleport(2.0, 0, 0.075); settle(m);
    walk(m, FWD, 14);
    expect(m.p[1]).toBeLessThan(1.0);
  });

  it('walks back down the whole flight staying grounded', () => {
    const vs = 0.15;
    const { ex, topY } = stairWorld(vs, 2.5, 22);
    const m = new Mover(world(vs, ex), scaleFromCityVoxel(1));
    m.indoor = true;
    m.speeds = { walk: 3, run: 6 };
    m.teleport(1.2 * vs * 10 + 0.05, 0, 0.5 * vs); settle(m);
    walk(m, FWD, 14);
    expect(m.p[1]).toBeGreaterThanOrEqual(topY - 1e-3);
    let air = 0;
    for (let i = 0; i < 60 * 14; i++) { m.step(1 / 60, { ...FWD, wishX: -1 }); if (!m.onGround) air++; }
    expect(m.p[1]).toBeLessThan(0.05);
    expect(air).toBe(0);
  });
});

describe('jump', () => {
  function peak(vs: number): number {
    const m = mover(vs, undefined, vs);
    let max = 0;
    m.step(1 / 120, { ...IDLE, jump: true });
    for (let i = 0; i < 240; i++) { m.step(1 / 120, IDLE); max = Math.max(max, m.p[1]!); }
    return max;
  }
  it('apex is 0.5 m +-0.02 for every voxel size', () => {
    for (const vs of [0.1, 0.25, 0.5, 1, 2]) expect(Math.abs(peak(vs) - 0.5)).toBeLessThanOrEqual(0.02);
  });
  it('lands again', () => {
    const m = mover(0.5);
    m.step(1 / 60, { ...IDLE, jump: true });
    walk(m, IDLE, 2);
    expect(m.onGround).toBe(true);
    expect(m.p[1]).toBeCloseTo(0, 5);
  });
  it('cannot jump twice in the air', () => {
    const m = mover(0.5);
    m.step(1 / 60, { ...IDLE, jump: true });
    for (let i = 0; i < 12; i++) m.step(1 / 60, { ...IDLE, jump: true });
    const h = m.p[1]!;
    expect(h).toBeLessThan(0.5 + 1e-3);
  });

  // vs 0.05 world (stepUp forced to 0.25 m would auto-take it, so use a scale with stepUp 0.1): an obstacle taller than
  // the auto step can only be cleared by the 0.5 m jump (auto step is off in the air)
  const sc = { stepUp: 0.1, jumpHeight: JUMP_APEX_M, jumpSpeed: Math.sqrt(2 * GRAVITY * JUMP_APEX_M) };
  function tryClimb(n: number): Mover {
    const m = new Mover(world(0.05, (x, y) => x >= 40 && y < n), sc);
    m.teleport(1.0, 0, 0.025); settle(m);
    m.step(1 / 60, { ...FWD, jump: true });
    walk(m, FWD, 1.6);
    return m;
  }
  it('walking alone does not take a 0.45 m obstacle (above auto step)', () => {
    const m = new Mover(world(0.05, (x, y) => x >= 40 && y < 9), sc);
    m.teleport(1.0, 0, 0.025); settle(m);
    walk(m, FWD, 1.6);
    expect(m.p[1]).toBeCloseTo(0, 5);
  });
  it('jump clears a 0.45 m obstacle', () => {
    const m = tryClimb(9);
    expect(m.p[1]).toBeCloseTo(0.45, 5);
    expect(m.p[0]).toBeGreaterThan(2.1);
  });
  it('jump does not clear a 0.6 m obstacle', () => {
    const m = tryClimb(12);
    expect(m.p[1]).toBeCloseTo(0, 5);
    expect(m.p[0]).toBeLessThan(2.0);
  });
  it('jumps onto a 0.4 m indoor bench', () => {
    const m = new Mover(world(0.1, (x, y) => x >= 15 && y < 4), scaleFromCityVoxel(1));
    m.indoor = true;
    m.teleport(1.0, 0, 0.05); settle(m);
    m.step(1 / 60, { ...FWD, jump: true });
    walk(m, FWD, 1.6);
    expect(m.p[1]).toBeCloseTo(0.4, 5);
    expect(m.p[0]).toBeGreaterThan(1.8);
  });
});

describe('walls', () => {
  it('slides along a wall instead of stopping', () => {
    const m = mover(0.5, (x, y) => x >= 6 && y < 40);
    walk(m, { wishX: 0.7071, wishZ: 0.7071, run: false, jump: false }, 1.5);
    expect(m.p[0]).toBeCloseTo(3 - HALF_W, 3);
    expect(m.p[2]).toBeGreaterThan(5);
  });

  it('never tunnels through a 1-voxel wall at extreme speed and large time steps', () => {
    for (const dt of [1 / 240, 1 / 60, 0.1]) {
      const m = mover(0.5, (x, y) => x === 6 && y < 40);
      m.speeds = { walk: 400, run: 400 };
      walk(m, FWD, 1, dt);
      expect(m.p[0]).toBeLessThanOrEqual(3 - HALF_W + 1e-6);
    }
  });

  it('stops under a low ceiling (head bump)', () => {
    const m = mover(0.5, (x, y) => y === 5 && x >= -200);
    m.step(1 / 60, { ...IDLE, jump: true });
    walk(m, IDLE, 1);
    expect(m.p[1] + HEIGHT).toBeLessThanOrEqual(2.5 + 1e-6);
  });

  it('is held inside the world bounds by invisible walls', () => {
    const m = new Mover(world(1, undefined, 20), scaleFromCityVoxel(1));
    m.teleport(0, 0, 0);
    settle(m);
    walk(m, FWD, 10);
    expect(m.p[0]).toBeCloseTo(20 - HALF_W, 3);
  });

  it('falls off a ledge taller than stepUp and does not stay glued', () => {
    const m = mover(0.5, (x, y) => x < 3 && y < 4); // platform 2 m high, walk off its edge
    m.teleport(0, 2, 0); settle(m);
    expect(m.p[1]).toBeCloseTo(2, 5);
    walk(m, FWD, 0.6);
    expect(m.p[1]).toBeLessThan(2);
  });
});

describe('rescue', () => {
  it('returns to the last standing spot after falling out of the world', () => {
    const w: CollisionWorld = { vs: 1, min: [-50, 0, -50], max: [50, 20, 50], materials: [], cell: (x, y, z) => (y < 0 && x >= 0 ? 1 : 0) };
    const m = new Mover(w, scaleFromCityVoxel(1));
    m.teleport(0.5, 0, 0.5); settle(m);
    m.p[0] = -5; // walk over the void
    let rescued = false;
    for (let i = 0; i < 600 && !rescued; i++) { m.step(1 / 60, IDLE); rescued = m.rescued; }
    expect(rescued).toBe(true);
    expect(m.p[0]).toBeCloseTo(0.5, 5); // the spot where it last stood
  });
});

describe('disc body (diameter 0.6 m)', () => {
  it('slides smoothly along a jagged 45 degree wall: no sticking at voxel corners', () => {
    // (at voxel sizes well above the 0.3 m radius a staircase wall has real flat faces: a head-on push there rightly stops)
    for (const vs of [0.1, 0.15, 0.2]) {
      // wall: every cell with x - z >= 20 (a staircase of voxel corners running along +x+z)
      const m = mover(vs, (x, y, z) => x - z >= 20 && y < 60);
      m.teleport(2.0, 0, 1.0); settle(m);
      let stalls = 0, worst = 0, last = m.p[2]!;
      for (let i = 0; i < 60 * 4; i++) {
        m.step(1 / 60, { ...IDLE, wishX: 1 }); // push straight into the diagonal wall
        if (i > 60) { if (Math.abs(m.p[2]! - last) < 1e-5) { stalls++; worst = Math.max(worst, stalls); } else stalls = 0; }
        last = m.p[2]!;
      }
      expect(worst, `vs ${vs}: longest stall in frames`).toBeLessThanOrEqual(2);
      expect(m.p[2]!).toBeGreaterThan(1.0 + 4); // slid several metres along the wall
    }
  });

  it('glides round a convex block corner instead of catching on it', () => {
    const vs = 0.15;
    // a pillar of 8 x 8 voxels; walk along +x just beside it (centre 0.31 m from its face: the disc almost touches)
    const m = mover(vs, (x, y, z) => x >= 20 && x < 28 && z >= 20 && z < 28 && y < 40);
    m.teleport(1.0, 0, 3.0 - 0.3 - 0.01); settle(m);
    walk(m, { ...IDLE, wishX: 1 }, 3);
    expect(m.p[0]!).toBeGreaterThan(5);
  });

  it('is stopped head-on by a flat wall exactly one radius away', () => {
    const m = mover(0.2, (x, y) => x >= 10 && y < 40);
    walk(m, FWD, 2);
    expect(m.p[0]!).toBeCloseTo(2.0 - 0.3, 4);
  });

  it('fits a 0.9 m doorway (6 voxels of 0.15 m) from several lateral offsets, and slides along the jambs into it', () => {
    const vs = 0.15;
    // wall across z (x slab 10..12) with a 6-voxel gap at z 20..25 (z 3.0 .. 3.9)
    const door = (x: number, y: number, z: number): boolean => x >= 10 && x < 12 && !(z >= 20 && z < 26) && y < 40;
    for (const off of [-0.14, -0.07, 0, 0.07, 0.14]) {
      const m = new Mover(world(vs, door), scaleFromCityVoxel(1));
      m.teleport(1.0, 0, 3.45 + off); settle(m);
      walk(m, FWD, 2.5);
      expect(m.p[0]!, `offset ${off}`).toBeGreaterThan(2.5);
    }
    // a 1.0 m lane (5 voxels of 0.2 m), pushed in at an angle: slides to the opening and through
    const lane = (x: number, y: number, z: number): boolean => x >= 10 && x < 14 && !(z >= 20 && z < 25) && y < 40;
    const m = new Mover(world(0.2, lane), scaleFromCityVoxel(1));
    m.teleport(1.0, 0, 4.3); settle(m);
    walk(m, { ...IDLE, wishX: 0.9, wishZ: -0.1 }, 3);
    expect(m.p[0]!).toBeGreaterThan(3.5);
  });

  it('a 0.55 m gap is too narrow', () => {
    const vs = 0.05;
    const gap = (x: number, y: number, z: number): boolean => x >= 40 && x < 44 && !(z >= 60 && z < 71) && y < 80; // 11 x 0.05 = 0.55 m
    const m = new Mover(world(vs, gap), scaleFromCityVoxel(1));
    m.teleport(1.0, 0, 3.275); settle(m);
    walk(m, FWD, 2);
    expect(m.p[0]!).toBeLessThan(2.0);
  });

  it('outdoors with 1 m voxels: 1-voxel step, 2-voxel ledge and up block (jump is 0.5 m)', () => {
    const step1 = mover(1, (x, y) => x >= 3 && y < 1);
    walk(step1, FWD, 2);
    expect(step1.p[0]!).toBeGreaterThan(4); expect(step1.p[1]!).toBeCloseTo(1, 5);
    const wall2 = mover(1, (x, y) => x >= 3 && y < 2);
    walk(wall2, FWD, 2);
    expect(wall2.p[0]!).toBeCloseTo(3 - 0.3, 4);
    const jump = mover(1, (x, y) => x >= 3 && y < 2);
    jump.step(1 / 60, { ...FWD, jump: true });
    walk(jump, FWD, 2.5);
    expect(jump.p[0]!).toBeCloseTo(3 - 0.3, 4);
    expect(jump.p[1]!).toBeCloseTo(0, 5);
    const wall3 = mover(1, (x, y) => x >= 3 && y < 3);
    wall3.step(1 / 60, { ...FWD, jump: true });
    walk(wall3, FWD, 2.5);
    expect(wall3.p[0]!).toBeCloseTo(3 - 0.3, 4);
  });

  it('never penetrates: random walk against a field of pillars stays outside every solid column', () => {
    const vs = 0.15;
    const pillar = (x: number, y: number, z: number): boolean => y < 40 && ((x * 7 + z * 13) % 11 === 0 || (x % 9 === 0 && z % 5 < 2));
    const m = new Mover(world(vs, pillar), scaleFromCityVoxel(1));
    m.teleport(3.07, 0, 3.07);
    settle(m);
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    let ang = 0;
    for (let i = 0; i < 60 * 40; i++) {
      if (i % 40 === 0) ang = rnd() * Math.PI * 2;
      m.step(1 / 60, { ...IDLE, wishX: Math.cos(ang), wishZ: Math.sin(ang) });
      expect(m.overlaps()).toBe(false);
    }
  });
});
