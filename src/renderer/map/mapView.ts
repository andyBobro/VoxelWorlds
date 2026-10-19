import 'leaflet/dist/leaflet.css';
import { L } from './leafletSetup';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';
import type { BBox } from '../../shared/contract';
import { toast } from '../ui/toast';
import { detectOs, locateErrorMessage, locateZoom, LOCATE_OPTIONS_FAST } from './locate';

export class MapView {
  private map: L.Map;
  private drawn = new L.FeatureGroup();
  private bbox: BBox | null = null;
  private pendingFit: BBox | null = null;
  private drawControl: L.Control.Draw | null = null;
  private locked = false;
  private locating = false;
  private locateBtn: HTMLAnchorElement | null = null;
  private locateLayer: L.LayerGroup | null = null;

  constructor(private readonly el: HTMLElement, private onChange: (bbox: BBox | null) => void) {
    this.map = L.map(el, { zoomControl: true }).setView([48.8566, 2.3522], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(this.map);
    this.map.addLayer(this.drawn);

    this.drawControl = new L.Control.Draw({
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
    });
    this.map.addControl(this.drawControl);
    this.addLocateControl();

    this.map.on(L.Draw.Event.CREATED, (e) => {
      if (this.locked) return; // defence in depth: nothing may change the rectangle while the walking view is open
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

  /** "Show my location" button under the zoom/draw controls. Not part of the bbox/generate logic. */
  private addLocateControl(): void {
    const view = this;
    const Locate = L.Control.extend({
      onAdd(): HTMLElement {
        const bar = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-locate');
        const a = L.DomUtil.create('a', 'locate-btn', bar) as HTMLAnchorElement;
        a.href = '#';
        a.title = 'Show my location';
        a.setAttribute('role', 'button');
        a.setAttribute('aria-label', 'Show my location');
        a.innerHTML =
          '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/>' +
          '<circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 1v5M12 18v5M1 12h5M18 12h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        L.DomEvent.disableClickPropagation(bar); // a click here must not reach the map / draw handlers
        L.DomEvent.disableScrollPropagation(bar);
        L.DomEvent.on(a, 'click', (e) => {
          L.DomEvent.preventDefault(e);
          view.locate();
        });
        view.locateBtn = a;
        return bar;
      },
    });
    this.map.addControl(new Locate({ position: 'topleft' }));
  }

  private setLocateState(state: 'idle' | 'locating' | 'success' | 'error'): void {
    const a = this.locateBtn;
    if (!a) return;
    a.dataset.state = state;
    a.classList.toggle('locating', state === 'locating');
    const off = this.locked || state === 'locating';
    a.classList.toggle('leaflet-disabled', off);
    a.setAttribute('aria-disabled', String(off));
  }

  /** Ask the OS for the position once and show it. Re-clicking re-locates. */
  private locate(): void {
    if (this.locked || this.locating) return;
    if (!('geolocation' in navigator)) {
      toast(locateErrorMessage({ code: 2 }), 'warn', 7000);
      return;
    }
    this.locating = true;
    this.setLocateState('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.locating = false;
        if (this.locked) return this.setLocateState('idle'); // a walk opened meanwhile: leave the map alone
        const { latitude, longitude, accuracy } = pos.coords;
        this.showLocation(latitude, longitude, accuracy);
        this.setLocateState('success');
      },
      (err) => {
        this.locating = false;
        this.setLocateState('error');
        toast(locateErrorMessage(err, detectOs(navigator.platform)), err.code === 3 ? 'warn' : 'err', 9000);
      },
      LOCATE_OPTIONS_FAST,
    );
  }

  private showLocation(lat: number, lon: number, accuracy: number): void {
    this.locateLayer?.remove();
    const ll = L.latLng(lat, lon);
    // non-interactive: neither the dot nor the circle can be dragged/edited or swallow clicks that draw the rectangle
    const circle = L.circle(ll, { radius: Math.max(accuracy, 1), interactive: false, color: '#1a73e8', weight: 1, opacity: 0.5, fillColor: '#1a73e8', fillOpacity: 0.15 });
    const dot = L.marker(ll, {
      interactive: false, keyboard: false, draggable: false,
      icon: L.divIcon({ className: 'locate-dot-wrap', html: '<div class="locate-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    });
    this.locateLayer = L.layerGroup([circle, dot]).addTo(this.map);
    this.map.flyTo(ll, locateZoom(this.map.getZoom(), this.map.getMaxZoom()), { duration: 1.2 });
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

  /**
   * Walking view open: abort any draw/edit/delete mode in progress (edits are reverted, not saved) and switch off
   * every map interaction. The main window is also `inert`, this is the belt to those braces.
   */
  setLocked(v: boolean): void {
    if (v === this.locked) return;
    this.locked = v;
    const m = this.map;
    if (v) {
      type Mode = { handler: { disable(): void; revertLayers?(): void } };
      const toolbars = (this.drawControl as unknown as { _toolbars?: Record<string, { _activeMode?: Mode | null }> } | null)?._toolbars ?? {};
      for (const tb of Object.values(toolbars)) {
        const mode = tb._activeMode;
        if (!mode) continue;
        try {
          mode.handler.revertLayers?.();
          mode.handler.disable();
        } catch { /* best effort */ }
      }
    }
    const handlers = [m.dragging, m.scrollWheelZoom, m.doubleClickZoom, m.boxZoom, m.keyboard, m.touchZoom];
    for (const hd of handlers) {
      if (!hd) continue;
      if (v) hd.disable();
      else hd.enable();
    }
    m.getContainer().classList.toggle('map-locked', v);
    this.setLocateState(this.locating ? 'locating' : 'idle');
    if (!v) this.update(); // the rectangle is unchanged, but make the form re-read it
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
