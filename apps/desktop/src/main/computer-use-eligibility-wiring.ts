import type { ComputerUseEligibility, ComputerUseEligibilityMode } from '@sprint-coder/contracts';
import {
  computerUseClassifierV2Attested,
  effectiveComputerUseEligibilityMode,
} from './computer-use-eligibility';
import { computerUseCompiledEligibility } from './computer-use-native';
import { computerUseAgentDrivenV2Enabled } from './feature-flags';

/**
 * The production wiring of the two terms the native approval path and the session route rest on
 * (ADR v2 D7, C5-1): the effective eligibility mode, and whether the build attests classifier v2.
 * Both come from the eligibility compiled into Main (never from the renderer or the model) and the
 * V2 flag and the force-v1 variable, which can only lower the mode. While every version is 1 the
 * build attests classifier 1, so `classifierV2Attested` is false, the host binds every session to
 * route v1 for the native, and no approval path opens (C5-2 raises the versions).
 */
export type ComputerUseEligibilityWiringInputs = Readonly<{
  compiled: () => ComputerUseEligibility | null;
  agentDrivenV2: () => boolean;
  environment: () => Readonly<Record<string, string | undefined>>;
}>;

export function createComputerUseEligibilityWiring(inputs: ComputerUseEligibilityWiringInputs): {
  effectiveEligibilityMode: () => ComputerUseEligibilityMode;
  classifierV2Attested: (gateOpen: boolean) => boolean;
} {
  return {
    effectiveEligibilityMode: () =>
      effectiveComputerUseEligibilityMode({
        compiled: inputs.compiled()?.mode ?? null,
        agentDrivenV2: inputs.agentDrivenV2(),
        environment: inputs.environment(),
      }),
    classifierV2Attested: (gateOpen) =>
      computerUseClassifierV2Attested({ compiled: inputs.compiled(), gateOpen }),
  };
}

/** The wiring for this process. */
export const computerUseEligibilityWiring = createComputerUseEligibilityWiring({
  compiled: () => computerUseCompiledEligibility(),
  agentDrivenV2: () => computerUseAgentDrivenV2Enabled(),
  environment: () => process.env,
});
