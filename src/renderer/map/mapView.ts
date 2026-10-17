import 'leaflet/dist/leaflet.css';
import { L } from './leafletSetup';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';
import type { BBox } from '../../shared/contract';

export class MapView {
  private map: L.Map;
  private drawn = new L.FeatureGroup();
  private bbox: BBox | null = null;
  private pendingFit: BBox | null = null;

  constructor(private readonly el: HTMLElement, private onChange: (bbox: BBox | null) => void) {
    this.map = L.map(el, { zoomControl: true }).setView([48.8566, 2.3522], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(this.map);
    this.map.addLayer(this.drawn);

    this.map.addControl(
      new L.Control.Draw({
        position: 'topleft',
        draw: {
          rectangle: { showArea: false, shapeOptions: { color: '#ff1744', weight: 3, opacity: 1, fillColor: '#ff1744', fillOpacity: 0.15 } },
          polygon: false,
          polyline: false,
          circle: false,
          marker: false,
          circlemarker: false,
        },
        edit: { featureGroup: this.drawn, remove: true },
      }),
    );

    this.map.on(L.Draw.Event.CREATED, (e) => {
      const ev = e as L.DrawEvents.Created;
      this.drawn.clearLayers(); // one rectangle at a time
      this.drawn.addLayer(ev.layer);
      this.update();
    });
    if (import.meta.env.DEV) {
      // dev-only automation hook (screenshot scripts): draw a bbox without mouse input
      (window as unknown as Record<string, unknown>).__vwSetBBox = (b: BBox) => {
        this.drawn.clearLayers();
        this.drawn.addLayer(L.rectangle([[b.latMin, b.lonMin], [b.latMax, b.lonMax]]));
        this.map.fitBounds([[b.latMin, b.lonMin], [b.latMax, b.lonMax]], { maxZoom: 19 });
        this.update();
      };
    }
    this.map.on(L.Draw.Event.EDITED, () => this.update());
    this.map.on(L.Draw.Event.DELETED, () => this.update());
  }

  private update(): void {
    const layers = this.drawn.getLayers() as L.Rectangle[];
    const first = layers[0];
    if (!first) {
      this.bbox = null;
    } else {
      const b = first.getBounds();
      this.bbox = { latMin: b.getSouth(), lonMin: b.getWest(), latMax: b.getNorth(), lonMax: b.getEast() };
    }
    this.onChange(this.bbox);
  }

  /** Draw/replace the rectangle (e.g. from a saved world's params) and zoom to it once the map is visible. */
  setBBox(b: BBox): void {
    this.drawn.clearLayers();
    this.drawn.addLayer(L.rectangle([[b.latMin, b.lonMin], [b.latMax, b.lonMax]], { color: '#ff1744', weight: 3, opacity: 1, fillColor: '#ff1744', fillOpacity: 0.15 }));
    this.pendingFit = b;
    if (this.el.offsetParent !== null) this.refresh();
    this.update();
  }

  getBBox(): BBox | null {
    return this.bbox;
  }

  /** Call when the map tab becomes visible. */
  refresh(): void {
    this.map.invalidateSize();
    const b = this.pendingFit;
    if (b) {
      this.pendingFit = null;
      this.map.fitBounds([[b.latMin, b.lonMin], [b.latMax, b.lonMax]], { maxZoom: 18, animate: false });
    }
  }
}
