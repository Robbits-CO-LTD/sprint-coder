import type { WorkerCompletion } from '@sprint-coder/contracts';

// A Worker's success is proven one done criterion at a time (issue #550). Each runtime asks the
// Worker to end its final answer with a per-criterion report, reads that report strictly, and Main
// builds done evidence only from the criteria the Worker reported as done. A summary is never
// copied into evidence, so a Worker that says "the deletion is not done" cannot complete its task.

/** Marks done evidence as the Worker's own claim, which Main has not checked (issue #527). */
export const WORKER_SELF_REPORTED_EVIDENCE_PREFIX = 'Worker報告（Main未検証）: ';

/** Verification a runtime adds when the Worker's per-criterion report is missing or invalid. */
export const CRITERIA_REPORT_VERIFICATION = 'criteria-report';

/** Verification Main adds when it records a succeeded run as failed for unmet criteria. */
export const DONE_CRITERIA_VERIFICATION = 'worker-done-criteria';

/** Verification Main adds when a write execution left its isolation unchanged. */
export const WRITE_NOT_ATTEMPTED_VERIFICATION = 'worker-write-not-attempted';

/** Evidence for a criterion Main checks itself: that a direct message got a non-empty report. */
export const MAIN_CONFIRMED_REPORT_EVIDENCE = 'Main確認: Workerが報告を返しました。';

/** The summary of a Worker that answered nothing. */
export const EMPTY_WORKER_ANSWER = '(空の応答)';

/** The summary of a Worker whose whole answer was its per-criterion report block. */
export const REPORT_ONLY_WORKER_ANSWER = 'Workerは完了条件ごとの報告だけを返しました。';

export type WorkerCriterionReport = NonNullable<WorkerCompletion['criteria']>[number];
export type WorkerDoneEvidence = { criterion: string; evidence: string };

const MAX_EVIDENCE_LENGTH = 4_000;
const MAX_SUMMARY_LENGTH = 4_000;
const MAX_QUOTED_LENGTH = 200;

/**
 * The numbered done criteria and the report format, appended to a Worker prompt. Empty when the
 * task has no criteria, which leaves nothing to report.
 */
export function workerCriteriaPrompt(doneCriteria: readonly string[]): string {
  if (doneCriteria.length === 0) return '';
  const count = doneCriteria.length;
  const example = [
    { index: 1, status: 'done', evidence: '何をしてどう確かめたか' },
    ...(count > 1 ? [{ index: 2, status: 'not_done', evidence: 'できなかった理由' }] : []),
  ];
  return [
    '完了条件（Leaderが決めたものです。番号で報告してください）:',
    ...doneCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    count === 1
      ? '最終回答の最後に、次の形式の ```json ブロックを1つだけ置き、完了条件1について報告してください。'
      : `最終回答の最後に、次の形式の \`\`\`json ブロックを1つだけ置き、完了条件の番号1〜${count}をちょうど1回ずつ報告してください。`,
    '- status: 満たした条件は "done"、満たしていない・確かめられなかった条件は "not_done"',
    '- evidence: done なら何をしてどう確かめたか、not_done ならできなかった理由（4000文字以内）',
    '満たしていない条件を "done" と報告しないでください。報告が無い・形式が違う・"not_done" の条件は未達として扱われ、この実行は失敗になります。',
    'ツールの呼び出しをすべて終えてから、最後に報告ブロックを書いてください（報告のあとにツールを呼ぶと、その報告は使われません）。',
    '```json と ``` はそれぞれ単独の行に書いてください。このブロックのあとには何も書かないでください。',
    '```json',
    JSON.stringify({ criteria: example }),
    '```',
  ].join('\n');
}

export type WorkerCriteriaReportResult =
  { ok: true; criteria: WorkerCriterionReport[]; text: string } | { ok: false; reason: string };

/**
 * Reads the per-criterion report from the ```json block that ends a Worker's final answer. Every
 * criterion number must appear exactly once with a valid status, and a done criterion needs
 * evidence. Anything else — no block, an unclosed (cut off) block, a block followed by more text
 * or by a tool call, invalid JSON, an unknown, duplicate or missing number — is a reason, never a
 * partial report. A block with text or a tool call after it was written before the answer ended
 * (say, before a check whose result the Worker then acted on), so it is not the final report.
 * `reportFrom` is where the text after the Worker's last tool call begins. The criterion text is
 * always the task's own, whatever the model wrote. `text` is the answer without the report block.
 */
