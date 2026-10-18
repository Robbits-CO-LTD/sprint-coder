import { describe, expect, it } from 'vitest';
import { workerCompletionSchema, workerReportSchema } from '@sprint-coder/contracts';
import {
  TeamIntegrationResumeRequiredError,
  integrationBlockedCompletion,
  integrationResumedCompletion,
} from './team-coordinator';
import { WorktreeIntegrationConflictError } from './worker-worktree';

describe('integration blocked report (issue #852)', () => {
  it('stays within the UTF-16 limits even when many emoji paths conflict', () => {
    const files = Array.from({ length: 30 }, (_, i) => `${'😀'.repeat(190)}-${i}.md`);
    const completion = integrationBlockedCompletion(
      new TeamIntegrationResumeRequiredError('conflict', files),
    );
    expect(() => workerCompletionSchema.parse(completion)).not.toThrow();
    expect(completion.summary.length).toBeLessThanOrEqual(4_000);
    expect(completion.verification[0]!.detail!.length).toBeLessThanOrEqual(2_000);
    expect(completion.summary).not.toMatch(/[\uD800-\uDBFF]$/u);
  });

  it('says the other repositories were already integrated (partial apply)', () => {
    const completion = integrationBlockedCompletion(
      new TeamIntegrationResumeRequiredError('conflict', ['app › README.md'], ['lib']),
    );
    expect(completion.summary).toContain('部分適用');
    expect(completion.summary).toContain('lib');
    expect(completion.summary).toContain('そのリポジトリは統合前の状態のまま');
  });

  it('names the conflicting files of a single-repository Mission worktree conflict', () => {
    const completion = integrationBlockedCompletion(
      new WorktreeIntegrationConflictError('cherry-pick conflicted', ['docs/a.md']),
    );
    expect(completion.status).toBe('failed');
    expect(completion.summary).toContain('docs/a.md');
    expect(completion.summary).not.toContain('部分適用');
  });

  it('does not claim a partial apply when nothing else was integrated', () => {
    const completion = integrationBlockedCompletion(
      new TeamIntegrationResumeRequiredError('conflict', ['README.md']),
    );
    expect(completion.summary).not.toContain('部分適用');
  });
});

describe('integration resumed report (issue #852)', () => {
  it('reports success, supersedes the blocked report, and fits the schema', () => {
    const completion = integrationResumedCompletion(
      workerReportSchema.parse({
        status: 'completed',
        summary: '😀'.repeat(1_990),
        findings: [],
        changedFiles: ['README.md'],
        artifacts: [],
        verification: Array.from({ length: 20 }, (_, i) => ({
          name: `check-${i}`,
          outcome: 'pass',
        })),
        risks: [],
        nextActions: [],
        doneEvidence: [],
      }),
    );
    expect(() => workerCompletionSchema.parse(completion)).not.toThrow();
    expect(completion.status).toBe('succeeded');
    expect(completion.summary).toContain('置き換えてください');
    expect(completion.verification.at(-1)).toEqual({
      name: 'workspace-integration',
      outcome: 'pass',
    });
  });
});
