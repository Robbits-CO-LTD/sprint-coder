import { useEffect, useState } from 'react';
import type { GraphSourceStatus, GraphView } from '@sprint-coder/contracts';

export function useGraphSourceStatus(view: GraphView | null, selectionKey: string | null) {
  const [status, setStatus] = useState<GraphSourceStatus | null>(null);
  const [failedInstance, setFailedInstance] = useState<string | null>(null);
  useEffect(() => {
    const api = window.sprintCoder?.graphs;
    if (
      !view ||
      typeof api?.checkSources !== 'function' ||
      typeof api.subscribeSources !== 'function'
    )
      return;
    let active = true;
    let sequence = 0;
    const input = {
      taskId: view.taskId,
      instanceId: view.instanceId,
      renderRevision: view.renderRevision,
    };
    const update = (value: GraphSourceStatus) => {
      if (
        !active ||
        value.taskId !== input.taskId ||
        value.instanceId !== input.instanceId ||
        value.renderRevision !== input.renderRevision ||
        value.sequence <= sequence
      )
        return;
      sequence = value.sequence;
      setStatus(value);
      setFailedInstance(null);
    };
    const refresh = () => {
      const requestedAtSequence = sequence;
      void api
        .checkSources(input)
        .then(update)
        .catch(() => {
          if (active && sequence === requestedAtSequence) {
            setStatus(null);
            setFailedInstance(input.instanceId);
          }
        });
    };
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const unsubscribe = api.subscribeSources(update);
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [view, selectionKey]);
  return {
    status:
      status?.instanceId === view?.instanceId &&
      status?.taskId === view?.taskId &&
      status?.renderRevision === view?.renderRevision
        ? status
        : null,
    error: failedInstance !== null && failedInstance === view?.instanceId,
  };
}
