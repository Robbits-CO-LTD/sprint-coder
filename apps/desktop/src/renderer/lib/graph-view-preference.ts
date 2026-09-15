import { useState } from 'react';
import { z } from 'zod';
import { graphSelectionSchema, type GraphSelection, type GraphView } from '@sprint-coder/contracts';

const preferenceSchema = z
  .object({
    selection: graphSelectionSchema.pick({ kind: true, id: true }).nullable().default(null),
    historyOpen: z.boolean().default(false),
    planOpen: z.boolean().default(false),
  })
  .strict();
type Preference = z.infer<typeof preferenceSchema>;
type Identity = Pick<GraphView, 'taskId' | 'id' | 'revision'>;
const defaults: Preference = { selection: null, historyOpen: false, planOpen: false };
const keyFor = (view: Identity) =>
  `sprint-coder:graph-view:v1:${view.taskId}:${view.id}:${view.revision}`;

function read(view: Identity): Preference {
  try {
    const raw = window.localStorage.getItem(keyFor(view));
    if (!raw || raw.length > 1024) return defaults;
    const parsed = preferenceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : defaults;
  } catch {
    return defaults;
  }
}

function update(view: Identity, patch: Partial<Preference>): void {
  try {
    window.localStorage.setItem(keyFor(view), JSON.stringify({ ...read(view), ...patch }));
  } catch {
    // UI preferences are optional when browser storage is unavailable.
  }
}

export function restoreGraphSelection(view: GraphView): GraphSelection | null {
  const selection = read(view).selection;
  if (
    !selection ||
    !(selection.kind === 'node' ? view.nodeIds : view.edgeIds).includes(selection.id)
  )
    return null;
  return {
    ...selection,
    type: 'sprint-graph-selection',
    graphId: view.id,
    revision: view.revision,
    instanceId: view.instanceId,
  };
}

export function saveGraphSelection(view: GraphView, selection: GraphSelection): void {
  update(view, { selection: { kind: selection.kind, id: selection.id } });
}

export function useGraphDisclosure(view: Identity, field: 'historyOpen' | 'planOpen') {
  const key = keyFor(view);
  const [state, setState] = useState(() => ({ key, open: read(view)[field] }));
  // A new Task or semantic revision must never inherit another diagram's local disclosure state.
  const open = state.key === key ? state.open : read(view)[field];
  return [
    open,
    (next: boolean) => {
      setState({ key, open: next });
      update(view, { [field]: next });
    },
  ] as const;
}
