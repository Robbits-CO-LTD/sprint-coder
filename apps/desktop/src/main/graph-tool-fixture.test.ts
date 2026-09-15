import { describe, expect, it } from 'vitest';
import {
  isGraphToolFixture,
  GRAPH_TOOL_FIXTURE_MARKER,
  GRAPH_UPDATE_MISSION_FIXTURE_MARKER,
} from './graph-tool-fixture';

describe('graph Mock fixture boundary', () => {
  it('requires an explicit environment opt-in and the exact marker', () => {
    expect(isGraphToolFixture(GRAPH_TOOL_FIXTURE_MARKER, {})).toBe(false);
    expect(isGraphToolFixture('図を作って', { SPRINT_CODER_E2E_GRAPH_FIXTURE: '1' })).toBe(false);
    expect(
      isGraphToolFixture(`${GRAPH_TOOL_FIXTURE_MARKER} extra`, {
        SPRINT_CODER_E2E_GRAPH_FIXTURE: '1',
      }),
    ).toBe(false);
    expect(
      isGraphToolFixture(GRAPH_TOOL_FIXTURE_MARKER, { SPRINT_CODER_E2E_GRAPH_FIXTURE: '1' }),
    ).toBe(true);
  });
  it('only enables the selected-node constraint fixture with the explicit Mock opt-in', () => {
    const input = `${GRAPH_UPDATE_MISSION_FIXTURE_MARKER}\n\n参照する図の識別情報:\n${JSON.stringify({ graphId: '11111111-1111-4111-8111-111111111111', revision: 1, kind: 'node', id: 'client' })}`;
    expect(isGraphToolFixture(input, {})).toBe(false);
    expect(isGraphToolFixture(input, { SPRINT_CODER_E2E_GRAPH_FIXTURE: '1' })).toBe(true);
    expect(
      isGraphToolFixture(GRAPH_UPDATE_MISSION_FIXTURE_MARKER, {
        SPRINT_CODER_E2E_GRAPH_FIXTURE: '1',
      }),
    ).toBe(false);
  });
});
