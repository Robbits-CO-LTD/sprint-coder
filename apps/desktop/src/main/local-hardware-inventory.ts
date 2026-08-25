import { arch, cpus, freemem, platform, totalmem } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { localHardwareSnapshotSchema, type LocalHardwareSnapshot } from '@sprint-coder/contracts';

type Platform = LocalHardwareSnapshot['platform'];
type Backend = LocalHardwareSnapshot['backends'][number];
type Gpu = LocalHardwareSnapshot['gpus'][number];
type GpuMemory = Gpu['memory'];

export type LocalGpuMemoryObservation = Readonly<{
  vendorId: number | null;
  deviceId: number | null;
  memory: GpuMemory;
}>;

export type LocalHardwareInventoryDependencies = Readonly<{
  now?: () => Date;
  platform?: () => NodeJS.Platform;
  architecture?: () => string;
  totalMemory?: () => number;
  freeMemory?: () => number;
  availableMemory?: () => Promise<number | null>;
  cpuInfo?: () => ReadonlyArray<Readonly<{ model: string }>>;
  gpuInfo?: () => Promise<unknown>;
  cpuFeatures?: () => Promise<readonly string[] | null>;
  gpuMemory?: () => Promise<readonly LocalGpuMemoryObservation[] | null>;
  backends?: () => Promise<readonly Backend[] | null>;
}>;

const EMPTY_GPU_MEMORY: GpuMemory = {
  dedicatedTotalBytes: null,
  dedicatedAvailableBytes: null,
  sharedTotalBytes: null,
  unifiedTotalBytes: null,
};
const execFileAsync = promisify(execFile);

export function parseDarwinAvailableMemory(input: string): number | null {
  const pageSize = /page size of (\d+) bytes/u.exec(input)?.[1];
  if (pageSize === undefined) return null;
  const size = Number(pageSize);
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  let pages = 0;
  for (const label of ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable']) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const value = new RegExp(`^${escaped}:\\s+(\\d+)\\.?$`, 'mu').exec(input)?.[1];
    if (value === undefined) return null;
    pages += Number(value);
  }
  const bytes = pages * size;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

export async function collectDarwinAvailableMemory(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/vm_stat', [], {
      timeout: 2_000,
      maxBuffer: 64 * 1_024,
      encoding: 'utf8',
      windowsHide: true,
    });
    return parseDarwinAvailableMemory(stdout);
  } catch {
    return null;
  }
}

export async function collectLocalAvailableMemoryBytes(): Promise<number> {
  if (platform() !== 'darwin') return freemem();
  return (await collectDarwinAvailableMemory()) ?? freemem();
}

function normalizePlatform(value: NodeJS.Platform): Platform {
  return value === 'darwin' || value === 'win32' || value === 'linux' ? value : 'other';
}

function finiteBytes(read: () => number): number | null {
  try {
    const value = read();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, maxLength) : null;
}

function optionalUint32(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff
    ? Number(value)
    : null;
}

function parseGpuDevices(value: unknown): Gpu[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const devices = (value as { gpuDevice?: unknown }).gpuDevice;
  if (!Array.isArray(devices)) return null;
  return devices.slice(0, 16).flatMap((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null) return [];
    const item = candidate as Record<string, unknown>;
    const vendorId = optionalUint32(item['vendorId']);
    const deviceId = optionalUint32(item['deviceId']);
    const vendorName = optionalString(item['vendorString'], 128);
    const deviceName = optionalString(item['deviceString'], 256);
    if (vendorId === null && deviceId === null && vendorName === null && deviceName === null)
      return [];
    return [
      {
        id: `gpu-${index}-${vendorId ?? 'unknown'}-${deviceId ?? 'unknown'}`,
        active: typeof item['active'] === 'boolean' ? item['active'] : null,
        vendorId,
        deviceId,
        vendorName,
        deviceName,
        memory: EMPTY_GPU_MEMORY,
      },
    ];
  });
}

function joinGpuMemory(
  gpus: readonly Gpu[],
  observations: readonly LocalGpuMemoryObservation[],
): Gpu[] {
  return gpus.map((gpu) => {
    const memory = observations.find(
      (candidate) =>
        candidate.vendorId === gpu.vendorId &&
        candidate.deviceId === gpu.deviceId &&
        (candidate.vendorId !== null || candidate.deviceId !== null),
    )?.memory;
    return memory === undefined ? gpu : { ...gpu, memory };
  });
}

async function defaultGpuInfo(): Promise<unknown> {
  const { app } = await import('electron');
  return app.getGPUInfo('complete');
}

async function optionalProbe<T>(probe: (() => Promise<T>) | undefined): Promise<T | null> {
  if (probe === undefined) return null;
  try {
    return await probe();
  } catch {
    return null;
  }
}

