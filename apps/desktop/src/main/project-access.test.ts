import { describe, expect, it } from 'vitest';
import { projectDefaultAccessSchema } from '@sprint-coder/contracts';
import { projectAccessToApply } from './project-access';

describe('projectAccessToApply', () => {
  it('seeds a never-configured Task from the folder default', () => {
    expect(projectAccessToApply({ projectDefaultAccess: 'auto', taskPolicyEpoch: 0 })).toBe('auto');
  });

  it('leaves a Task alone once the user has set its preset by hand', () => {
    // Epoch 1+ means a preset was written for this Task. The folder answers for Tasks that were
    // never asked; it must not overrule an answer given for this one — including the case where the
    // user deliberately narrowed a Task back down inside a folder they generally trust.
    expect(projectAccessToApply({ projectDefaultAccess: 'auto', taskPolicyEpoch: 1 })).toBeNull();
    expect(projectAccessToApply({ projectDefaultAccess: 'auto', taskPolicyEpoch: 9 })).toBeNull();
  });

  it('does not write when the folder default is already where a Task starts', () => {
    // Applying 'ask' would be a no-op that still costs a policy epoch, forcing every attached
    // Runtime to re-read a policy identical to the one it holds.
    expect(projectAccessToApply({ projectDefaultAccess: 'ask', taskPolicyEpoch: 0 })).toBeNull();
  });

  it('cannot reach full access, whatever a folder holds', () => {
    // The security property this feature has to keep: full access is gated behind a confirmation
    // dialog in the permissionsSet handler. If `full` ever became storable per folder, every future
    // Task there would be widened without that dialog appearing. Asserted on the schema rather than
    // on this function alone, because the schema is what makes the value unrepresentable.
    expect(projectDefaultAccessSchema.options).toEqual(['ask', 'auto']);
    expect(projectDefaultAccessSchema.safeParse('full').success).toBe(false);
    for (const access of projectDefaultAccessSchema.options)
      expect(projectAccessToApply({ projectDefaultAccess: access, taskPolicyEpoch: 0 })).not.toBe(
        'full',
      );
  });
});
