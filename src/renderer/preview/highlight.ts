import * as THREE from 'three';

export interface HighlightSpec {
  footprint: ReadonlyArray<readonly [number, number]>;
  baseY: number;
  topY: number;
  /** wall edge index to emphasise, or -1 */
  edge: number;
}

/** Overlay group (outline + translucent roof tint + selected wall quad). Never touches chunk meshes. */
export class Highlight {
  readonly group = new THREE.Group();
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(private readonly vs: number) {
    this.group.renderOrder = 10;
    this.group.visible = false;
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.disposables.push(m);
    return m;
  }

  set(h: HighlightSpec | null): void {
    this.clear();
    if (!h || h.footprint.length < 3) return;
    const vs = this.vs, n = h.footprint.length;
    const y0 = h.baseY * vs, y1 = h.topY * vs;
    const pts: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = h.footprint[i]!, b = h.footprint[(i + 1) % n]!;
      pts.push(a[0] * vs, y1, a[1] * vs, b[0] * vs, y1, b[1] * vs); // roof loop
      pts.push(a[0] * vs, y0, a[1] * vs, b[0] * vs, y0, b[1] * vs); // base loop
      pts.push(a[0] * vs, y0, a[1] * vs, a[0] * vs, y1, a[1] * vs); // vertical
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.disposables.push(lg);
    const lines = new THREE.LineSegments(lg, this.mat(new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true, fog: false })));
    lines.renderOrder = 11;
    lines.frustumCulled = false;

    const shape = new THREE.Shape(h.footprint.map(([x, z]) => new THREE.Vector2(x * vs, z * vs)));
    const cg = new THREE.ShapeGeometry(shape);
    cg.rotateX(Math.PI / 2); // (x, y) -> (x, 0, y)
    cg.translate(0, y1 + vs * 0.05, 0);
    this.disposables.push(cg);
    const cap = new THREE.Mesh(cg, this.mat(new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false, fog: false })));
    cap.renderOrder = 10;
    cap.frustumCulled = false;
    this.group.add(cap, lines);

    if (h.edge >= 0 && h.edge < n) {
      const a = h.footprint[h.edge]!, b = h.footprint[(h.edge + 1) % n]!;
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute([
        a[0] * vs, y0, a[1] * vs, b[0] * vs, y0, b[1] * vs, b[0] * vs, y1, b[1] * vs, a[0] * vs, y1, a[1] * vs,
      ], 3));
      eg.setIndex([0, 1, 2, 0, 2, 3]);
      this.disposables.push(eg);
      const quad = new THREE.Mesh(eg, this.mat(new THREE.MeshBasicMaterial({ color: 0xff5a1f, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, depthTest: false, fog: false })));
      quad.renderOrder = 12;
      quad.frustumCulled = false;
      this.group.add(quad);
    }
    this.group.visible = true;
  }

  private clear(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
    this.group.visible = false;
  }

  dispose(): void {
    this.clear();
  }
}
