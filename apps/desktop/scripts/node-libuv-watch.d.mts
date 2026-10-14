export interface FixedNodeRelease {
  version: string;
  date: string;
  uv: string;
  lts: string | false;
}

export const MIN_FIXED_LIBUV: string;
export function compareVersions(a: string, b: string): number;
export function findFixedReleases(index: unknown, minLibuv?: string): FixedNodeRelease[];
