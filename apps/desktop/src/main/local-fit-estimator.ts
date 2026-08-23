import type {
  LocalFitAssessment,
  LocalFitMemoryBreakdown,
  LocalHardwareSnapshot,
  LocalVerificationBinding,
  LocalVerificationRecord,
} from '@sprint-coder/contracts';

export type LocalFitEstimateInput = Readonly<{
  weightsBytes: number | null;
  contextTokens: number | null;
  kvBytesPerToken: number | null;
  scratchBytes: number | null;
  runtimeReserveBytes: number | null;
  safetyFactor: number;
  gpuOffloadRatio: number;
  runtimeCompatibility: 'supported' | 'unsupported' | 'unknown';
  acceleratorBackend: 'available' | 'unavailable' | 'unknown';
  cpuBackend: 'available' | 'unavailable' | 'unknown';
}>;

const UNKNOWN: LocalFitAssessment = {
  state: 'unknown',
  label: '未判定',
  detail: '必要なモデルmetadataまたはハードウェア情報が不足しています。',
  breakdown: null,
  verification: null,
};

function checkedCeil(value: number): number | null {
  const rounded = Math.ceil(value);
  return Number.isSafeInteger(rounded) && rounded >= 0 ? rounded : null;
}

function calculateBreakdown(input: LocalFitEstimateInput): LocalFitMemoryBreakdown | null {
  const { weightsBytes, contextTokens, kvBytesPerToken, scratchBytes, runtimeReserveBytes } = input;
  if (
    weightsBytes === null ||
    contextTokens === null ||
    kvBytesPerToken === null ||
    scratchBytes === null ||
    runtimeReserveBytes === null ||
    !Number.isSafeInteger(weightsBytes) ||
    !Number.isSafeInteger(contextTokens) ||
    !Number.isSafeInteger(kvBytesPerToken) ||
    !Number.isSafeInteger(scratchBytes) ||
    !Number.isSafeInteger(runtimeReserveBytes) ||
    weightsBytes <= 0 ||
    contextTokens <= 0 ||
    kvBytesPerToken <= 0 ||
    scratchBytes < 0 ||
    runtimeReserveBytes < 0 ||
    !Number.isFinite(input.safetyFactor) ||
    input.safetyFactor < 1 ||
    input.safetyFactor > 2 ||
    !Number.isFinite(input.gpuOffloadRatio) ||
    input.gpuOffloadRatio < 0 ||
    input.gpuOffloadRatio > 1
  )
    return null;

  const kvCacheBytes = checkedCeil(contextTokens * kvBytesPerToken);
  if (kvCacheBytes === null) return null;
  const workingBytes = weightsBytes + kvCacheBytes + scratchBytes;
  const guardedWorkingBytes = checkedCeil(workingBytes * input.safetyFactor);
  if (guardedWorkingBytes === null) return null;
  const safetyMarginBytes = guardedWorkingBytes - workingBytes;
  const acceleratorWorkingBytes = checkedCeil(guardedWorkingBytes * input.gpuOffloadRatio);
  if (acceleratorWorkingBytes === null) return null;
  const requiredHostBytes = guardedWorkingBytes - acceleratorWorkingBytes + runtimeReserveBytes;
  if (!Number.isSafeInteger(requiredHostBytes)) return null;
  return {
    weightsBytes,
    kvCacheBytes,
    scratchBytes,
    runtimeReserveBytes,
    safetyMarginBytes,
    requiredHostBytes,
    requiredAcceleratorBytes: acceleratorWorkingBytes,
  };
}

function acceleratorAvailableBytes(hardware: LocalHardwareSnapshot): number | null {
  if (hardware.memory.topology === 'unified') return hardware.memory.availableBytes;
  const active = hardware.gpus.find((gpu) => gpu.active === true) ?? hardware.gpus[0];
  return active?.memory.dedicatedAvailableBytes ?? null;
}

