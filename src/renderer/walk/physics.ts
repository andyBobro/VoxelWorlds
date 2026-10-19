/**
 * First-person character physics at metre scale against a voxel grid. Pure: no Three.js, no DOM.
 *
 * Scale rules (documented decision): step height and jump are defined in METRES from the CITY voxel size:
 *   stepUp       = clamp(cityVoxelSize, 0.25, 2.0) m   outdoors: 1 city voxel (min 0.25 m so stair risers always work,
 *                                                      max 2 m so huge voxels do not make the player a giant)
 *   indoorStepUp = min(stepUp, 0.35) m                 inside buildings (0.15-0.25 m voxels): stairs and thresholds only,
 *                                                      not 1 m furniture
 *   jumpHeight   = 2.2 * stepUp (outdoor value, also indoors) so a 2-voxel city ledge is climbable and a 3-voxel one is not.
 * Gravity is 20 m/s^2; the take-off speed follows from the apex: v = sqrt(2 g h).
 *
 * Collision body: a 1.8 m tall cylinder, 0.6 m in diameter (a disc in plan). Horizontal motion is a swept circle against
 * the rectangles of the solid voxel columns it can reach (exact time of impact against rounded rectangles, so no speed
 * can tunnel through a wall); on impact the remaining motion is projected on the contact tangent (move-and-slide), so the
 * disc glides along diagonal, voxelised walls instead of catching on voxel corners. A column is solid if any voxel in
 * the layers between the feet and the head is solid. Vertical motion sweeps layer by layer over the cells under the disc.
 * Step-up (grounded, or within a short coyote time, never airborne): the move is tried at the current height first;
 * if it is blocked, the SMALLEST lift <= stepUp at which the destination is free is used (candidates: the heights that put
 * the feet on a voxel boundary, then stepUp itself). Only the destination box is tested, not the raised start box, so a
 * low soffit above the stairs behind the player cannot veto the step. After the move the box is lowered onto the ground.
 * Stepping down up to stepUp keeps the feet glued to the ground (stairs descend smoothly; bigger drops fall).
 */

/** Horizontal collision footprint: a DISC of this radius (diameter 0.6 m), so it slides round voxel corners and fits diagonal corridors. */
export const RADIUS = 0.3;
export const HALF_W = RADIUS;
export const HEIGHT = 1.8;
export const EYE_HEIGHT = 1.6;
export const GRAVITY = 20;
const EPS = 1e-6;
const COYOTE = 0.1;

export interface Scale {
  /** outdoor automatic step height, m */
  stepUp: number;
  /** automatic step height inside buildings, m (<= stepUp) */
  indoorStepUp: number;
  jumpHeight: number;
  jumpSpeed: number;
}

export function scaleFromCityVoxel(cityVs: number): Scale {
  const s = Number.isFinite(cityVs) && cityVs > 0 ? cityVs : 1;
  const stepUp = Math.min(2.0, Math.max(0.25, s));
  const jumpHeight = 2.2 * stepUp;
  return { stepUp, indoorStepUp: Math.min(stepUp, 0.35), jumpHeight, jumpSpeed: Math.sqrt(2 * GRAVITY * jumpHeight) };
}

/** What the physics needs from a voxel world. `ChunkStore` satisfies it. */
export interface CollisionWorld {
  readonly vs: number;
  /** palette index at a voxel; 0 = air */
  cell(ix: number, iy: number, iz: number): number;
  /** exclusive voxel bounds of the data; x and z are the invisible walls, y is open */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** palette index -> material tag (water slows the player) */
  readonly materials: ReadonlyArray<string>;
}

export interface MoveInput {
  /** desired horizontal direction in world XZ, magnitude <= 1 */
  wishX: number;
  wishZ: number;
  run: boolean;
  jump: boolean;
}

export interface Speeds { walk: number; run: number }

export const WATER_SLOWDOWN = 0.55;