export function parseWorkerCriteriaReport(
  finalText: string,
  doneCriteria: readonly string[],
  reportFrom = 0,
): WorkerCriteriaReportResult {
  if (doneCriteria.length === 0) return { ok: true, criteria: [], text: finalText.trim() };
  const fail = (reason: string): WorkerCriteriaReportResult => ({ ok: false, reason });
  const block = lastJsonBlock(finalText, reportFrom);
  if (block === null) return fail('最終回答に完了条件ごとの報告（```json ブロック）がありません。');
  if (block.bodyEnd === null || block.end === null)
    return fail(
      '完了条件ごとの報告の ```json ブロックが閉じられていません（途中で切れています）。',
    );
  if (block.start < reportFrom)
    return fail(
      '完了条件ごとの報告のあとにツールが実行されたため、この報告は最終の報告として扱いません。',
    );
  if (finalText.slice(block.end).trim() !== '')
    return fail(
      '完了条件ごとの報告の ```json ブロックが最終回答の最後にありません（ブロックのあとに文章が続いています）。',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalText.slice(block.bodyStart, block.bodyEnd));
  } catch {
    return fail('完了条件ごとの報告をJSONとして読み取れません。');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['criteria']))
    return fail('完了条件ごとの報告に "criteria" の配列がありません。');
  const count = doneCriteria.length;
  const reports = new Map<number, WorkerCriterionReport>();
  for (const entry of parsed['criteria'] as unknown[]) {
    if (!isRecord(entry)) return fail('完了条件ごとの報告に、オブジェクトでない項目があります。');
    const index = entry['index'];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > count)
      return fail(`完了条件ごとの報告に、1〜${count}の番号ではない index があります。`);
    if (reports.has(index)) return fail(`完了条件${index}の報告が重複しています。`);
    const status = entry['status'];
    if (status !== 'done' && status !== 'not_done')
      return fail(`完了条件${index}の status が "done" でも "not_done" でもありません。`);
    const evidence = entry['evidence'];
    if (typeof evidence !== 'string')
      return fail(`完了条件${index}の evidence が文字列ではありません。`);
    const trimmed = evidence.trim();
    if (status === 'done' && trimmed === '')
      return fail(`完了条件${index}は done ですが、evidence が空です。`);
    if (trimmed.length > MAX_EVIDENCE_LENGTH)
      return fail(`完了条件${index}の evidence が${MAX_EVIDENCE_LENGTH}文字を超えています。`);
    reports.set(index, { criterion: doneCriteria[index - 1]!, status, evidence: trimmed });
  }
  const missing = doneCriteria.map((_, index) => index + 1).filter((index) => !reports.has(index));
  if (missing.length > 0) return fail(`完了条件${missing.join('、')}の報告がありません。`);
  return {
    ok: true,
    criteria: [...reports.entries()].sort(([a], [b]) => a - b).map(([, report]) => report),
    text: withoutLastJsonBlock(finalText, block).trim(),
  };
}

/**
 * What a runtime puts in its completion from a Worker's final answer: a summary without the
 * report block, and either the criteria or a failed `criteria-report` verification. With no
 * `doneCriteria` nothing was asked for, so nothing is read. Only `finalText` is read for the
 * report; `precedingText`, what the Worker wrote before its final answer, only leads the summary.
 * `reportFrom` is where in `finalText` the text after the Worker's last tool call begins.
 * The summary always fits the completion's 4000 characters, whatever the Worker wrote.
 */
export function readWorkerCriteriaReport(
  finalText: string,
  doneCriteria: readonly string[] | undefined,
  options: Readonly<{ precedingText?: string; reportFrom?: number }> = {},
): {
  summary: string;
  criteria: WorkerCriterionReport[] | undefined;
  verification: WorkerCompletion['verification'];
} {
  const precedingText = options.precedingText ?? '';
  const report =
    doneCriteria === undefined
      ? null
      : parseWorkerCriteriaReport(finalText, doneCriteria, options.reportFrom);
  const block = report === null ? null : lastJsonBlock(finalText, options.reportFrom);
  // An unreadable report block is left out too: why it could not be read is in the verification.
  // Any other JSON block is part of the answer, such as a file the Worker was asked to produce.
  const withoutReport =
    report !== null &&
    (report.ok ? (doneCriteria?.length ?? 0) > 0 : isFailedReportBlock(finalText, block));
  const answer = withoutReport ? withoutLastJsonBlock(finalText, block) : finalText;
  const text = `${precedingText}${answer}`.trim();
  return {
    summary:
      text !== ''
        ? clipSummary(text)
        : `${precedingText}${finalText}`.trim() === ''
          ? EMPTY_WORKER_ANSWER
          : REPORT_ONLY_WORKER_ANSWER,
    criteria: report?.ok === true ? report.criteria : undefined,
    verification:
      report === null || report.ok
        ? []
        : [{ name: CRITERIA_REPORT_VERIFICATION, outcome: 'fail', detail: report.reason }],
  };
}

