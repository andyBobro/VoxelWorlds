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

/**
 * Invoke a main handler. Main returns failures as data ({ __voxelError: 'CODE: message' }) so the renderer sees a clean
 * `CODE: message` error instead of Electron's "Error invoking remote method" wrapper and no handler error is logged.
 */
async function job<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && typeof res === 'object' && typeof res.__voxelError === 'string') throw new Error(res.__voxelError);
  return res as T;
}

const api: VoxelApi = {
  generate: (params) => job(CH.generate, params),
  cancel: () => job(CH.cancel),
  readBuildingIndex: (p) => job(CH.readBuildingIndex, p),
  pickPhoto: () => job(CH.pickPhoto),
  analyzeFacade: (params) => job(CH.analyzeFacade, params),
  detail: (params) => job(CH.detail, params),
  listWorlds: () => job(CH.listWorlds),
  openWorld: (id) => job(CH.openWorld, id),
  renameWorld: (id, name) => job(CH.renameWorld, id, name),
  deleteWorld: (id) => job(CH.deleteWorld, id),
  listDetails: (worldId) => job(CH.listDetails, worldId),
  openDetail: (worldId, detailId) => job(CH.openDetail, worldId, detailId),
  deleteDetail: (worldId, detailId) => job(CH.deleteDetail, worldId, detailId),
  onWorldSaved: (cb) => subscribe(CH.worldSaved, cb),
  listGeodataRegions: (opts) => job(CH.listGeodataRegions, opts),
  suggestGeodataRegions: (bbox) => job(CH.suggestGeodataRegions, bbox),
  listGeodata: () => job(CH.listGeodata),
  downloadGeodata: (regionId) => job(CH.downloadGeodata, regionId),
  cancelGeodataDownload: (regionId) => job(CH.cancelGeodataDownload, regionId),
  deleteGeodata: (regionId) => job(CH.deleteGeodata, regionId),
  onGeodataProgress: (cb) => subscribe(CH.geodataProgress, cb),
  // Optional 3rd arg (not in the frozen VoxelApi type): the .vwg to export; default = the current one.
  exportAs: (format, suggestedName, vwgPath?: string) => job(CH.exportAs, format, suggestedName, vwgPath),
  readVwg: (vwgPath) => job(CH.readVwg, vwgPath),
  onProgress: (cb) => subscribe(CH.progress, cb),
  onWarning: (cb) => subscribe(CH.warning, cb),
  onLog: (cb) => subscribe(CH.log, cb),
};

contextBridge.exposeInMainWorld('voxel', api);
