import { describe, expect, it } from 'vitest';
import { workerCompletionSchema, type WorkerCompletion } from '@sprint-coder/contracts';
import {
  CRITERIA_REPORT_VERIFICATION,
  DONE_CRITERIA_VERIFICATION,
  EMPTY_WORKER_ANSWER,
  MAIN_CONFIRMED_REPORT_EVIDENCE,
  REPORT_ONLY_WORKER_ANSWER,
  WORKER_SELF_REPORTED_EVIDENCE_PREFIX,
  WRITE_NOT_ATTEMPTED_VERIFICATION,
  allCriteriaDone,
  confirmWorkerReport,
  judgeWorkerCompletion,
  parseWorkerCriteriaReport,
  readWorkerCriteriaReport,
  workerCriteriaPrompt,
  workerWriteNotAttempted,
} from './team-worker-criteria';

const criteria = ['team-a.txt を作成する', 'team-c.txt を削除する'];

function answer(report: unknown, before = '作業しました。', after = ''): string {
  return `${before}\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`${after}`;
}

function completion(overrides: Partial<WorkerCompletion> = {}): WorkerCompletion {
  return workerCompletionSchema.parse({
    status: 'succeeded',
    summary: 'team-a.txt を作成しました。team-c.txt の削除は未実施です。',
    artifacts: [],
    verification: [{ name: 'worker-runtime:grok', outcome: 'pass' }],
    risks: [],
    ...overrides,
  });
}

describe('workerCriteriaPrompt', () => {
  it('numbers every criterion and asks for one report per number in a final json block', () => {
    const prompt = workerCriteriaPrompt(criteria);
    expect(prompt).toContain('1. team-a.txt を作成する');
    expect(prompt).toContain('2. team-c.txt を削除する');
    expect(prompt).toContain('番号1〜2をちょうど1回ずつ');
    expect(prompt).toContain('```json\n{"criteria":[{"index":1,"status":"done"');
    expect(prompt).toContain('"status":"not_done"');
  });

  it('asks a single criterion only for number 1 and asks nothing without criteria', () => {
    const prompt = workerCriteriaPrompt(['答えを見つける']);
    expect(prompt).toContain('完了条件1について報告してください');
    expect(prompt).not.toContain('"index":2');
    expect(workerCriteriaPrompt([])).toBe('');
  });
});

describe('parseWorkerCriteriaReport', () => {
  it('reads each criterion by number with the task text, not the text the model wrote', () => {
    const parsed = parseWorkerCriteriaReport(
      answer({
        criteria: [
          {
            index: 2,
            status: 'not_done',
            evidence: '削除ツールを呼びませんでした',
            criterion: '別の文',
          },
          { index: 1, status: 'done', evidence: ' read_file で内容を確認 ' },
        ],
      }),
      criteria,
    );
    expect(parsed).toEqual({
      ok: true,
      criteria: [
        { criterion: criteria[0], status: 'done', evidence: 'read_file で内容を確認' },
        { criterion: criteria[1], status: 'not_done', evidence: '削除ツールを呼びませんでした' },
      ],
      text: '作業しました。',
    });
  });

  it('uses the last json block and keeps text written after it', () => {
    const example = answer({ criteria: [{ index: 1, status: 'done', evidence: '例' }] });
    const parsed = parseWorkerCriteriaReport(
      `${example}\n\n${answer({ criteria: [{ index: 1, status: 'not_done', evidence: '' }] }, '最終報告', '\n以上です。')}`,
      ['答えを見つける'],
    );
    expect(parsed).toMatchObject({
      ok: true,
      criteria: [{ status: 'not_done', evidence: '' }],
    });
    expect(parsed.ok && parsed.text.endsWith('最終報告\n\n以上です。')).toBe(true);
  });

  it.each([
    ['no json block', '全部終わりました。', 'がありません'],
    [
      'a block cut off after an earlier complete one',
      `${answer({
        criteria: [
          { index: 1, status: 'done', evidence: 'a' },
          { index: 2, status: 'done', evidence: 'b' },
        ],
      })}\n\`\`\`json\n{"criteria":[{"index":1,`,
      '途中で切れています',
    ],
    ['invalid JSON', '```json\n{"criteria":[}\n```', 'JSONとして読み取れません'],
    ['no criteria array', answer({ result: [] }), '"criteria" の配列がありません'],
    [
      'an unknown number',
      answer({
        criteria: [
          { index: 1, status: 'done', evidence: 'a' },
          { index: 3, status: 'done', evidence: 'c' },
        ],
      }),
      '1〜2の番号ではない',
    ],
    [
      'a number given as text',
      answer({
        criteria: [
          { index: '1', status: 'done', evidence: 'a' },
          { index: 2, status: 'done', evidence: 'b' },
        ],
      }),
      '1〜2の番号ではない',
    ],
    [
      'a duplicate number',
      answer({
        criteria: [
          { index: 1, status: 'done', evidence: 'a' },
          { index: 1, status: 'done', evidence: 'b' },
        ],
      }),
      '完了条件1の報告が重複',
    ],
    [
      'a missing number',
      answer({ criteria: [{ index: 1, status: 'done', evidence: 'a' }] }),
      '完了条件2の報告がありません',
    ],
    ['an empty report', answer({ criteria: [] }), '完了条件1、2の報告がありません'],
    [
      'an unknown status',
      answer({
        criteria: [
          { index: 1, status: 'partial', evidence: 'a' },
          { index: 2, status: 'done', evidence: 'b' },
        ],
      }),
      'status',
    ],
    [
      'done without evidence',
      answer({
        criteria: [
          { index: 1, status: 'done', evidence: '  ' },
          { index: 2, status: 'done', evidence: 'b' },
        ],
      }),
      'evidence が空',
    ],
    [
      'evidence that is not text',
      answer({
        criteria: [
          { index: 1, status: 'done', evidence: 1 },
          { index: 2, status: 'done', evidence: 'b' },
        ],
      }),
      '文字列ではありません',
    ],
    [
      'evidence over 4000 characters',
      answer({
        criteria: [
          { index: 1, status: 'done', evidence: 'x'.repeat(4_001) },
          { index: 2, status: 'done', evidence: 'b' },
        ],
      }),
      '4000文字を超えて',
    ],
  ])('rejects %s', (_label, text, reason) => {
    const parsed = parseWorkerCriteriaReport(text, criteria);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.reason).toContain(reason);
  });
});

