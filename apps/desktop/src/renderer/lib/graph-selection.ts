import { graphSelectionSchema, type GraphSelection, type GraphView } from '@sprint-coder/contracts';

export function acceptGraphSelection(
  data: unknown,
  source: MessageEventSource | null,
  expectedSource: Window | null,
  view: GraphView,
): GraphSelection | null {
  if (expectedSource === null || source !== expectedSource) return null;
  const parsed = graphSelectionSchema.safeParse(data);
  if (!parsed.success) return null;
  const selection = parsed.data;
  if (
    selection.graphId !== view.id ||
    selection.revision !== view.revision ||
    selection.instanceId !== view.instanceId ||
    !(selection.kind === 'node' ? view.nodeIds : view.edgeIds).includes(selection.id)
  )
    return null;
  return selection;
}
