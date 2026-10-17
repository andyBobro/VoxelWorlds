import * as THREE from 'three';
import type { BuildingInfo } from '../../shared/contract';
import { buildMarkerGeometry } from './markerGeometry';

const COLOUR = 0x2ee6a6;

/** Overlay for buildings with saved details: one LineSegments + one Points (2 draw calls for any count). Never touches chunk meshes. */
export class Markers {
  readonly group = new THREE.Group();
  count = 0;
  private lines: THREE.LineSegments | null = null;
  private points: THREE.Points | null = null;

  private disc: THREE.CanvasTexture | null = null;

  constructor(private readonly vs: number) {
    this.group.visible = false;
  }

  /** Created on first non-empty set() and reused for the lifetime of this overlay. */
  private discTexture(): THREE.CanvasTexture {
    if (this.disc) return this.disc;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    g.beginPath(); g.arc(16, 16, 14, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
    this.disc = new THREE.CanvasTexture(c);
    return this.disc;
  }

  set(buildings: readonly BuildingInfo[]): void {
    this.clear();
    const g = buildMarkerGeometry(buildings, this.vs);
    this.count = g.count;
    if (!g.count) return;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(g.lines, 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: COLOUR, fog: false }));
    this.lines.renderOrder = 9;
    this.lines.frustumCulled = false;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(g.pins, 3));
    this.points = new THREE.Points(pg, new THREE.PointsMaterial({ color: COLOUR, size: 12, sizeAttenuation: false, depthTest: false, map: this.discTexture(), alphaTest: 0.5, fog: false }));
    this.points.renderOrder = 9;
    this.points.frustumCulled = false;
    this.group.add(this.lines, this.points);
  }

  private clear(): void {
    for (const o of [this.lines, this.points]) {
      if (!o) continue;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.lines = this.points = null;
    this.group.clear();
    this.count = 0;
  }

  dispose(): void {
    this.clear();
    this.disc?.dispose();
    this.disc = null;
  }
}
