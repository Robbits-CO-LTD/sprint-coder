import { useCallback, useEffect, useState } from 'react';
import type { ComputerAppGrantDecision, ComputerAppGrantRequest } from '@sprint-coder/contracts';

/**
 * The live application approval card for one Task (ADR v2 §6.1).
 *
 * Live state, never restored from history: the card exists only while a tool call is waiting for a
 * person, and Main withdraws it when the Turn, the Task selection, or the policy epoch moves. A
 * card rebuilt from a stored message would be a button with nothing behind it, so there is no store
 * slice and nothing is persisted — reloading the Renderer withdraws the card in Main.
 *
 * At most one card exists at a time globally, so one slot per Task is all this holds.
 */
export type ComputerUseAppGrantFeature = Readonly<{
  request: ComputerAppGrantRequest | null;
  busy: boolean;
  resolve: (decision: ComputerAppGrantDecision) => void;
}>;

export function useComputerUseAppGrant(taskId: string | null): ComputerUseAppGrantFeature {
  const [request, setRequest] = useState<ComputerAppGrantRequest | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = window.sprintCoder?.computerUse;
    if (api?.subscribeGrantRequests === undefined) return;
    return api.subscribeGrantRequests((next) => {
      setRequest((current) => {
        // Revisions only move forward. A late-arriving earlier state would otherwise put a resolved
        // card back on screen with its buttons live.
        if (current !== null && current.id === next.id && next.revision <= current.revision)
          return current;
        if (next.state === 'pending') return next;
        // A card that has closed keeps the row only long enough to say why (§6.1.1's "the target
        // application changed" message); a resolved one simply disappears.
        return current !== null && current.id !== next.id
          ? current
          : next.noticeCode === null
            ? null
            : next;
      });
      if (next.state !== 'pending') setBusy(false);
    });
  }, []);

  // The card belongs to the conversation it was raised in, so it is filtered here rather than
  // cleared on a Task change: Main withdraws it on the same event, and derived state cannot be left
  // holding a card for a conversation the user is no longer looking at.
  const visible = request !== null && request.taskId === taskId ? request : null;

  const resolve = useCallback(
    (decision: ComputerAppGrantDecision) => {
      const api = window.sprintCoder?.computerUse;
      if (api?.resolveGrantRequest === undefined || visible === null) return;
      setBusy(true);
      void api
        .resolveGrantRequest({
          requestId: visible.id,
          expectedRevision: visible.revision,
          decision,
        })
        .catch(() => {
          // The next published state is the answer. A failed click — a stale revision, a withdrawn
          // card, a mismatched intent — leaves the card as Main last described it rather than
          // guessing an outcome the user never got.
          setBusy(false);
        });
    },
    [visible],
  );

  return { request: visible, busy, resolve };
}
