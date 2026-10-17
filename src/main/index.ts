import { app, BrowserWindow, session, shell } from 'electron';
import { join } from 'node:path';
import { buildCsp } from './csp';
import { registerIpc } from './ipc';
import type { PythonBridge } from './pythonBridge';

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;
let mainWindow: BrowserWindow | null = null;
let bridge: PythonBridge | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#14161a',
    title: 'VoxelWorlds',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => e.preventDefault());

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
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
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
    bridge = registerIpc(() => mainWindow);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => bridge?.dispose());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
