import {
  COMPUTER_START_MAX_FRACTION_DIGITS,
  COMPUTER_START_NUMBER_PATTERN,
  computerStartAnswerSchema,
  type ComputerStartAnswer,
  type ComputerStartQuestion,
  type ComputerUseAction,
  type ComputerUseSessionState,
  type ComputerUseStopReason,
} from '@sprint-coder/contracts';

/**
 * Closed-type answers for `computer_start` (T15-2, design C8).
 *
 * The outer agent keeps a conversation history, so nothing read off the screen may reach it as
 * text (T15). A closed question narrows what can: the outer agent names the type, the inner planner
 * answers in that type only, and Main returns a boolean, an index into the outer agent's own
 * choices, or a bounded string of digits. The screen can still mislead the value; it cannot write
 * a sentence into the conversation.
 */

/** A planner answer that has passed the question's type check, before the session-end gates. */
export type ComputerStartAnswerCandidate = Readonly<
  | { kind: 'boolean'; value: boolean }
  | { kind: 'choice'; value: number }
  | { kind: 'number'; value: string }
>;

/**
 * The question as the planner will see it.
 *
 * Choices are the outer agent's words and reach a provider prompt inside a fence, so they get the
 * session goal's treatment: NFKC, every control and format character and both angle brackets turned
 * into a space, whitespace collapsed. A choice that sanitises to nothing is refused rather than
 * silently dropped, because dropping it would shift every later index.
 */
export function normalizeComputerStartQuestion(
  question: ComputerStartQuestion,
): ComputerStartQuestion {
  if (question.kind !== 'choice') return question;
  const choices = question.choices.map((choice) => {
    const normalized = choice
      .normalize('NFKC')
      .replace(/[\p{Cc}\p{Cf}<>]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (normalized === '') throw new Error('Computer Use question choice is empty');
    return normalized;
  });
  return { kind: 'choice', choices };
}

/** What the planner's `finish` answers, or null unless it is exactly one value of the asked type. */
export function closedAnswerFromFinish(
  question: ComputerStartQuestion,
  action: ComputerUseAction,
): ComputerStartAnswerCandidate | null {
  if (action.type !== 'finish') return null;
  const given = [action.answerBoolean, action.answerChoice, action.answerNumber].filter(
    (value) => value !== undefined,
  );
  if (given.length !== 1) return null;
  switch (question.kind) {
    case 'boolean':
      return typeof action.answerBoolean === 'boolean'
        ? { kind: 'boolean', value: action.answerBoolean }
        : null;
    case 'choice': {
      const index = action.answerChoice;
      return typeof index === 'number' &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < question.choices.length
        ? { kind: 'choice', value: index }
        : null;
    }
    case 'number': {
      const value = canonicalNumber(action.answerNumber, question.maxFractionDigits);
      return value === null ? null : { kind: 'number', value };
    }
  }
}

/**
 * The `answer` field of the tool result. The candidate goes out only when the session ended with
 * `agent_finish` (any other ending means the planner did not conclude) and the application's egress
 * agreement still names the Turn's destination — the same condition the target list applies before
 * it shows a window title, since the answer is also something the application's screen produced.
 */
export function computerStartAnswerFor(
  input: Readonly<{
    question: ComputerStartQuestion;
    candidate: ComputerStartAnswerCandidate | null;
    state: ComputerUseSessionState;
    stopReason: ComputerUseStopReason | null;
    egressAgreed: boolean;
  }>,
): ComputerStartAnswer {
  const released =
    input.candidate !== null &&
    input.candidate.kind === input.question.kind &&
    input.state === 'stopped' &&
    input.stopReason === 'agent_finish' &&
    input.egressAgreed;
  return computerStartAnswerSchema.parse({
    kind: input.question.kind,
    value: released ? input.candidate!.value : null,
  });
}

function canonicalNumber(value: string | undefined, maxFractionDigits: number): string | null {
  if (typeof value !== 'string' || !COMPUTER_START_NUMBER_PATTERN.test(value)) return null;
  const negative = value.startsWith('-');
  const [integerPart = '', fractionPart = ''] = (negative ? value.slice(1) : value).split('.');
  if (
    fractionPart.length > Math.min(maxFractionDigits, COMPUTER_START_MAX_FRACTION_DIGITS) ||
    !/^\d+$/u.test(integerPart)
  )
    return null;
  const integer = integerPart.replace(/^0+(?=\d)/u, '');
  const fraction = fractionPart.replace(/0+$/u, '');
  const magnitude = fraction === '' ? integer : `${integer}.${fraction}`;
  return negative && /[1-9]/u.test(magnitude) ? `-${magnitude}` : magnitude;
}
