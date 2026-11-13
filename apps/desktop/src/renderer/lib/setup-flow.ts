// Which steps the Setup shows, in order. Pure, so the rules (replay drops the Workspace step; a
// preference the bridge cannot store is not offered) are tested without rendering anything.

export type SetupStepId = 'welcome' | 'ai' | 'reply' | 'team' | 'details' | 'workspace' | 'done';

/** `first-run`: the existing first launch. `replay`: started again from Settings by someone who
 * already uses the app — no Workspace step, no "first Task", closable at any time. */
export type SetupMode = 'first-run' | 'replay';

export const SETUP_STEP_LABELS: Readonly<Record<SetupStepId, string>> = {
  welcome: 'ようこそ',
  ai: 'AI',
  reply: '返事の仕方',
  team: 'Team',
  details: '細かい好み',
  workspace: '作業場所',
  done: '完了',
};

/** Steps whose choices are preferences: each has "あとで決める", and leaving one by "続ける"
 * stores what is on screen. */
export const SETUP_PREFERENCE_STEPS: ReadonlySet<SetupStepId> = new Set([
  'reply',
  'team',
  'details',
]);

export function setupSteps(input: {
  mode: SetupMode;
  assistant: boolean;
  team: boolean;
}): SetupStepId[] {
  const steps: SetupStepId[] = ['welcome', 'ai'];
  if (input.assistant) steps.push('reply');
  if (input.team) steps.push('team');
  // Always present: the sound and the new-Task safety default live in this renderer, so the step
  // works even where the assistant preferences cannot be stored.
  steps.push('details');
  if (input.mode === 'first-run') steps.push('workspace');
  steps.push('done');
  return steps;
}
