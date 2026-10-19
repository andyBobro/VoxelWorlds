import { app, BrowserWindow, session, shell } from 'electron';
import { join } from 'node:path';
import { buildCsp } from './csp';
import { decidePermission } from './permissions';
import type { WalkSession } from '../shared/contract';
import { registerIpc, type IpcHandle } from './ipc';
import type { WalkWindowHandle } from './walk';
import type { PythonBridge } from './pythonBridge';

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;
let mainWindow: BrowserWindow | null = null;
let bridge: PythonBridge | null = null;
let ipc: IpcHandle | null = null;

const webPreferences = (): Electron.WebPreferences => ({
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
});

/** Same navigation lockdown for every window. */
function lockdown(wc: Electron.WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => e.preventDefault());
}

/**
 * The walking window: modal child of the main window, same hardening, second renderer page (walk.html).
 * `onGone` fires once for X / Alt+F4 / endWalk / renderer crash / load failure.
 */
function openWalkWindow(session: WalkSession, onGone: (reason: string) => void): WalkWindowHandle {
  const parent = mainWindow;
  if (!parent || parent.isDestroyed()) throw new Error('INTERNAL: the main window is not available');
  // macOS shows a modal child as a fixed-size sheet (no resize, no fullscreen); there the main window is locked by its UI overlay
  // and by main-side rejections instead, and the walking window is a normal child that stays above it.
  const sheet = process.platform === 'darwin' ? false : true;
  const win = new BrowserWindow({
    parent,
    modal: sheet,
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    resizable: true,
    fullscreenable: true,
    backgroundColor: '#14161a',
    title: 'VoxelWorlds — Walking',
    autoHideMenuBar: true,
    show: false,
    webPreferences: webPreferences(),
  });
  const wc = win.webContents;
  const id = wc.id; // read now: gone after destroy
  let gone = false;
  const finish = (reason: string): void => {
    if (gone) return;
    gone = true;
    onGone(reason);
  };
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => finish('closed'));
  wc.on('render-process-gone', (_e, d) => finish(`render-process-gone: ${d.reason}`));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) finish(`load failed: ${desc} (${url})`);
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });
  lockdown(wc);
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(new URL('walk.html', process.env.ELECTRON_RENDERER_URL.replace(/\/?$/, '/')).toString());
  } else {
    void win.loadFile(join(__dirname, '../renderer/walk.html'));
  }
  return {
    id,
    focus: () => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    },
    close: () => {
      if (!win.isDestroyed()) win.close();
    },
    send: (channel, payload) => {
      if (!win.isDestroyed() && !wc.isDestroyed()) wc.send(channel, payload);
    },
    destroy: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#14161a',
    title: 'VoxelWorlds',
    show: false,
    webPreferences: webPreferences(),
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', () => ipc?.endWalk('main window closing'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  lockdown(mainWindow.webContents);

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    const ses = session.defaultSession;
    // Everything denied, except: mouse look + fullscreen for the walking window, and geolocation ("Locate me" on the map)
    // for the main window only. Position comes from the OS location provider; there is no IP-geolocation fallback.
    const decide = (wc: Electron.WebContents | null, permission: string, url: string | undefined, isMainFrame?: boolean): boolean =>
      !!wc && decidePermission({
        permission, wcId: wc.id, mainWcId: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : undefined,
        isWalkSender: !!ipc?.isWalkSender(wc.id), url, devUrl: isDev ? process.env.ELECTRON_RENDERER_URL : undefined, isMainFrame,
      });
    ses.setPermissionRequestHandler((wc, perm, cb, details) => {
      cb(decide(wc, perm, details.requestingUrl, details.isMainFrame));
    });
    ses.setPermissionCheckHandler((wc, perm, origin, details) => decide(wc, perm, details.requestingUrl || origin, details.isMainFrame));
    ses.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [buildCsp({ dev: isDev })] } });
    });
    // OSM tile policy requires an identifying User-Agent; file:// pages send no Referer.
    ses.webRequest.onBeforeSendHeaders(
      { urls: ['https://tile.openstreetmap.org/*', 'https://*.tile.openstreetmap.org/*'] },
      (details, cb) => {
        const h = details.requestHeaders;
        h['Referer'] = 'https://voxelworlds.app/';
        h['User-Agent'] = `VoxelWorlds/${app.getVersion()}`;
        cb({ requestHeaders: h });
      },
    );
    ipc = registerIpc(() => mainWindow, openWalkWindow);
    bridge = ipc.bridge;
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    ipc?.endWalk('quit'); // releases the job slot / cancels a running detail before python is killed
    bridge?.dispose();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