export class Mover {
  /** feet position (centre of the disc, bottom of the body), metres */
  readonly p = new Float64Array(3);
  vx = 0; vy = 0; vz = 0;
  onGround = false;
  inWater = false;
  /** seconds since the body last touched the ground */
  airTime = 0;
  /** last position known to be standing on something (fall-through recovery) */
  readonly lastSafe = new Float64Array(3);
  speeds: Speeds = { walk: 5, run: 12 };
  speedScale = 1;
  /** set when the last step recovered the player from below the world */
  rescued = false;
  /** inside a building: the smaller indoor step height applies */
  indoor = false;

  private hit = false;
  /** horizontal move: was it cut short by something */
  private blocked = false;
  private waterTag: Uint8Array = new Uint8Array(0);
  // scratch for the horizontal impact search (no allocation in the hot path)
  private bestT = 0;
  private bestNx = 0;
  private bestNz = 0;
  private cNx = 0;
  private cNz = 0;

  constructor(public world: CollisionWorld, public scale: Scale) {
    this.setWorld(world);
  }

  /** Effective automatic step height, m. */
  get stepUp(): number {
    return this.indoor ? this.scale.indoorStepUp : this.scale.stepUp;
  }

  setWorld(w: CollisionWorld, indoor = false): void {
    this.world = w;
    this.indoor = indoor;
    const t = new Uint8Array(Math.max(w.materials.length, 1));
    for (let i = 0; i < w.materials.length; i++) t[i] = w.materials[i] === 'water' ? 1 : 0;
    this.waterTag = t;
  }

  teleport(x: number, y: number, z: number): void {
    this.p[0] = x; this.p[1] = y; this.p[2] = z;
    this.vx = this.vy = this.vz = 0;
    this.onGround = false;
    this.airTime = 0;
    this.depenetrate();
  }

  private solid(ix: number, iy: number, iz: number): boolean {
    const w = this.world;
    if (ix < w.min[0] || ix >= w.max[0] || iz < w.min[2] || iz >= w.max[2]) return true; // invisible walls
    return w.cell(ix, iy, iz) !== 0;
  }

  /** Any solid voxel in column (ix, iz) over layers iy0..iy1? Outside the map every column is solid. */
  private colSolid(ix: number, iz: number, iy0: number, iy1: number): boolean {
    const w = this.world;
    if (ix < w.min[0] || ix >= w.max[0] || iz < w.min[2] || iz >= w.max[2]) return true;
    for (let iy = iy0; iy <= iy1; iy++) if (w.cell(ix, iy, iz) !== 0) return true;
    return false;
  }

  /** Does the voxel column rectangle overlap the disc at (px, pz)? (touching does not count) */
  private discHits(ix: number, iz: number, px: number, pz: number): boolean {
    const vs = this.world.vs;
    const x0 = ix * vs, z0 = iz * vs;
    const dx = Math.max(x0 - px, 0, px - (x0 + vs)), dz = Math.max(z0 - pz, 0, pz - (z0 + vs));
    const r = RADIUS - EPS;
    return dx * dx + dz * dz < r * r;
  }

  /** Any solid voxel in layer `m` under the disc? (vertical sweeps) */
  private layerSolid(m: number): boolean {
    const vs = this.world.vs, px = this.p[0]!, pz = this.p[2]!;
    const xLo = Math.floor((px - RADIUS) / vs), xHi = Math.floor((px + RADIUS) / vs);
    const zLo = Math.floor((pz - RADIUS) / vs), zHi = Math.floor((pz + RADIUS) / vs);
    for (let ix = xLo; ix <= xHi; ix++) {
      for (let iz = zLo; iz <= zHi; iz++) {
        if (this.discHits(ix, iz, px, pz) && this.solid(ix, m, iz)) return true;
      }
    }
    return false;
  }

  /** True if the body overlaps any solid voxel. */
  overlaps(): boolean {
    const vs = this.world.vs, px = this.p[0]!, pz = this.p[2]!;
    const y0 = Math.floor((this.p[1]! + EPS) / vs), y1 = Math.floor((this.p[1]! + HEIGHT - EPS) / vs);
    const xLo = Math.floor((px - RADIUS) / vs), xHi = Math.floor((px + RADIUS) / vs);
    const zLo = Math.floor((pz - RADIUS) / vs), zHi = Math.floor((pz + RADIUS) / vs);
    for (let ix = xLo; ix <= xHi; ix++) {
      for (let iz = zLo; iz <= zHi; iz++) {
        if (this.discHits(ix, iz, px, pz) && this.colSolid(ix, iz, y0, y1)) return true;
      }
    }
    return false;
  }