describe('readWorkerCriteriaReport', () => {
  it('returns the criteria and the summary without the report block', () => {
    const report = readWorkerCriteriaReport(
      answer({ criteria: [{ index: 1, status: 'done', evidence: '確認済み' }] }, '調べました。'),
      ['答えを見つける'],
    );
    expect(report).toEqual({
      summary: '調べました。',
      criteria: [{ criterion: '答えを見つける', status: 'done', evidence: '確認済み' }],
      verification: [],
    });
  });

  it('keeps the answer and records a failed criteria-report verification when unreadable', () => {
    const report = readWorkerCriteriaReport('全部終わりました。', ['答えを見つける']);
    expect(report.summary).toBe('全部終わりました。');
    expect(report.criteria).toBeUndefined();
    expect(report.verification).toEqual([
      { name: CRITERIA_REPORT_VERIFICATION, outcome: 'fail', detail: expect.any(String) },
    ]);
  });

  it('leaves an unreadable or cut-off report block out of the summary', () => {
    const broken = ['調べました。', '```json', '{"criteria":[}', '```', '以上です。'].join('\n');
    expect(readWorkerCriteriaReport(broken, ['答えを見つける']).summary).toBe(
      '調べました。\n\n以上です。',
    );
    const cutOff = ['調べました。', '```json', '{"criteria":[{"index":1,'].join('\n');
    expect(readWorkerCriteriaReport(cutOff, ['答えを見つける']).summary).toBe('調べました。');
    const invalid = answer(
      { criteria: [{ index: 2, status: 'done', evidence: 'x' }] },
      '調べました。',
    );
    expect(readWorkerCriteriaReport(invalid, ['答えを見つける']).summary).toBe('調べました。');
  });

  it('keeps an ordinary JSON block the Worker answered with, though the report is missing', () => {
    const text = ['設定ファイルを作りました。', '```json', '{"port":8080}', '```'].join('\n');
    const report = readWorkerCriteriaReport(text, ['設定を作る']);
    expect(report.criteria).toBeUndefined();
    expect(report.verification).toEqual([
      { name: CRITERIA_REPORT_VERIFICATION, outcome: 'fail', detail: expect.any(String) },
    ]);
    expect(report.summary).toBe(text);
  });

  it('reads the report from the final answer only, while the text before it leads the summary', () => {
    const earlier = `${answer({ criteria: [{ index: 1, status: 'done', evidence: '先に報告' }] }, '途中です。')}\n`;
    const unreported = readWorkerCriteriaReport('未完了です。', ['答えを見つける'], earlier);
    expect(unreported.criteria).toBeUndefined();
    expect(unreported.summary).toBe(`${earlier}未完了です。`);
    const reported = readWorkerCriteriaReport(
      answer({ criteria: [{ index: 1, status: 'done', evidence: '確認済み' }] }, '終わりました。'),
      ['答えを見つける'],
      '途中です。\n',
    );
    expect(reported.criteria).toEqual([
      { criterion: '答えを見つける', status: 'done', evidence: '確認済み' },
    ]);
    expect(reported.summary).toBe('途中です。\n終わりました。');
  });

  it('gives a fixed summary when the answer is only the report block', () => {
    const text = answer({ criteria: [{ index: 1, status: 'done', evidence: '確認済み' }] }, '');
    expect(readWorkerCriteriaReport(text, ['答えを見つける']).summary).toBe(
      REPORT_ONLY_WORKER_ANSWER,
    );
    const unreadable = ['```json', '{"criteria":[}', '```'].join('\n');
    expect(readWorkerCriteriaReport(unreadable, ['答えを見つける']).summary).toBe(
      REPORT_ONLY_WORKER_ANSWER,
    );
  });

  it.each([
    [
      'a readable report',
      answer({ criteria: [{ index: 1, status: 'done', evidence: 'ok' }] }, 'x'.repeat(5_000)),
    ],
    ['no report', 'x'.repeat(5_000)],
    [
      'a report with evidence too long to read',
      answer(
        { criteria: [{ index: 1, status: 'done', evidence: 'y'.repeat(4_001) }] },
        'x'.repeat(10),
      ),
    ],
  ])('keeps the summary within 4000 characters for %s', (_label, text) => {
    const report = readWorkerCriteriaReport(text, ['答えを見つける']);
    expect(report.summary.length).toBeLessThanOrEqual(4_000);
    expect(
      workerCompletionSchema.safeParse({
        status: 'succeeded',
        summary: report.summary,
        artifacts: [],
        verification: report.verification,
        risks: [],
      }).success,
    ).toBe(true);
  });

  it('keeps an answer to a task that asked for nothing within 4000 characters', () => {
    expect(readWorkerCriteriaReport('x'.repeat(5_000), undefined).summary).toHaveLength(4_000);
  });

  it('reads nothing when no criteria were asked for', () => {
    expect(readWorkerCriteriaReport('  ', undefined)).toEqual({
      summary: EMPTY_WORKER_ANSWER,
      criteria: undefined,
      verification: [],
    });
  });
});

