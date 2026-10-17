import type { VoxelApi } from '../shared/contract';

declare global {
  interface Window {
    voxel: VoxelApi;
  }
}
export {};