  /**
   * Vertical move by up to `d`, stopping at the first solid layer under/over the disc. Returns the distance moved and
   * sets `this.hit` when blocked. Exact for any |d|: it walks the layers the leading face crosses.
   */
  private sweepY(d: number): number {
    this.hit = false;
    if (d === 0) return 0;
    const vs = this.world.vs, p = this.p;
    if (d > 0) {
      const face = p[1]! + HEIGHT;
      const first = Math.floor((face - EPS) / vs) + 1;
      const last = Math.floor((face + d - EPS) / vs);
      for (let m = first; m <= last; m++) {
        if (this.layerSolid(m)) {
          const moved = Math.max(0, m * vs - face);
          p[1] = p[1]! + moved;
          this.hit = true;
          return moved;
        }
      }
      p[1] = p[1]! + d;
      return d;
    }
    const face = p[1]!;
    const first = Math.floor((face + EPS) / vs) - 1;
    const last = Math.floor((face + d + EPS) / vs);
    for (let m = first; m >= last; m--) {
      if (this.layerSolid(m)) {
        const moved = Math.min(0, (m + 1) * vs - face);
        p[1] = p[1]! + moved;
        this.hit = true;
        return moved;
      }
    }
    p[1] = p[1]! + d;
    return d;
  }

  /** Lifts the body out of solid voxels (spawned inside a wall, or a world swap); gives up after ~40 m. */
  private depenetrate(): void {
    const vs = this.world.vs;
    for (let i = 0; i < 400 && this.overlaps(); i++) this.p[1] = this.p[1]! + Math.max(vs, 0.1);
  }

