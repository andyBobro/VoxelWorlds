import { describe, expect, it } from 'vitest';
import { decidePermission, isOwnOrigin, type PermissionQuery } from '../src/main/permissions';
import { detectOs, locateErrorMessage, locateZoom } from '../src/renderer/map/locate';

const q = (o: Partial<PermissionQuery> = {}): PermissionQuery => ({
  permission: 'geolocation', wcId: 1, mainWcId: 1, isWalkSender: false, url: 'file:///app/out/renderer/index.html', ...o,
});

describe('permission policy', () => {
  it('allows geolocation for the main window on file://', () => expect(decidePermission(q())).toBe(true));
  it('allows geolocation for the main window on the dev server origin', () =>
    expect(decidePermission(q({ url: 'http://localhost:5173/', devUrl: 'http://localhost:5173/' }))).toBe(true));
  it('denies geolocation for the walk window', () =>
    expect(decidePermission(q({ wcId: 2, isWalkSender: true }))).toBe(false));
  it('denies geolocation for an unknown webContents or when the main window is gone', () => {
    expect(decidePermission(q({ wcId: 9 }))).toBe(false);
    expect(decidePermission(q({ mainWcId: undefined }))).toBe(false);
  });
  it('denies geolocation from a foreign origin or sub-frame', () => {
    expect(decidePermission(q({ url: 'https://evil.example/' }))).toBe(false);
    expect(decidePermission(q({ url: 'http://localhost:5173/', devUrl: undefined }))).toBe(false);
    expect(decidePermission(q({ url: 'http://localhost:9999/', devUrl: 'http://localhost:5173/' }))).toBe(false);
    expect(decidePermission(q({ url: undefined }))).toBe(false);
    expect(decidePermission(q({ isMainFrame: false }))).toBe(false);
  });
  it('walk window keeps pointerLock/fullscreen only', () => {
    for (const p of ['pointerLock', 'fullscreen']) {
      expect(decidePermission(q({ permission: p, wcId: 2, isWalkSender: true }))).toBe(true);
      expect(decidePermission(q({ permission: p }))).toBe(false);
    }
  });
  it('denies everything else', () => {
    for (const p of ['media', 'notifications', 'clipboard-read', 'openExternal', 'midi'])
      for (const walk of [true, false]) expect(decidePermission(q({ permission: p, isWalkSender: walk }))).toBe(false);
  });
  it('isOwnOrigin rejects garbage', () => expect(isOwnOrigin('not a url')).toBe(false));
});

describe('locate messages', () => {
  it('permission denied explains the OS setting', () => {
    expect(locateErrorMessage({ code: 1 }, 'mac')).toContain('Privacy & Security > Location Services');
    expect(locateErrorMessage({ code: 1 }, 'win')).toContain('Privacy & security > Location');
  });
  it('unavailable / timeout / unknown', () => {
    expect(locateErrorMessage({ code: 2 })).toBe('Location is not available on this computer.');
    expect(locateErrorMessage({ code: 2, message: 'Network location provider returned error code 403' })).toContain('no location provider');
    expect(locateErrorMessage({ code: 3 })).toContain('too long');
    expect(locateErrorMessage(undefined)).toBe('Could not get your location.');
  });
  it('detectOs and zoom', () => {
    expect(detectOs('MacIntel')).toBe('mac');
    expect(detectOs('Win32')).toBe('win');
    expect(detectOs('Linux x86_64')).toBe('other');
    expect(locateZoom(10)).toBe(16);
    expect(locateZoom(18)).toBe(18);
    expect(locateZoom(18, 17)).toBe(17);
  });
});
