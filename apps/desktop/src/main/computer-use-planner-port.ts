import type {
  ComputerStartQuestion,
  ComputerUseObservation,
  ComputerUsePlannedAction,
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
  /**
   * Artifacts this session may paste (#785 T15-7): the opaque id and the size class, never the
   * text. Absent or empty means `artifactRef` is not offered.
   */
  artifacts?: readonly Readonly<{ artifactId: string; sizeClass: string }>[];
}>;

export interface ComputerUsePlannerPort {
  plan(input: ComputerUsePlannerInput): Promise<ComputerUsePlannedAction>;
  /** Re-check the session-bound provider/catalog/policy permit after human wait time. */
  revalidate?(signal: AbortSignal): Promise<void>;
  cancel?(executionId: string): Promise<void>;
}
