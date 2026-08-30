import type { ComputerUseAction, ComputerUseObservation } from '@sprint-coder/contracts';

export type ComputerUsePlannerObservation = ComputerUseObservation;

export type ComputerUsePlannerInput = Readonly<{
  observation: ComputerUsePlannerObservation;
  round: number;
  signal: AbortSignal;
}>;

export interface ComputerUsePlannerPort {
  plan(input: ComputerUsePlannerInput): Promise<ComputerUseAction>;
  /** Re-check the session-bound provider/catalog/policy permit after human wait time. */
  revalidate?(signal: AbortSignal): Promise<void>;
  cancel?(executionId: string): Promise<void>;
}