describe('judgeWorkerCompletion', () => {
  it('builds evidence from each criterion reported done, labelled as unverified', () => {
    const judged = judgeWorkerCompletion(
      criteria,
      completion({
        criteria: [
          { criterion: criteria[0]!, status: 'done', evidence: 'read_file で確認' },
          {
            criterion: criteria[1]!,
            status: 'done',
            evidence: 'list_workspace で消えたことを確認',
          },
        ],
      }),
    );
    expect(judged.completion.status).toBe('succeeded');
    expect(judged.doneEvidence).toEqual([
      {
        criterion: criteria[0],
        evidence: `${WORKER_SELF_REPORTED_EVIDENCE_PREFIX}read_file で確認`,
      },
      {
        criterion: criteria[1],
        evidence: `${WORKER_SELF_REPORTED_EVIDENCE_PREFIX}list_workspace で消えたことを確認`,
      },
    ]);
    // The summary is never copied into evidence.
    expect(judged.doneEvidence.map(({ evidence }) => evidence).join('')).not.toContain('未実施');
  });

  it('fails a succeeded run with a criterion reported not done and names that criterion', () => {
    const judged = judgeWorkerCompletion(
      criteria,
      completion({
        criteria: [
          { criterion: criteria[0]!, status: 'done', evidence: 'read_file で確認' },
          { criterion: criteria[1]!, status: 'not_done', evidence: '削除は未実施です' },
        ],
      }),
    );
    expect(judged.doneEvidence).toEqual([]);
    expect(judged.completion.status).toBe('failed');
    expect(judged.completion.summary).toContain('完了条件1件');
    expect(judged.completion.summary).toContain('「team-c.txt を削除する」: 未達と報告されました');
    expect(judged.completion.summary).toContain('削除は未実施です');
    expect(judged.completion.summary).not.toContain('「team-a.txt を作成する」');
    expect(judged.completion.verification).toContainEqual({
      name: DONE_CRITERIA_VERIFICATION,
      outcome: 'fail',
      detail: expect.stringContaining('team-c.txt を削除する'),
    });
    expect(workerCompletionSchema.parse(judged.completion)).toEqual(judged.completion);
  });

  it('fails a succeeded run without a report and carries the reason the report was unreadable', () => {
    const judged = judgeWorkerCompletion(
      criteria,
      completion({
        verification: [
          { name: 'worker-runtime:grok', outcome: 'pass' },
          {
            name: CRITERIA_REPORT_VERIFICATION,
            outcome: 'fail',
            detail: '最終回答に完了条件ごとの報告（```json ブロック）がありません。',
          },
        ],
      }),
    );
    expect(judged.completion.status).toBe('failed');
    expect(judged.completion.summary).toContain('完了条件2件');
    expect(judged.completion.summary).toContain('報告の問題: 最終回答に完了条件ごとの報告');
    expect(judged.completion.summary).toContain('「team-a.txt を作成する」: 報告がありません');
    expect(judged.completion.summary).toContain('「team-c.txt を削除する」: 報告がありません');
    expect(judged.doneEvidence).toEqual([]);
  });

  it('fails a run whose report left a criterion out or gave a done criterion no evidence', () => {
    const judged = judgeWorkerCompletion(
      criteria,
      completion({ criteria: [{ criterion: criteria[0]!, status: 'done', evidence: '  ' }] }),
    );
    expect(judged.completion.status).toBe('failed');
    expect(judged.completion.summary).toContain('「team-a.txt を作成する」: 証拠が空です');
    expect(judged.completion.summary).toContain('「team-c.txt を削除する」: 報告がありません');
  });

  it('records no evidence for a run the Worker itself reported as failed', () => {
    const failed = completion({
      status: 'failed',
      criteria: [
        { criterion: criteria[0]!, status: 'done', evidence: 'a' },
        { criterion: criteria[1]!, status: 'done', evidence: 'b' },
      ],
    });
    expect(judgeWorkerCompletion(criteria, failed)).toEqual({
      completion: failed,
      doneEvidence: [],
    });
  });

  it('keeps the failed summary and verification within the completion limits', () => {
    const long = Array.from({ length: 50 }, (_, index) => `${index}:${'条件'.repeat(400)}`);
    const judged = judgeWorkerCompletion(
      long,
      completion({
        summary: 'x'.repeat(4_000),
        verification: Array.from({ length: 20 }, (_, index) => ({
          name: `check-${index}`,
          outcome: 'pass' as const,
        })),
        risks: Array.from({ length: 20 }, (_, index) => `risk-${index}`),
      }),
    );
    expect(judged.completion.status).toBe('failed');
    expect(() => workerCompletionSchema.parse(judged.completion)).not.toThrow();
    expect(judged.completion.verification.at(-1)?.name).toBe(DONE_CRITERIA_VERIFICATION);
  });

  it('accepts the report a simulated Worker gives for every criterion', () => {
    const judged = judgeWorkerCompletion(
      criteria,
      completion({ criteria: allCriteriaDone(criteria, 'Workerが依頼を完了しました。') }),
    );
    expect(judged.completion.status).toBe('succeeded');
    expect(judged.doneEvidence).toHaveLength(2);
  });
});

