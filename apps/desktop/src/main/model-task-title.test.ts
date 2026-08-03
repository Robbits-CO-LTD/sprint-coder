import { describe, expect, it } from 'vitest';
import {
  MODEL_TASK_TITLE_MAX_LENGTH,
  createTaskTitleContext,
  sanitizeGeneratedTaskTitle,
} from './model-task-title';

describe('sanitizeGeneratedTaskTitle', () => {
  it.each([
    ['Sprint Coderのタイトル生成改善', 'Sprint Coderのタイトル生成改善'],
    ['タイトル: サイドバーのタスク名改善', 'サイドバーのタスク名改善'],
    ['```text\n会話タイトルの自動生成\n```', '会話タイトルの自動生成'],
    ['{"title":"Readable task titles"}', 'Readable task titles'],
    ['```json\n{"title":"モデル生成タイトル"}\n```', 'モデル生成タイトル'],
    ['**会話タイトルの自動生成**', '会話タイトルの自動生成'],
    ['「手動タイトルの上書き防止」', '手動タイトルの上書き防止'],
  ])('normalizes %s', (output, expected) => {
    expect(sanitizeGeneratedTaskTitle(output)).toBe(expected);
  });

  it('uses only the first line rather than accepting an explanation', () => {
    expect(sanitizeGeneratedTaskTitle('サイドバーのタイトル改善\nこのタイトルを選びました。')).toBe(
      'サイドバーのタイトル改善',
    );
  });

  it('rejects empty or punctuation-only output', () => {
    expect(sanitizeGeneratedTaskTitle('')).toBeNull();
    expect(sanitizeGeneratedTaskTitle('...')).toBeNull();
    expect(sanitizeGeneratedTaskTitle('```\n```')).toBeNull();
  });

  it('truncates by Unicode code points', () => {
    const result = sanitizeGeneratedTaskTitle('🚀'.repeat(MODEL_TASK_TITLE_MAX_LENGTH + 5));
    expect(Array.from(result ?? '')).toHaveLength(MODEL_TASK_TITLE_MAX_LENGTH + 1);
    expect(result?.endsWith('…')).toBe(true);
  });
});

describe('createTaskTitleContext', () => {
  it('marks the request as user-provenance context without Project data', () => {
    const context = createTaskTitleContext('task-1', 'この依頼のタイトルを付けて');
    expect(context.fragments).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        source: 'history',
        trust: 'user',
        content: 'この依頼のタイトルを付けて',
      }),
    ]);
    expect(context.projectItems).toEqual([]);
  });
});
