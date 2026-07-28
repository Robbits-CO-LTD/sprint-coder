import type { AnchorRecovery, PatchValidationError } from './structured-patch';

// What a model is actually told when its edit did not apply.
//
// `structured-patch.ts` works out why an anchor missed and hands back everything needed to retry.
// This is the other half: turning that into the text the model reads. It is separate because the
// two have different failure modes — the diagnosis has to be correct, and this has to be *followed*
// — and because whoever eventually publishes an edit tool would otherwise improvise it at the call
// site, which is where the recovery data quietly stops being worth having.
//
// The shape of every message is the same: what failed, why, and the single next action. No apology,
// no restatement of the whole batch, and above all no advice to "check the file and try again",
// which is the instruction that costs a turn. When the current text is known it is included, so the
// retry needs nothing that is not already on screen.

/** Rendered for a failure that carries recovery data; null for any other validation error. */
export function describeAnchorFailure(error: PatchValidationError): string | null {
  const recovery = error.recovery;
  if (recovery === null) return null;
  return [
    `Edit ${recovery.editIndex} did not apply: ${headline(recovery)}`,
    ...body(recovery),
  ].join('\n');
}

function headline(recovery: AnchorRecovery): string {
  switch (recovery.cause) {
    case 'line_ending':
      return 'the anchor matches except for its line endings.';
    case 'trailing_whitespace':
      return 'the anchor matches except for trailing whitespace.';
    case 'indentation':
      return 'the anchor matches except for its indentation.';
    case 'drifted':
      return 'the file has moved on from the text you anchored to.';
    case 'ambiguous':
      return 'the anchor appears more than once, so which one you meant is not decidable.';
    case 'absent':
      return 'nothing in the file resembles the anchor.';
  }
}

function body(recovery: AnchorRecovery): readonly string[] {
  switch (recovery.cause) {
    // The three near-misses are fixable from the model's own text. Showing it the file would invite
    // a re-read it does not need, and re-reading is the expensive habit this exists to break.
    case 'line_ending':
      return ["Send the same anchor with the file's line endings and retry. Do not re-read."];
    case 'trailing_whitespace':
      return ['Send the same anchor with its trailing whitespace corrected. Do not re-read.'];
    case 'indentation':
      return [
        'Send the same anchor with the indentation as it appears in the file. Do not re-read.',
      ];
    case 'drifted':
      return recovery.nearest === null ? driftCandidates(recovery) : driftExact(recovery);
    case 'ambiguous':
      return [
        occurrenceLine(recovery, 'It currently appears at'),
        'Extend the anchor with surrounding lines until it matches exactly one place, then retry.',
      ];
    case 'absent':
      return [
        'This is the one case worth re-reading for: the region cannot be located from what you sent.',
      ];
  }
}

function driftExact(recovery: AnchorRecovery): readonly string[] {
  const nearest = recovery.nearest;
  if (nearest === null) return [];
  return [
    `Here is what is at line ${nearest.line} now${nearest.truncated ? ' (truncated)' : ''}:`,
    '',
    ...nearest.text.split('\n').map((line) => `  ${line}`),
    '',
    nearest.truncated
      ? 'Anchor to a part of this you can see in full, then retry. Do not re-read.'
      : 'Use that text verbatim as the anchor and retry. Do not re-read.',
  ];
}

function driftCandidates(recovery: AnchorRecovery): readonly string[] {
  return [
    occurrenceLine(recovery, 'Its opening line now appears at'),
    'Anchor to whichever of those you meant, using the text as it now reads.',
  ];
}

/** Reads as prose for one line and as a list for several, rather than as a ragged mix. */
function occurrenceLine(recovery: AnchorRecovery, lead: string): string {
  const lines = recovery.occurrences;
  if (lines.length === 0) return `${lead} no line this tool can name.`;
  if (lines.length === 1) return `${lead} line ${lines[0]}.`;
  return `${lead} lines ${lines.join(', ')}.`;
}
