import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  clipPublicMessage,
  formatBlueprintJsonSyntaxError,
  formatZodIssues,
} from './zod-issue-message';

describe('public Zod issue messages', () => {
  it('formats paths on one bounded line', () => {
    const result = z
      .object({ roles: z.array(z.object({ parentKey: z.literal('leader') })) })
      .safeParse({ roles: [{ parentKey: 'missing' }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid input');
    expect(formatZodIssues(result.error)).toContain('roles[0].parentKey');
    expect(formatZodIssues(result.error)).not.toMatch(/[\r\n]/);
  });

  it('clips dynamic public messages to the contract limit', () => {
    const message = clipPublicMessage(`field: ${'x'.repeat(600)}`);
    expect(message).toHaveLength(500);
    expect(message.endsWith('…')).toBe(true);
  });

  it('extracts only safe numeric JSON locations', () => {
    const message = formatBlueprintJsonSyntaxError(
      new SyntaxError('SECRET_VALUE at position 25 (line 1 column 26)'),
    );
    expect(message).toBe('team/blueprint.json がJSONとして不正です（行 1、列 26）');
    expect(message).not.toContain('SECRET_VALUE');
  });
});
