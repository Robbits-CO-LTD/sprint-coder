import { describe, expect, it } from 'vitest';
import { isGraphToolFixture, GRAPH_TOOL_FIXTURE_MARKER } from './graph-tool-fixture';

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
});
