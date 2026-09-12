// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { GraphView } from '@sprint-coder/contracts';
import { acceptGraphReady, acceptGraphSelection } from './graph-selection';

describe('Graph frame selection boundary', () => {
  it('accepts only the current frame, graph revision and an existing element', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const source = iframe.contentWindow!;
    const id = '00000000-0000-4000-8000-000000000001';
    const view: GraphView = {
      id,
      taskId: id,
      revision: 2,
      renderRevision: 2,
      viewRevision: 3,
      title: 'Graph',
      kind: 'architecture',
      digest: 'a'.repeat(64),
      instanceId: id,
      artifactUrl: `app://graph/${id}?theme=dark`,
      nodeIds: ['api'],
      edgeIds: ['request'],
    };
    const valid = {
      type: 'sprint-graph-selection',
      graphId: id,
      instanceId: id,
      revision: 2,
      kind: 'node',
      id: 'api',
    };
    expect(acceptGraphSelection(valid, source, source, view)).toEqual(valid);
    expect(acceptGraphSelection(valid, window, source, view)).toBeNull();
    expect(acceptGraphSelection(valid, source, null, view)).toBeNull();
    for (const invalid of [
      { ...valid, revision: 1 },
      { ...valid, id: 'absent' },
      { ...valid, kind: 'edge' },
      { ...valid, start: true },
      { ...valid, instanceId: '00000000-0000-4000-8000-000000000002' },
    ])
      expect(acceptGraphSelection(invalid, source, source, view)).toBeNull();
    iframe.remove();
  });

  // Issue #464: a readiness announcement is what unblocks pointer input, so it has to pass the
  // same provenance and binding checks as a selection — a stale or foreign artifact must not be
  // able to declare the displayed one interactive.
  it('accepts a readiness announcement only from the displayed artifact', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const source = iframe.contentWindow!;
    const id = '00000000-0000-4000-8000-000000000001';
    const view: GraphView = {
      id,
      taskId: id,
      revision: 2,
      renderRevision: 2,
      viewRevision: 3,
      title: 'Graph',
      kind: 'architecture',
      digest: 'a'.repeat(64),
      instanceId: id,
      artifactUrl: `app://graph/${id}?theme=dark`,
      nodeIds: ['api'],
      edgeIds: ['request'],
    };
    const valid = { type: 'sprint-graph-ready', graphId: id, instanceId: id, revision: 2 };
    expect(acceptGraphReady(valid, source, source, view)).toBe(true);
    expect(acceptGraphReady(valid, window, source, view)).toBe(false);
    expect(acceptGraphReady(valid, source, null, view)).toBe(false);
    for (const invalid of [
      { ...valid, revision: 1 },
      { ...valid, instanceId: '00000000-0000-4000-8000-000000000002' },
      { ...valid, graphId: '00000000-0000-4000-8000-000000000002' },
      { ...valid, type: 'sprint-graph-selection' },
      { ...valid, extra: true },
    ])
      expect(acceptGraphReady(invalid, source, source, view)).toBe(false);
    iframe.remove();
  });
});
