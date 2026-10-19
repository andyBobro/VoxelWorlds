/** Pure permission policy (no electron import, unit-tested). Everything is denied unless listed here. */
export interface PermissionQuery {
  permission: string;
  /** webContents asking */
  wcId: number;
  /** main window's webContents id (undefined when closed) */
  mainWcId: number | undefined;
  isWalkSender: boolean;
  /** requesting URL / origin as reported by Electron */
  url: string | undefined;
  /** the dev server URL (ELECTRON_RENDERER_URL) when running unpackaged */
  devUrl?: string;
  /** false for sub-frames; undefined is treated as main frame */
  isMainFrame?: boolean;
}

/** Is `url` one of our own pages: a file:// page of the app, or the dev server origin. */
export function isOwnOrigin(url: string | undefined, devUrl?: string): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'file:') return true;
  if (devUrl) {
    try {
      return u.origin !== 'null' && u.origin === new URL(devUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}

export function decidePermission(q: PermissionQuery): boolean {
  if (q.isMainFrame === false) return false;
  if (q.permission === 'geolocation') {
    // only the main window (the map lives there), only our own pages; never the walk window
    return q.mainWcId !== undefined && q.wcId === q.mainWcId && !q.isWalkSender && isOwnOrigin(q.url, q.devUrl);
  }
  // the walking window (first-person view): mouse look and fullscreen
  if (q.permission === 'pointerLock' || q.permission === 'fullscreen') return q.isWalkSender;
  return false;
}
