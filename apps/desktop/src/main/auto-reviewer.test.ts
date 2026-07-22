import { describe, expect, it, vi } from 'vitest';
import {
  AutoReviewer,
  autoReviewerInputDigest,
  type AutoReviewerInput,
  type AutoReviewerModel,
} from './auto-reviewer';
import type { PermissionRequest } from '@vibe/domain';

const requestBase: Omit<PermissionRequest, 'reviewerInputDigest'> = {
  taskId: 'task-1',
  subjectId: 'leader',
  capability: 'workspace.read',
  resource: {
    kind: 'workspace-path',
    workspaceId: 'workspace-1',
    canonicalPath: '/workspace/readme.md',
    identityDigest: 'a'.repeat(64),
    classification: 'workspace',
  },
  operation: 'read',
  providerEgress: 'none',
  sandboxProfile: 'read-only',
  executionSpecDigest: 'b'.repeat(64),
  risk: 'low',
};
const lowTool = { kind: 'fileRead', sideEffect: 'read', risk: 'low' } as const;
const request: PermissionRequest = {
  ...requestBase,
  reviewerInputDigest: autoReviewerInputDigest({
    request: requestBase,
    tool: lowTool,
    policyEpoch: 3,
  }),
};
const reviewBinding = { turnId: 'turn-1', callId: 'call-1' } as const;

describe('AutoReviewer', () => {
  it('passes only immutable policy/risk facts and returns a Main-bound allow-once decision', async () => {
    let captured: AutoReviewerInput | undefined;
    const model: AutoReviewerModel = async (input) => {
      captured = input;
      return { schemaVersion: 1, decision: 'allow_once', reasonCode: 'safe_read_only' };
    };
    const reviewer = AutoReviewer.createForTesting({ model, timeoutMs: 100 });
    const decision = await reviewer.review({
      reviewRequestId: 'review-1',
      ...reviewBinding,
      request,
      tool: lowTool,
      policyEpoch: 3,
    });

    expect(captured).toMatchObject({
      schemaVersion: 1,
      capability: 'workspace.read',
      operation: 'read',
      policyEpoch: 3,
      risk: 'low',
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(JSON.stringify(captured)).not.toContain('/workspace/readme.md');
    expect(JSON.stringify(captured)).not.toContain('transcript');
    expect(decision).toMatchObject({
      decision: 'allow_once',
      reason: 'safe_read_only',
      policyEpoch: 3,
      inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      decisionNonce: expect.any(String),
    });
  });

  it('denies high risk without invoking the model', async () => {
    const model = vi.fn<AutoReviewerModel>();
    const reviewer = AutoReviewer.createForTesting({ model, timeoutMs: 100 });
    await expect(
      reviewer.review({
        reviewRequestId: 'review-high',
        ...reviewBinding,
        request: {
          ...request,
          risk: 'high',
          reviewerInputDigest: autoReviewerInputDigest({
            request: { ...requestBase, risk: 'high' },
            tool: { kind: 'shell', sideEffect: 'process', risk: 'high' },
            policyEpoch: 3,
          }),
        },
        tool: { kind: 'shell', sideEffect: 'process', risk: 'high' },
        policyEpoch: 3,
      }),
    ).resolves.toMatchObject({ decision: 'deny', reason: 'high_risk' });
    expect(model).not.toHaveBeenCalled();
  });

  it.each([
    ['schema failure', async () => ({ schemaVersion: 1, decision: 'allow_task' })],
    ['model failure', async () => Promise.reject(new Error('provider failed'))],
  ])('fails closed on %s', async (_label, model) => {
    const reviewer = AutoReviewer.createForTesting({
      model: model as AutoReviewerModel,
      timeoutMs: 100,
    });
    await expect(
      reviewer.review({
        reviewRequestId: `review-${_label}`,
        ...reviewBinding,
        request,
        tool: lowTool,
        policyEpoch: 3,
      }),
    ).resolves.toMatchObject({ decision: expect.stringMatching(/schema_failure|model_failure/) });
  });

  it('fails closed on timeout and never changes the decision after the late model response', async () => {
    const reviewer = AutoReviewer.createForTesting({
      model: () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                schemaVersion: 1,
                decision: 'allow_once',
                reasonCode: 'late_allow',
              }),
            50,
          ),
        ),
      timeoutMs: 5,
    });
    const first = await reviewer.review({
      reviewRequestId: 'review-timeout',
      ...reviewBinding,
      request,
      tool: lowTool,
      policyEpoch: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const replay = await reviewer.review({
      reviewRequestId: 'review-timeout',
      ...reviewBinding,
      request,
      tool: lowTool,
      policyEpoch: 3,
    });
    expect(first).toMatchObject({ decision: 'timeout' });
    expect(replay).toEqual(first);
  });

  it('denies a review request ID replay with different immutable facts', async () => {
    const reviewer = AutoReviewer.createForTesting({
      model: async () => ({
        schemaVersion: 1,
        decision: 'allow_once',
        reasonCode: 'safe_read_only',
      }),
      timeoutMs: 100,
    });
    await reviewer.review({
      reviewRequestId: 'review-conflict',
      ...reviewBinding,
      request,
      tool: lowTool,
      policyEpoch: 3,
    });
    await expect(
      reviewer.review({
        reviewRequestId: 'review-conflict',
        ...reviewBinding,
        request: { ...request, executionSpecDigest: 'd'.repeat(64) },
        tool: lowTool,
        policyEpoch: 3,
      }),
    ).resolves.toMatchObject({ decision: 'deny', reason: 'review_request_conflict' });
  });
});