/** Every criterion reported done with the same evidence; for runtimes that simulate a Worker. */
export function allCriteriaDone(
  doneCriteria: readonly string[] | undefined,
  evidence: string,
): WorkerCriterionReport[] {
  return (doneCriteria ?? []).map((criterion) => ({ criterion, status: 'done', evidence }));
}

/**
 * Main's verdict on a Worker's completion, taken before any integration or state transition. A
 * succeeded run keeps its status only when every done criterion was reported done with evidence;
 * otherwise it is recorded as failed, naming each unmet criterion in its summary and verification,
 * so a completed task never lacks evidence and a write isolation is never integrated. Evidence is
 * built only from the criteria reported done, labelled as the Worker's unverified claim.
 */
export function judgeWorkerCompletion(
  doneCriteria: readonly string[],
  completion: WorkerCompletion,
): { completion: WorkerCompletion; doneEvidence: WorkerDoneEvidence[] } {
  // A failed report proves no criterion, whatever it says about each one.
  if (completion.status !== 'succeeded') return { completion, doneEvidence: [] };
  const unmet: string[] = [];
  const doneEvidence: WorkerDoneEvidence[] = [];
  for (const criterion of new Set(doneCriteria)) {
    const reports = (completion.criteria ?? []).filter((report) => report.criterion === criterion);
    const notDone = reports.find(({ status }) => status !== 'done');
    const evidence = reports[0]?.evidence.trim() ?? '';
    if (reports.length === 0) unmet.push(`「${clip(criterion)}」: 報告がありません`);
    else if (notDone !== undefined)
      unmet.push(
        `「${clip(criterion)}」: 未達と報告されました${notDone.evidence.trim() === '' ? '' : `（${clip(notDone.evidence.trim())}）`}`,
      );
    else if (evidence === '') unmet.push(`「${clip(criterion)}」: 証拠が空です`);
    else
      doneEvidence.push({
        criterion,
        evidence: `${WORKER_SELF_REPORTED_EVIDENCE_PREFIX}${evidence}`.slice(
          0,
          MAX_EVIDENCE_LENGTH,
        ),
      });
  }
  if (unmet.length === 0) return { completion, doneEvidence };
  const reportProblem =
    completion.criteria === undefined
      ? completion.verification.find(
          ({ name, outcome }) => name === CRITERIA_REPORT_VERIFICATION && outcome === 'fail',
        )?.detail
      : undefined;
  const headline = `完了条件${unmet.length}件をWorkerが満たしたと報告していないため、失敗として記録しました。`;
  const detail = [
    headline,
    ...(reportProblem === undefined ? [] : [`報告の問題: ${reportProblem}`]),
    ...unmet.map((line) => `- ${line}`),
  ].join('\n');
  return {
    completion: failWorkerCompletion(completion, DONE_CRITERIA_VERIFICATION, headline, detail),
    doneEvidence: [],
  };
}

/**
 * Main's verdict on a direct message, whose only criterion Main checks itself: a succeeded run
 * that returned a non-empty report meets it, so the Worker is asked for no per-criterion report.
 */
export function confirmWorkerReport(
  doneCriteria: readonly string[],
  completion: WorkerCompletion,
): { completion: WorkerCompletion; doneEvidence: WorkerDoneEvidence[] } {
  if (completion.status !== 'succeeded') return { completion, doneEvidence: [] };
  if (completion.summary.trim() === '' || completion.summary === EMPTY_WORKER_ANSWER) {
    const headline = 'Workerの報告が空だったため、失敗として記録しました。';
    return {
      completion: failWorkerCompletion(completion, DONE_CRITERIA_VERIFICATION, headline, headline),
      doneEvidence: [],
    };
  }
  return {
    completion,
    doneEvidence: [...new Set(doneCriteria)].map((criterion) => ({
      criterion,
      evidence: MAIN_CONFIRMED_REPORT_EVIDENCE,
    })),
  };
}

/**
 * The verdict on a write execution whose isolation Main found unchanged from its base: whatever
 * the Worker reported, it did not write what it was asked to (issue #550).
 */
export function workerWriteNotAttempted(completion: WorkerCompletion): WorkerCompletion {
  const detail =
    '書き込みを頼まれましたが、この実行の作業場所ではファイルが1つも変わらないまま終わりました。';
  return failWorkerCompletion(completion, WRITE_NOT_ATTEMPTED_VERIFICATION, detail, detail);
}

