/** Pure helpers for the "Show my location" map button. */

export const LOCATE_OPTIONS_FAST: PositionOptions = { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 };
export const LOCATE_MIN_ZOOM = 16;

export type OsKind = 'mac' | 'win' | 'other';

export function detectOs(platform: string): OsKind {
  if (/mac|iphone|ipad/i.test(platform)) return 'mac';
  if (/win/i.test(platform)) return 'win';
  return 'other';
}

/** A short human message for a GeolocationPositionError-like value. */
export function locateErrorMessage(err: { code?: number; message?: string } | null | undefined, os: OsKind = 'other'): string {
  switch (err?.code) {
    case 1: {
      const where =
        os === 'mac' ? 'System Settings > Privacy & Security > Location Services'
        : os === 'win' ? 'Settings > Privacy & security > Location'
        : 'your system location settings';
      return `Location permission was denied. Allow location for VoxelWorlds in ${where}, then try again.`;
    }
    case 2: {
      // Chromium on Linux / unpackaged Electron has no Google API key: its network provider answers with an error
      const noProvider = /network location provider|api key|403|google/i.test(err.message ?? '');
      return noProvider
        ? 'Location is not available on this computer (no location provider; this build has no network location service).'
        : 'Location is not available on this computer.';
    }
    case 3:
      return 'Finding your location took too long. Check your connection and try again.';
    default:
      return 'Could not get your location.';
  }
}

/** Zoom to use after a fix: at least 16, never zoom out from a closer view. */
export function locateZoom(current: number, maxZoom = 19): number {
  return Math.min(maxZoom, Math.max(LOCATE_MIN_ZOOM, current));
}
