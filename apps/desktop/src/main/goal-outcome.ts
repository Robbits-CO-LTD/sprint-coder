import { goalReportSchema, type GoalReport } from '@sprint-coder/contracts';

// Bounds unattended calls even when a model keeps rewording the same claim of progress.
// An explicit resume or user reply starts a new series.
const MAX_AUTO_GOAL_TURNS = 12;
const fence = '```sprint-goal';

export function goalTurnGuidance(turnId: string): string {
  return [
    'This is a Sprint Coder Goal turn. Work toward the user’s objective. Use normal tools and permissions. Do what you can in this turn.',
    'After your normal final answer, append exactly one final fenced sprint-goal block with a JSON object. Use the current turnId below. Write the summary and next step in the user’s language (1–1200 characters each).',
    'Choose achieved ONLY when the entire objective is already met. Give specific observed evidence in summary. A plan, question, promise, or partial result is not achievement.',
    'Choose waiting when you need an answer or decision from the user; summary is the exact question. Choose blocked for an external obstacle, explaining what must change.',
    'Choose continue only when concrete progress was made and you have a further actionable step you can take without the user. Put progress evidence in summary and the specific remaining step in next. Sprint Coder will start another turn.',
    'Use next only for continue. The format is:',
    fence,
    `{"turnId":"${turnId}","status":"achieved|continue|waiting|blocked","summary":"..."}`,
    '```',
  ].join('\n');
}

export function parseGoalConclusion(
  content: string,
  turnId: string,
): { report: GoalReport; text: string } | null {
  const end = content.trimEnd();
  if (!end.endsWith('\n```')) return null;
  const start = end.lastIndexOf(fence);
  if (start < 0 || (start > 0 && end[start - 1] !== '\n')) return null;
  const block = end.slice(start + fence.length, -4);
  if (!/^\r?\n/.test(block) || block.length > 16_384) return null;
  try {
    const value: unknown = JSON.parse(block);
    if (!value || typeof value !== 'object' || !('turnId' in value) || value.turnId !== turnId)
      return null;
    const { turnId: _id, ...fields } = value;
    const report = goalReportSchema.safeParse(fields);
    if (!report.success) return null;
    return { report: report.data, text: content.slice(0, start).trimEnd() || report.data.summary };
  } catch {
    return null;
  }
}

export function goalDecision(
  report: GoalReport | null,
  previous: GoalReport | null,
  autoTurns: number,
): GoalReport {
  if (report === null)
    return {
      status: 'blocked',
      summary: 'AIからこのGoalの進捗報告を確認できませんでした。内容を確認して再開してください。',
    };
  if (report.status !== 'continue') return report;
  if (
    previous?.status === 'continue' &&
    previous.summary === report.summary &&
    previous.next === report.next
  )
    return {
      status: 'blocked',
      summary:
        `同じ進捗と次の作業が繰り返されたため、自動継続を停止しました。次の作業：${report.next}`.slice(
          0,
          1200,
        ),
    };
  if (autoTurns >= MAX_AUTO_GOAL_TURNS)
    return {
      status: 'blocked',
      summary:
        `自動継続が${MAX_AUTO_GOAL_TURNS}回に達しました。続けるには再開してください。次の作業：${report.next}`.slice(
          0,
          1200,
        ),
    };
  return report;
}
