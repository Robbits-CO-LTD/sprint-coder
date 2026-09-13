import {
  graphReadySchema,
  graphSelectionSchema,
  type GraphSelection,
  type GraphView,
} from '@sprint-coder/contracts';

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

/**
 * The same provenance and binding checks for the artifact's readiness announcement. Until the
 * displayed artifact has announced itself, its document has no selection listener, so a click
 * would be delivered and silently dropped (issue #464).
 */
export function acceptGraphReady(
  data: unknown,
  source: MessageEventSource | null,
  expectedSource: Window | null,
  view: GraphView,
): boolean {
  if (expectedSource === null || source !== expectedSource) return false;
  const parsed = graphReadySchema.safeParse(data);
  if (!parsed.success) return false;
  const ready = parsed.data;
  return (
    ready.graphId === view.id &&
    ready.revision === view.revision &&
    ready.instanceId === view.instanceId
  );
}
