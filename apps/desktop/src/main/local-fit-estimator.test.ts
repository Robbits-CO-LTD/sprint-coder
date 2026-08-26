import { describe, expect, it } from 'vitest';
import type {
  LocalHardwareSnapshot,
  LocalVerificationBinding,
  LocalVerificationRecord,
} from '@sprint-coder/contracts';
import {
  applyReusableLocalVerification,
  estimateLocalModelFit,
  type LocalFitEstimateInput,
} from './local-fit-estimator';

const GiB = 2 ** 30;
const baseInput: LocalFitEstimateInput = {
  weightsBytes: 4 * GiB,
  contextTokens: 8192,
  kvBytesPerToken: 65_536,
  scratchBytes: 512 * 2 ** 20,
  runtimeReserveBytes: 1 * GiB,
  safetyFactor: 1.15,
  gpuOffloadRatio: 0.8,
  runtimeCompatibility: 'supported',
  acceleratorBackend: 'available',
  cpuBackend: 'available',
};

function hardware(overrides: Partial<LocalHardwareSnapshot>): LocalHardwareSnapshot {
  return {
    version: 1,
    status: 'complete',
    observedAt: '2026-08-23T00:00:00.000Z',
    platform: 'linux',
    architecture: 'x64',
    memory: { totalBytes: 32 * GiB, availableBytes: 16 * GiB, topology: 'discrete' },
    cpu: { model: 'Fixture CPU', logicalCores: 16, features: ['avx2'], featuresStatus: 'known' },
    gpuDevicesStatus: 'known',
    gpus: [],
    backends: [],
    unknownComponents: [],
    ...overrides,
  };
}

describe('local fit estimator', () => {
  it('reports an honest comfortable estimate for Apple unified memory', () => {
    const result = estimateLocalModelFit(
      { ...baseInput, gpuOffloadRatio: 1 },
      hardware({
        platform: 'darwin',
        architecture: 'arm64',
        memory: { totalBytes: 24 * GiB, availableBytes: 12 * GiB, topology: 'unified' },
      }),
    );
    expect(result.state).toBe('estimated_comfortable');
    expect(result.label).toContain('推定');
    expect(result.detail).toContain('統合メモリ');
  });

  it('reports an honest comfortable estimate for an NVIDIA fixture', () => {
    const result = estimateLocalModelFit(
      baseInput,
      hardware({
        gpus: [
          {
            id: 'gpu-0',
            active: true,
            vendorId: 0x10de,
            deviceId: 1234,
            vendorName: null,
            deviceName: null,
            memory: {
              dedicatedTotalBytes: 12 * GiB,
              dedicatedAvailableBytes: 8 * GiB,
              sharedTotalBytes: 16 * GiB,
              unifiedTotalBytes: null,
            },
          },
        ],
      }),
    );
    expect(result.state).toBe('estimated_comfortable');
    expect(result.breakdown).toMatchObject({ weightsBytes: 4 * GiB });
  });

  it('does not substitute a CPU claim when requested GPU memory is unknown', () => {
    const result = estimateLocalModelFit(
      baseInput,
      hardware({
        status: 'partial',
        gpus: [
          {
            id: 'gpu-unknown',
            active: null,
            vendorId: null,
            deviceId: null,
            vendorName: null,
            deviceName: null,
            memory: {
              dedicatedTotalBytes: null,
              dedicatedAvailableBytes: null,
              sharedTotalBytes: null,
              unifiedTotalBytes: null,
            },
          },
        ],
        unknownComponents: ['gpu_memory'],
      }),
    );
    expect(result).toMatchObject({ state: 'unknown', label: '未判定', breakdown: null });
  });

  it('reports a CPU-only estimate when acceleration is explicitly unavailable', () => {
    const result = estimateLocalModelFit(
      { ...baseInput, acceleratorBackend: 'unavailable' },
      hardware({ memory: { totalBytes: 16 * GiB, availableBytes: 10 * GiB, topology: 'unknown' } }),
    );
    expect(result.state).toBe('estimated_cpu');
    expect(result.label).toContain('推定');
    expect(result.detail).toContain('CPU');
  });

  it('distinguishes insufficient memory from an explicitly unsupported runtime', () => {
    expect(
      estimateLocalModelFit(
        { ...baseInput, acceleratorBackend: 'unavailable' },
        hardware({ memory: { totalBytes: 4 * GiB, availableBytes: 2 * GiB, topology: 'unknown' } }),
      ).state,
    ).toBe('estimated_insufficient');
    expect(
      estimateLocalModelFit({ ...baseInput, runtimeCompatibility: 'unsupported' }, hardware({}))
        .state,
    ).toBe('unsupported');
  });

  it('invalidates a verified claim when any exact binding field changes', () => {
    const binding: LocalVerificationBinding = {
      hostCapabilityFingerprint: 'a'.repeat(64),
      modelRepo: 'owner/model',
      immutableRevision: 'b'.repeat(40),
      artifactHashes: ['c'.repeat(64)],
      quantization: 'Q4_K_M',
      contextTokens: 8192,
      kvCacheType: 'f16',
      batchSize: 512,
      gpuLayers: 99,
      gpuOffloadRatio: 1,
      sidecarVersion: '1.0.0',
      backend: 'metal',
    };
    const record: LocalVerificationRecord = {
      level: 'tools',
      verifiedAt: '2026-08-23T01:00:00.000Z',
      binding,
    };
    const estimate = estimateLocalModelFit(
      { ...baseInput, gpuOffloadRatio: 1 },
      hardware({
        platform: 'darwin',
        architecture: 'arm64',
        memory: { totalBytes: 24 * GiB, availableBytes: 12 * GiB, topology: 'unified' },
      }),
    );

    expect(applyReusableLocalVerification(estimate, binding, record).state).toBe('verified_tools');
    expect(
      applyReusableLocalVerification(estimate, binding, { ...record, level: 'loaded' }).state,
    ).toBe('verified_loaded');
    expect(
      applyReusableLocalVerification(estimate, { ...binding, contextTokens: 16_384 }, record).state,
    ).toBe('estimated_comfortable');
    expect(
      applyReusableLocalVerification(estimate, { ...binding, sidecarVersion: 'b10516' }, record)
        .state,
    ).toBe('estimated_comfortable');
    expect(
      applyReusableLocalVerification(estimate, { ...binding, gpuLayers: 50 }, record).state,
    ).toBe('estimated_comfortable');
  });
});
