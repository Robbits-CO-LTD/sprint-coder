import { describe, expect, it } from 'vitest';
import type { ModelSelection } from '@sprint-coder/contracts';
import {
  MODEL_PICKER_AUTO_LABEL,
  canApplyOptimisticSelection,
  isModelPickerV2Active,
  resolveTriggerLabel,
  rollbackModelPicker,
  sameSelection,
  selectionForTask,
  shouldApplyModelPickerAnswer,
  type ModelPickerSnapshot,
} from './model-picker-parity';

function selection(overrides: Partial<ModelSelection> = {}): ModelSelection {
  return {
    connectionId: 'conn-1',
    requestedProvider: 'openai',
    requestedModel: 'gpt-5.6',
    ...overrides,
  };
}

function snapshot(overrides: Partial<ModelPickerSnapshot> = {}): ModelPickerSnapshot {
  return { taskId: 'task-a', enabled: true, selection: selection(), ...overrides };
}

describe('isModelPickerV2Active', () => {
  it('shows V2 only for the Task Main answered true for', () => {
    expect(isModelPickerV2Active(snapshot(), 'task-a')).toBe(true);
    expect(isModelPickerV2Active(snapshot(), 'task-b')).toBe(false);
  });

  it('keeps the legacy chip while the flag is unresolved or off', () => {
    expect(isModelPickerV2Active(snapshot({ enabled: null }), 'task-a')).toBe(false);
    expect(isModelPickerV2Active(snapshot({ enabled: false }), 'task-a')).toBe(false);
    // No `models` API at all resolves to the same off answer, so an older backend never flips.
    expect(
      isModelPickerV2Active({ taskId: 'task-a', enabled: false, selection: null }, 'task-a'),
    ).toBe(false);
  });
});

describe('selectionForTask', () => {
  it('refuses to hand one Task’s selection to another', () => {
    expect(selectionForTask(snapshot(), 'task-a')).toEqual(selection());
    expect(selectionForTask(snapshot(), 'task-b')).toBeNull();
  });
});

describe('resolveTriggerLabel', () => {
  it('shows the picked row’s display name while it still is the canonical selection', () => {
    const chosen = { connectionId: 'conn-1', requestedModel: 'gpt-5.6', displayName: 'GPT-5.6' };
    expect(resolveTriggerLabel(selection(), chosen)).toBe('GPT-5.6');
  });

  it('drops the local name as soon as the canonical selection moves elsewhere', () => {
    const chosen = { connectionId: 'conn-1', requestedModel: 'gpt-5.6', displayName: 'GPT-5.6' };
    // e.g. the legacy Model chip wrote a different model, and Main re-derived the selection.
    const external = selection({ requestedModel: 'claude-opus-5', requestedProvider: 'anthropic' });
    expect(resolveTriggerLabel(external, chosen)).toBe('claude-opus-5');
    // Same model id on a different connection is a different row, not the one that was picked.
    expect(resolveTriggerLabel(selection({ connectionId: 'conn-2' }), chosen)).toBe('gpt-5.6');
    // A rolled-back write, or a Task switch, leaves nothing for the name to describe.
    expect(resolveTriggerLabel(null, chosen)).toBe(MODEL_PICKER_AUTO_LABEL);
  });

  it('falls back to the id, then to auto, with no local name', () => {
    expect(resolveTriggerLabel(selection(), null)).toBe('gpt-5.6');
    expect(resolveTriggerLabel(null, null)).toBe(MODEL_PICKER_AUTO_LABEL);
    expect(
      resolveTriggerLabel(
        { connectionId: null, requestedProvider: null, requestedModel: null },
        null,
      ),
    ).toBe(MODEL_PICKER_AUTO_LABEL);
  });
});

describe('shouldApplyModelPickerAnswer', () => {
  const base = {
    requestTaskId: 'task-a',
    requestToken: 2,
    currentTaskId: 'task-a',
    latestToken: 2,
  };

  it('applies the newest answer for the Task on screen', () => {
    expect(shouldApplyModelPickerAnswer(base)).toBe(true);
  });

  it('drops an answer for a Task the user has already left', () => {
    expect(shouldApplyModelPickerAnswer({ ...base, currentTaskId: 'task-b' })).toBe(false);
    expect(shouldApplyModelPickerAnswer({ ...base, currentTaskId: null })).toBe(false);
  });

  it('drops an answer that a newer read or write has already superseded', () => {
    // A read issued before the user's latest choice must not undo it when it finally lands.
    expect(shouldApplyModelPickerAnswer({ ...base, requestToken: 1, latestToken: 3 })).toBe(false);
  });
});

describe('canApplyOptimisticSelection', () => {
  it('paints optimistically only over this Task’s own snapshot', () => {
    expect(canApplyOptimisticSelection(snapshot(), 'task-a')).toBe(true);
    expect(canApplyOptimisticSelection(snapshot(), 'task-b')).toBe(false);
    expect(canApplyOptimisticSelection(snapshot({ taskId: null }), 'task-a')).toBe(false);
  });
});

describe('rollbackModelPicker', () => {
  const attempted = selection({ requestedModel: 'gpt-5.6-sol' });
  const previous = snapshot({ selection: selection({ requestedModel: 'gpt-5.5' }) });
  const optimistic = snapshot({ selection: attempted });

  it('restores the pre-write selection when the store still holds the failed write', () => {
    expect(
      rollbackModelPicker({ current: optimistic, previous, taskId: 'task-a', attempted }),
    ).toEqual(previous);
  });

  it('leaves a Task switched to mid-flight untouched', () => {
    // The user moved to Task B before the rejection arrived; B's snapshot is the truth now, and
    // restoring A's would strand the Composer on another Task's selection and `enabled`.
    const current = snapshot({ taskId: 'task-b', enabled: false, selection: null });
    expect(rollbackModelPicker({ current, previous, taskId: 'task-a', attempted })).toEqual(
      current,
    );
  });

  it('leaves a newer selection for the same Task untouched', () => {
    const newer = snapshot({ selection: selection({ requestedModel: 'claude-opus-5' }) });
    expect(rollbackModelPicker({ current: newer, previous, taskId: 'task-a', attempted })).toEqual(
      newer,
    );
  });

  it('goes back to "not answered" rather than borrowing another Task’s snapshot', () => {
    const strayPrevious = snapshot({ taskId: 'task-b', enabled: false });
    expect(
      rollbackModelPicker({
        current: optimistic,
        previous: strayPrevious,
        taskId: 'task-a',
        attempted,
      }),
    ).toEqual({ taskId: 'task-a', enabled: true, selection: null });
  });
});

describe('sameSelection', () => {
  it('compares the whole identity, and treats null as its own value', () => {
    expect(sameSelection(selection(), selection())).toBe(true);
    expect(sameSelection(selection(), selection({ connectionId: 'conn-2' }))).toBe(false);
    expect(sameSelection(selection(), selection({ requestedProvider: 'openrouter' }))).toBe(false);
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(null, selection())).toBe(false);
  });
});