/** Produces estimates only. Verified states require an exact reusable verification record. */
export function estimateLocalModelFit(
  input: LocalFitEstimateInput,
  hardware: LocalHardwareSnapshot,
): LocalFitAssessment {
  if (input.runtimeCompatibility === 'unsupported')
    return {
      state: 'unsupported',
      label: '非対応',
      detail: 'このruntimeは選択したモデル形式またはarchitectureに対応していません。',
      breakdown: null,
      verification: null,
    };
  if (input.runtimeCompatibility === 'unknown') return UNKNOWN;
  if (input.acceleratorBackend === 'unavailable' && input.cpuBackend === 'unavailable')
    return {
      state: 'unsupported',
      label: '非対応',
      detail: '利用できる推論backendがありません。',
      breakdown: null,
      verification: null,
    };

  const breakdown = calculateBreakdown(input);
  const hostAvailable = hardware.memory.availableBytes;
  if (breakdown === null || hostAvailable === null) return UNKNOWN;

  if (input.gpuOffloadRatio > 0) {
    if (input.acceleratorBackend === 'unknown') return UNKNOWN;
    if (input.acceleratorBackend === 'available') {
      const acceleratorAvailable = acceleratorAvailableBytes(hardware);
      if (acceleratorAvailable === null) return UNKNOWN;
      const unified = hardware.memory.topology === 'unified';
      const fitsAccelerator = unified
        ? breakdown.requiredHostBytes + breakdown.requiredAcceleratorBytes <= hostAvailable
        : breakdown.requiredAcceleratorBytes <= acceleratorAvailable &&
          breakdown.requiredHostBytes <= hostAvailable;
      if (fitsAccelerator)
        return {
          state: 'estimated_comfortable',
          label: '推定: 快適に動く見込み',
          detail: unified
            ? '統合メモリの推定必要量が現在の空き容量に収まります。'
            : 'GPUとシステムメモリの推定必要量が現在の空き容量に収まります。',
          breakdown,
          verification: null,
        };
    }
  }

  const cpuRequired = breakdown.requiredHostBytes + breakdown.requiredAcceleratorBytes;
  if (input.cpuBackend === 'unknown') return UNKNOWN;
  if (input.cpuBackend === 'available' && cpuRequired <= hostAvailable)
    return {
      state: 'estimated_cpu',
      label: '推定: CPUで動く見込み',
      detail: 'GPU条件は満たしませんが、CPU実行の推定必要量は現在の空きメモリに収まります。',
      breakdown: { ...breakdown, requiredHostBytes: cpuRequired, requiredAcceleratorBytes: 0 },
      verification: null,
    };
  return {
    state: 'estimated_insufficient',
    label: '推定: メモリ不足の見込み',
    detail: 'GPU実行とCPU実行のどちらも、推定必要量が現在の空きメモリを超えます。',
    breakdown,
    verification: null,
  };
}

function equalBinding(left: LocalVerificationBinding, right: LocalVerificationBinding): boolean {
  return (
    left.hostCapabilityFingerprint === right.hostCapabilityFingerprint &&
    left.modelRepo === right.modelRepo &&
    left.immutableRevision === right.immutableRevision &&
    left.quantization === right.quantization &&
    left.contextTokens === right.contextTokens &&
    left.kvCacheType === right.kvCacheType &&
    left.batchSize === right.batchSize &&
    left.gpuOffloadRatio === right.gpuOffloadRatio &&
    left.sidecarVersion === right.sidecarVersion &&
    left.backend === right.backend &&
    left.artifactHashes.length === right.artifactHashes.length &&
    left.artifactHashes.every((hash, index) => hash === right.artifactHashes[index])
  );
}

/** Reuses measured claims only for the exact host, model artifacts, settings, and engine. */
export function applyReusableLocalVerification(
  estimate: LocalFitAssessment,
  current: LocalVerificationBinding,
  record: LocalVerificationRecord | null,
): LocalFitAssessment {
  if (record === null || !equalBinding(current, record.binding)) return estimate;
  return record.level === 'tools'
    ? {
        state: 'verified_tools',
        label: 'コーディングツール確認済み',
        detail: `${record.verifiedAt}に同じ端末・モデル・設定・engineでツール往復を確認しました。`,
        breakdown: estimate.breakdown,
        verification: record,
      }
    : {
        state: 'verified_loaded',
        label: '実機ロード確認済み',
        detail: `${record.verifiedAt}に同じ端末・モデル・設定・engineでロードを確認しました。`,
        breakdown: estimate.breakdown,
        verification: record,
      };
}