describe('confirmWorkerReport', () => {
  const directCriteria = ['Workerが依頼に対する検証可能な報告を返す'];

  it('confirms a succeeded non-empty report itself, without a per-criterion report', () => {
    expect(confirmWorkerReport(directCriteria, completion())).toEqual({
      completion: completion(),
      doneEvidence: [{ criterion: directCriteria[0], evidence: MAIN_CONFIRMED_REPORT_EVIDENCE }],
    });
  });

  it('fails an empty report and keeps a failed one as it is', () => {
    const empty = confirmWorkerReport(directCriteria, completion({ summary: EMPTY_WORKER_ANSWER }));
    expect(empty.completion.status).toBe('failed');
    expect(empty.completion.summary).toContain('Workerの報告が空だった');
    expect(empty.doneEvidence).toEqual([]);
    const failed = completion({ status: 'failed' });
    expect(confirmWorkerReport(directCriteria, failed)).toEqual({
      completion: failed,
      doneEvidence: [],
    });
  });
});

describe('workerWriteNotAttempted', () => {
  it('fails the run and says the workspace did not change, within the completion limits', () => {
    const failed = workerWriteNotAttempted(
      completion({
        summary: 'x'.repeat(4_000),
        verification: Array.from({ length: 20 }, (_, index) => ({
          name: `check-${index}`,
          outcome: 'pass' as const,
        })),
      }),
    );
    expect(failed.status).toBe('failed');
    expect(failed.summary.startsWith('書き込みを頼まれましたが')).toBe(true);
    expect(failed.verification.at(-1)).toMatchObject({
      name: WRITE_NOT_ATTEMPTED_VERIFICATION,
      outcome: 'fail',
    });
    expect(() => workerCompletionSchema.parse(failed)).not.toThrow();
  });
});
