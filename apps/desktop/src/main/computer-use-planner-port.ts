import type {
  ComputerStartQuestion,
  ComputerUseAction,
  ComputerUseObservation,
} from '@sprint-coder/contracts';

export type ComputerUsePlannerObservation = ComputerUseObservation;

export type ComputerUsePlannerInput = Readonly<{
  observation: ComputerUsePlannerObservation;
  round: number;
  signal: AbortSignal;
  /**
   * The closed question `computer_start` asked (T15-2), normalised by Main. Handed to the planner
   * with every round by the controller itself, so the question cannot be lost between the session
   * and whichever planner the session was built with. Absent for a session that asked none.
   */
  question?: ComputerStartQuestion;
}>;

export interface ComputerUsePlannerPort {
  plan(input: ComputerUsePlannerInput): Promise<ComputerUseAction>;
  /** Re-check the session-bound provider/catalog/policy permit after human wait time. */
  revalidate?(signal: AbortSignal): Promise<void>;
  cancel?(executionId: string): Promise<void>;
}
