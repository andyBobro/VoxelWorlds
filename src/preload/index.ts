import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../shared/channels';
import type { VoxelApi } from '../shared/contract';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

/** Invoke a long job; main returns expected failures (cancel/busy) as data to avoid handler error logs. */
async function job<T>(channel: string, params: unknown): Promise<T> {
  const res = await ipcRenderer.invoke(channel, params);
  if (res && typeof res === 'object' && typeof res.__voxelError === 'string') throw new Error(res.__voxelError);
  return res as T;
}

const api: VoxelApi = {
  generate: (params) => job(CH.generate, params),
  cancel: () => ipcRenderer.invoke(CH.cancel),
  readBuildingIndex: (p) => ipcRenderer.invoke(CH.readBuildingIndex, p),
  pickPhoto: () => ipcRenderer.invoke(CH.pickPhoto),
  analyzeFacade: (params) => job(CH.analyzeFacade, params),
  detail: (params) => job(CH.detail, params),
  // Optional 3rd arg (not in the frozen VoxelApi type): the .vwg to export; default = the current one.
  exportAs: (format, suggestedName, vwgPath?: string) => ipcRenderer.invoke(CH.exportAs, format, suggestedName, vwgPath),
  readVwg: (vwgPath) => ipcRenderer.invoke(CH.readVwg, vwgPath),
  onProgress: (cb) => subscribe(CH.progress, cb),
  onWarning: (cb) => subscribe(CH.warning, cb),
  onLog: (cb) => subscribe(CH.log, cb),
};

contextBridge.exposeInMainWorld('voxel', api);
