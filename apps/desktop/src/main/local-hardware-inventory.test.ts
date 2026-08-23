import { describe, expect, it } from 'vitest';
import { collectLocalHardwareSnapshot } from './local-hardware-inventory';

const GiB = 2 ** 30;

describe('local hardware inventory', () => {
  it('represents Apple Silicon memory as unified without calling it VRAM', async () => {
    const snapshot = await collectLocalHardwareSnapshot({
      now: () => new Date('2026-08-23T00:00:00.000Z'),
      platform: () => 'darwin',
      architecture: () => 'arm64',
      totalMemory: () => 24 * GiB,
      freeMemory: () => 18 * GiB,
      cpuInfo: () => Array.from({ length: 10 }, () => ({ model: 'Apple M4' })),
      gpuInfo: async () => ({ gpuDevice: [{ active: true, vendorId: 0x106b, deviceId: 1 }] }),
      cpuFeatures: async () => ['neon'],
      backends: async () => [{ kind: 'metal', status: 'available' }],
    });

    expect(snapshot).toMatchObject({
      status: 'complete',
      platform: 'darwin',
      memory: { topology: 'unified', totalBytes: 24 * GiB },
      gpus: [{ memory: { unifiedTotalBytes: 24 * GiB, dedicatedTotalBytes: null } }],
    });
  });

  it('joins explicit Windows dedicated/shared memory without guessing names', async () => {
    const snapshot = await collectLocalHardwareSnapshot({
      platform: () => 'win32',
      architecture: () => 'x64',
      totalMemory: () => 32 * GiB,
      freeMemory: () => 20 * GiB,
      cpuInfo: () => Array.from({ length: 16 }, () => ({ model: 'Fixture CPU' })),
      cpuFeatures: async () => ['avx2'],
      gpuInfo: async () => ({ gpuDevice: [{ active: true, vendorId: 0x10de, deviceId: 1234 }] }),
      gpuMemory: async () => [
        {
          vendorId: 0x10de,
          deviceId: 1234,
          memory: {
            dedicatedTotalBytes: 12 * GiB,
            dedicatedAvailableBytes: 10 * GiB,
            sharedTotalBytes: 16 * GiB,
            unifiedTotalBytes: null,
          },
        },
      ],
      backends: async () => [{ kind: 'cuda', status: 'available' }],
    });

    expect(snapshot.status).toBe('complete');
    expect(snapshot.gpus[0]).toMatchObject({
      vendorId: 0x10de,
      vendorName: null,
      deviceName: null,
      memory: { dedicatedAvailableBytes: 10 * GiB, sharedTotalBytes: 16 * GiB },
    });
  });

  it('normalizes failed GPU and optional probes to bounded unknown components', async () => {
    const snapshot = await collectLocalHardwareSnapshot({
      platform: () => 'linux',
      architecture: () => 'x64',
      totalMemory: () => 16 * GiB,
      freeMemory: () => 8 * GiB,
      cpuInfo: () => [{ model: 'Fixture CPU' }],
      gpuInfo: async () => {
        throw new Error('driver unavailable');
      },
    });

    expect(snapshot.status).toBe('partial');
    expect(snapshot.gpus).toEqual([]);
    expect(snapshot.unknownComponents).toEqual([
      'cpu_features',
      'gpu_devices',
      'gpu_memory',
      'backend_availability',
    ]);
  });

  it('retains independently observed totals in a partial component', async () => {
    const snapshot = await collectLocalHardwareSnapshot({
      platform: () => 'linux',
      architecture: () => 'x64',
      totalMemory: () => 16 * GiB,
      freeMemory: () => {
        throw new Error('temporarily unavailable');
      },
      cpuInfo: () => [{ model: 'Fixture CPU' }],
      cpuFeatures: async () => ['avx2'],
      gpuInfo: async () => ({ gpuDevice: [] }),
      backends: async () => [{ kind: 'cpu', status: 'available' }],
    });

    expect(snapshot).toMatchObject({
      status: 'partial',
      memory: { totalBytes: 16 * GiB, availableBytes: null },
      gpuDevicesStatus: 'known',
      unknownComponents: ['system_memory'],
    });
  });
});
