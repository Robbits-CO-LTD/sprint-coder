// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { GraphView } from '@sprint-coder/contracts';
import { acceptGraphSelection } from './graph-selection';

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
});