/**
 * Collects only bounded, documented host facts. Missing native probes remain explicit unknowns;
 * GPU names, memory sizes, and backend readiness are never inferred from vendor IDs.
 */
export async function collectLocalHardwareSnapshot(
  dependencies: LocalHardwareInventoryDependencies = {},
): Promise<LocalHardwareSnapshot> {
  const hostPlatform = normalizePlatform((dependencies.platform ?? platform)());
  const architecture = (dependencies.architecture ?? arch)().slice(0, 32) || 'unknown';
  const totalBytes = finiteBytes(dependencies.totalMemory ?? totalmem);
  const fallbackAvailableBytes = finiteBytes(dependencies.freeMemory ?? freemem);
  const probedAvailableBytes =
    hostPlatform === 'darwin' &&
    dependencies.platform === undefined &&
    dependencies.freeMemory === undefined
      ? await (dependencies.availableMemory ?? collectDarwinAvailableMemory)()
      : dependencies.availableMemory === undefined
        ? null
        : await optionalProbe(dependencies.availableMemory);
  const availableBytes = probedAvailableBytes ?? fallbackAvailableBytes;
  const cpuEntries = (() => {
    try {
      return (dependencies.cpuInfo ?? cpus)();
    } catch {
      return [];
    }
  })();
  const cpuModel = optionalString(cpuEntries[0]?.model, 256);
  const logicalCores =
    cpuEntries.length > 0 && cpuEntries.length <= 4_096 ? cpuEntries.length : null;

  const rawGpuInfo = await optionalProbe(dependencies.gpuInfo ?? defaultGpuInfo);
  let gpus = rawGpuInfo === null ? null : parseGpuDevices(rawGpuInfo);
  const gpuMemory = await optionalProbe(dependencies.gpuMemory);
  if (gpus !== null && gpuMemory !== null) gpus = joinGpuMemory(gpus, gpuMemory);

  const rawFeatures = await optionalProbe(dependencies.cpuFeatures);
  const features =
    rawFeatures
      ?.map((feature) => feature.trim().toLowerCase())
      .filter((feature) => /^[a-z0-9._-]{1,32}$/.test(feature))
      .filter((feature, index, all) => all.indexOf(feature) === index)
      .slice(0, 64) ?? [];
  const backendProbe = await optionalProbe(dependencies.backends);
  const backends = backendProbe === null ? [] : [...backendProbe].slice(0, 4);

  const unified = hostPlatform === 'darwin' && architecture === 'arm64';
  if (unified && gpus !== null && totalBytes !== null) {
    gpus = gpus.map((gpu) => ({
      ...gpu,
      memory: { ...gpu.memory, unifiedTotalBytes: totalBytes },
    }));
  }
  const boundedAvailableBytes =
    totalBytes !== null && availableBytes !== null && availableBytes > totalBytes
      ? null
      : availableBytes;

  const unknownComponents: LocalHardwareSnapshot['unknownComponents'] = [];
  if (totalBytes === null || boundedAvailableBytes === null)
    unknownComponents.push('system_memory');
  if (cpuModel === null || logicalCores === null) unknownComponents.push('cpu_identity');
  if (rawFeatures === null) unknownComponents.push('cpu_features');
  if (gpus === null) unknownComponents.push('gpu_devices');
  if (
    gpus === null ||
    gpus.some((gpu) =>
      unified
        ? gpu.memory.unifiedTotalBytes === null
        : gpu.memory.dedicatedTotalBytes === null ||
          gpu.memory.dedicatedAvailableBytes === null ||
          (hostPlatform === 'win32' && gpu.memory.sharedTotalBytes === null),
    )
  )
    unknownComponents.push('gpu_memory');
  if (backendProbe === null) unknownComponents.push('backend_availability');

  const hasCapacityFacts =
    totalBytes !== null || boundedAvailableBytes !== null || cpuModel !== null || gpus !== null;
  return localHardwareSnapshotSchema.parse({
    version: 1,
    status: !hasCapacityFacts ? 'unknown' : unknownComponents.length === 0 ? 'complete' : 'partial',
    observedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    platform: hostPlatform,
    architecture,
    memory: {
      totalBytes,
      availableBytes: boundedAvailableBytes,
      topology: unified ? 'unified' : gpus !== null && gpus.length > 0 ? 'discrete' : 'unknown',
    },
    cpu: {
      model: cpuModel,
      logicalCores,
      features,
      featuresStatus: rawFeatures === null ? 'unknown' : 'known',
    },
    gpuDevicesStatus: gpus === null ? 'unknown' : 'known',
    gpus: gpus ?? [],
    backends,
    unknownComponents,
  });
}
