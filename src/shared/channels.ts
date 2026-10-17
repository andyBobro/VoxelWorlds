/** IPC channel names shared by main and preload. */
export const CH = {
  generate: 'voxel:generate',
  cancel: 'voxel:cancel',
  exportAs: 'voxel:export',
  readVwg: 'voxel:readVwg',
  readBuildingIndex: 'voxel:readBuildingIndex',
  pickPhoto: 'voxel:pickPhoto',
  analyzeFacade: 'voxel:analyzeFacade',
  detail: 'voxel:detail',
  progress: 'voxel:progress',
  warning: 'voxel:warning',
  log: 'voxel:log',
} as const;