/** A completion turned into a failure that states why first, within the completion limits. */
function failWorkerCompletion(
  completion: WorkerCompletion,
  verification: string,
  headline: string,
  detail: string,
): WorkerCompletion {
  return {
    ...completion,
    status: 'failed',
    summary: `${detail}\n\nWorkerの報告:\n${completion.summary}`.slice(0, MAX_SUMMARY_LENGTH),
    verification: [
      ...completion.verification.slice(0, 19),
      { name: verification, outcome: 'fail', detail: detail.slice(0, 2_000) },
    ],
    risks: [...completion.risks.slice(0, 19), headline.slice(0, 500)],
  };
}

// No `m` flag: `^` must match only the very start of the sliced string (the reportFrom position
// itself), never a line start further into the slice. With `m` this would also match a real line
// start elsewhere in the slice, giving a match whose index is not 0 while the caller still treats
// `reportFrom` as its position — a mismatch that happens to be masked today by the `reportFrom >=
// start` check below, but should not depend on that check to stay correct (issue #585 review).
const JSON_FENCE_OPEN = /^[ \t]{0,3}```json\b([^\r\n]*)/iu;

/**
 * Where the last ```json block of a Worker answer starts, where its body ends and where the block
 * ends, if it is closed. A fence starts a line, after at most three spaces of indent (a block in a
 * list item). JSON escapes a newline inside a string, so a ``` inside an evidence string can never
 * start a line and close the block early. Two closings that do not stand on their own line are
 * also taken: a one-line block (```json {...}```) closed by the ``` that ends its line, and a ```
 * written right after the JSON that ends the whole answer.
 *
 * `reportFrom` is where the text after the Worker's last tool call begins (0 without a tool call).
 * A Claude or Grok adapter does not put a newline between a Turn's utterances, so the report can
 * start exactly there without starting an actual line (issue #585); that position is treated as a
 * line start too, but no other mid-line "```json" is. A real line start already covers `reportFrom
 * === 0`, so it is not given this treatment again.
 */
function lastJsonBlock(
  finalText: string,
  reportFrom = 0,
): { start: number; bodyStart: number; bodyEnd: number | null; end: number | null } | null {
  let opening: RegExpExecArray | null = null;
  let start = -1;
  for (const match of finalText.matchAll(/^[ \t]{0,3}```json\b([^\r\n]*)/gimu)) {
    opening = match;
    start = match.index;
  }
  if (reportFrom > 0 && reportFrom <= finalText.length && reportFrom >= start) {
    const atReportFrom = JSON_FENCE_OPEN.exec(finalText.slice(reportFrom));
    if (atReportFrom !== null) {
      opening = atReportFrom;
      start = reportFrom;
    }
  }
  if (opening === null) return null;
  const lineEnd = start + opening[0].length;
  const rest = opening[1]!.trimEnd();
  const bodyStart = lineEnd - opening[1]!.length;
  if (rest.trim() !== '' && rest.endsWith('```'))
    return { start, bodyStart, bodyEnd: bodyStart + rest.length - 3, end: bodyStart + rest.length };
  const closing = /^[ \t]{0,3}```[^\S\r\n]*\r?$/gmu;
  closing.lastIndex = lineEnd;
  const close = closing.exec(finalText);
  if (close !== null)
    return { start, bodyStart, bodyEnd: close.index, end: close.index + close[0].length };
  const answer = finalText.trimEnd();
  if (answer.endsWith('```') && answer.length - 3 >= lineEnd)
    return { start, bodyStart, bodyEnd: answer.length - 3, end: answer.length };
  return { start, bodyStart, bodyEnd: null, end: null };
}

/**
 * Whether the last ```json block is a per-criterion report that could not be used: an object with
 * a "criteria" key, or a block that is not readable JSON at all (one cut off included).
 */
function isFailedReportBlock(finalText: string, block: ReturnType<typeof lastJsonBlock>): boolean {
  if (block === null) return false;
  if (block.bodyEnd === null) return true;
  try {
    const parsed: unknown = JSON.parse(finalText.slice(block.bodyStart, block.bodyEnd));
    return isRecord(parsed) && Object.hasOwn(parsed, 'criteria');
  } catch {
    return true;
  }
}

/** The answer without its last ```json block; an unclosed block runs to the end. */
function withoutLastJsonBlock(finalText: string, block: ReturnType<typeof lastJsonBlock>): string {
  if (block === null) return finalText;
  const after = block.end === null ? '' : finalText.slice(block.end);
  return `${finalText.slice(0, block.start)}${after}`;
}

function clipSummary(text: string): string {
  return text.length <= MAX_SUMMARY_LENGTH ? text : `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

function clip(text: string): string {
  return text.length <= MAX_QUOTED_LENGTH ? text : `${text.slice(0, MAX_QUOTED_LENGTH)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
