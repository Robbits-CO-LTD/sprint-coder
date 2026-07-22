import { describe, expect, it } from 'vitest';
import { commandEnvelopeSchema, taskRenameInputSchema, turnEventSchema } from './index';

describe('public contracts', () => {
  it('rejects unknown command fields', () => {
    expect(() => commandEnvelopeSchema(taskRenameInputSchema).parse({
      requestId: 'r', operationId: 'o', payload: { taskId: 't', title: 'x' }, unknown: true,
    })).toThrow();
  });

  it('rejects malformed turn events', () => {
    expect(() => turnEventSchema.parse({
      type: 'message.delta', taskId: 't', turnId: 'u', seq: 0, messageId: 'm', delta: '',
    })).toThrow();
  });
});