  /**
   * Time of impact (0..1+, Infinity = none) of the disc centre moving by (rx, rz) from (px, pz) with a solid column
   * rectangle [x0,x1] x [z0,z1]; the contact normal goes to cNx/cNz. The disc against a rectangle is a point against a
   * rounded rectangle: four sides and four corner arcs.
   */
  private rectImpact(x0: number, z0: number, x1: number, z1: number, px: number, pz: number, rx: number, rz: number): number {
    const R = RADIUS;
    const cx = px < x0 ? x0 : px > x1 ? x1 : px, cz = pz < z0 ? z0 : pz > z1 ? z1 : pz;
    const ddx = px - cx, ddz = pz - cz;
    const d2 = ddx * ddx + ddz * ddz;
    const rEps = R - EPS;
    if (d2 < rEps * rEps) {
      // already overlapping (a sub-micrometre contact after a slide, or a spawn): block only motion into the rectangle
      let nx: number, nz: number;
      const d = Math.sqrt(d2);
      if (d > 1e-9) { nx = ddx / d; nz = ddz / d; } else {
        const l = px - x0, r = x1 - px, t = pz - z0, b = z1 - pz, m = Math.min(l, r, t, b);
        if (m === l) { nx = -1; nz = 0; } else if (m === r) { nx = 1; nz = 0; } else if (m === t) { nx = 0; nz = -1; } else { nx = 0; nz = 1; }
      }
      if (rx * nx + rz * nz < -1e-9) { this.cNx = nx; this.cNz = nz; return 0; }
      return Infinity;
    }
    let best = Infinity, bnx = 0, bnz = 0;
    if (rx > 0) {
      const t = (x0 - R - px) / rx;
      if (t >= -1e-9 && t < best) { const hz = pz + rz * t; if (hz >= z0 && hz <= z1) { best = t; bnx = -1; bnz = 0; } }
    } else if (rx < 0) {
      const t = (x1 + R - px) / rx;
      if (t >= -1e-9 && t < best) { const hz = pz + rz * t; if (hz >= z0 && hz <= z1) { best = t; bnx = 1; bnz = 0; } }
    }
    if (rz > 0) {
      const t = (z0 - R - pz) / rz;
      if (t >= -1e-9 && t < best) { const hx = px + rx * t; if (hx >= x0 && hx <= x1) { best = t; bnx = 0; bnz = -1; } }
    } else if (rz < 0) {
      const t = (z1 + R - pz) / rz;
      if (t >= -1e-9 && t < best) { const hx = px + rx * t; if (hx >= x0 && hx <= x1) { best = t; bnx = 0; bnz = 1; } }
    }
    const a = rx * rx + rz * rz;
    for (let k = 0; k < 4; k++) {
      const ccx = k & 1 ? x1 : x0, ccz = k & 2 ? z1 : z0;
      const sx = k & 1 ? 1 : -1, sz = k & 2 ? 1 : -1;
      const fx = px - ccx, fz = pz - ccz;
      const b = 2 * (rx * fx + rz * fz);
      if (b >= -1e-9) continue; // moving away from, or sliding tangentially along, the corner (a hit needs a real approach)
      const disc = b * b - 4 * a * (fx * fx + fz * fz - R * R);
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t < -1e-9 || t >= best) continue;
      const hx = px + rx * t - ccx, hz = pz + rz * t - ccz;
      if (hx * sx < -1e-9 || hz * sz < -1e-9) continue; // not in this corner's quadrant: a side hit covers it
      best = t; bnx = hx / R; bnz = hz / R;
    }
    this.cNx = bnx; this.cNz = bnz;
    return best;
  }

  /** Earliest impact of moving the disc by (rx, rz) at the current height; result in bestT / bestNx / bestNz. */
  private impact(rx: number, rz: number): void {
    const vs = this.world.vs, px = this.p[0]!, pz = this.p[2]!;
    const iy0 = Math.floor((this.p[1]! + EPS) / vs), iy1 = Math.floor((this.p[1]! + HEIGHT - EPS) / vs);
    const xLo = Math.floor((Math.min(px, px + rx) - RADIUS) / vs), xHi = Math.floor((Math.max(px, px + rx) + RADIUS) / vs);
    const zLo = Math.floor((Math.min(pz, pz + rz) - RADIUS) / vs), zHi = Math.floor((Math.max(pz, pz + rz) + RADIUS) / vs);
    this.bestT = Infinity;
    for (let ix = xLo; ix <= xHi; ix++) {
      for (let iz = zLo; iz <= zHi; iz++) {
        if (!this.colSolid(ix, iz, iy0, iy1)) continue;
        const t = this.rectImpact(ix * vs, iz * vs, (ix + 1) * vs, (iz + 1) * vs, px, pz, rx, rz);
        if (t < this.bestT) { this.bestT = t; this.bestNx = this.cNx; this.bestNz = this.cNz; }
      }
    }
  }

  /**
   * Move-and-slide in the horizontal plane at the current height: advance to the first impact, remove the motion into
   * the surface, continue along it (at most 3 times). Returns the distance travelled; `this.blocked` tells whether the
   * request was cut short.
   */
  private slide(dx: number, dz: number): number {
    let rx = dx, rz = dz, total = 0;
    this.blocked = false;
    for (let it = 0; it < 3; it++) {
      const len = Math.hypot(rx, rz);
      if (len < 1e-9) break;
      this.impact(rx, rz);
      const t = this.bestT;
      if (t >= 1) {
        this.p[0] = this.p[0]! + rx; this.p[2] = this.p[2]! + rz;
        total += len;
        break;
      }
      this.blocked = true;
      const tt = t > 0 ? t : 0;
      this.p[0] = this.p[0]! + rx * tt; this.p[2] = this.p[2]! + rz * tt;
      total += len * tt;
      const rem = 1 - tt;
      let sx = rx * rem, sz = rz * rem;
      const dot = sx * this.bestNx + sz * this.bestNz;
      sx -= dot * this.bestNx; sz -= dot * this.bestNz;
      rx = sx; rz = sz;
    }
    return total;
  }

  /** Horizontal move with step-up: try at the current height; if blocked, the smallest lift <= stepUp that gains ground. */
  private moveXZ(dx: number, dz: number, canStep: boolean): void {
    if (dx === 0 && dz === 0) return;
    const x0 = this.p[0]!, y0 = this.p[1]!, z0 = this.p[2]!;
    const prog = this.slide(dx, dz);
    if (!this.blocked || !canStep) return;
    const bx = this.p[0]!, bz = this.p[2]!;
    const vs = this.world.vs, stepUp = this.stepUp;
    // smallest lifts first: feet on the next voxel boundary, then the one after, ..., finally stepUp itself
    let lift = (Math.floor((y0 + EPS) / vs) + 1) * vs - y0;
    for (let tries = 0; tries < 40; tries++) {
      const last = lift >= stepUp - 1e-9;
      const L = last ? stepUp : lift;
      this.p[0] = x0; this.p[2] = z0; this.p[1] = y0 + L;
      const pr = this.slide(dx, dz);
      if (pr > prog + 1e-6 && !this.overlaps()) {
        this.sweepY(-L); // land on whatever is now underneath
        return;
      }
      if (last) break;
      lift += vs;
    }
    this.p[0] = bx; this.p[2] = bz; this.p[1] = y0; // not climbable: keep the slid position
  }

  private groundCell(): number {
    const w = this.world, p = this.p;
    return w.cell(Math.floor(p[0]! / w.vs), Math.floor((p[1]! - 0.05) / w.vs), Math.floor(p[2]! / w.vs));
  }

  step(dt: number, inp: MoveInput): void {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    const g = GRAVITY;
    this.rescued = false;
    const wasGround = this.onGround;

    // horizontal velocity towards the wish speed
    const sp = (inp.run ? this.speeds.run : this.speeds.walk) * this.speedScale * (this.inWater ? WATER_SLOWDOWN : 1);
    const tx = inp.wishX * sp, tz = inp.wishZ * sp;
    const acc = (this.onGround ? 80 : 30) * dt;
    const ex = tx - this.vx, ez = tz - this.vz, el = Math.hypot(ex, ez);
    if (el <= acc) { this.vx = tx; this.vz = tz; } else { this.vx += (ex / el) * acc; this.vz += (ez / el) * acc; }

    let jumped = false;
    if (inp.jump && (this.onGround || this.airTime < COYOTE) && this.vy <= 0.01) {
      this.vy = this.scale.jumpSpeed;
      this.onGround = false;
      this.airTime = COYOTE; // no second jump in the air
      jumped = true;
    }

    const total = (Math.hypot(this.vx, this.vz) + Math.abs(this.vy)) * dt;
    const maxMove = Math.min(0.25, this.world.vs * 0.9);
    const n = Math.max(1, Math.min(16, Math.ceil(total / maxMove)));
    const h = dt / n;
    let grounded = false;
    for (let s = 0; s < n; s++) {
      const canStep = (wasGround || this.airTime < COYOTE) && this.vy <= 0.01 && !jumped;
      this.moveXZ(this.vx * h, this.vz * h, canStep);
      // keep glued to the ground when walking down stairs / slopes
      let snapped = false;
      if (canStep && this.vy <= 0.01) {
        const y0 = this.p[1]!;
        this.sweepY(-this.stepUp);
        if (this.hit) { snapped = true; this.vy = 0; } else this.p[1] = y0;
      }
      if (!snapped) {
        const dy = this.vy * h - 0.5 * g * h * h;
        this.vy -= g * h;
        if (this.vy < -60) this.vy = -60;
        this.sweepY(dy);
        if (this.hit) {
          if (dy < 0) snapped = true;
          this.vy = 0;
        }
      }
      grounded = snapped;
      if (grounded) this.airTime = 0; else this.airTime += h;
      this.onGround = grounded;
    }
    this.onGround = grounded;
    if (grounded) {
      this.lastSafe.set(this.p);
      const c = this.groundCell();
      this.inWater = c > 0 && (this.waterTag[c] ?? 0) === 1;
    }

    // below the world (a column without ground): back to the last standing spot
    if (this.p[1]! < this.world.min[1] * this.world.vs - 30 || !Number.isFinite(this.p[1]!)) {
      this.p.set(this.lastSafe);
      this.vx = this.vy = this.vz = 0;
      this.rescued = true;
    }
  }
}
