import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TurnStage } from '../types/sprint-coder';
import { GenerationIndicator, generationPattern } from './GenerationIndicator';

describe('generationPattern', () => {
  it.each([
    ['understanding', 'running', 'drive'],
    ['planning', 'running', 'drive'],
    ['executing', 'running', 'orbit'],
    ['synthesizing', 'running', 'dots'],
    ['waiting_approval', 'running', 'paused'],
    ['understanding', 'canceling', 'paused'],
    ['executing', 'completed', 'settled'],
    ['executing', 'failed', 'settled'],
    ['executing', 'canceled', 'settled'],
    ['executing', 'interrupted', 'settled'],
  ] as const)('%s + %s maps to %s', (stage, status, expected) => {
    expect(generationPattern(stage, status)).toBe(expected);
  });

  it('settles every stage after completion', () => {
    const stages: TurnStage[] = [
      'understanding',
      'planning',
      'executing',
      'waiting_approval',
      'synthesizing',
    ];

    expect(stages.map((stage) => generationPattern(stage, 'completed'))).toEqual(
      stages.map(() => 'settled'),
    );
  });
});

describe('GenerationIndicator', () => {
  it('renders nine decorative cells and exposes its resolved pattern as test data', () => {
    const html = renderToStaticMarkup(<GenerationIndicator stage="executing" status="running" />);

    expect(html).toContain('data-pattern="orbit"');
    expect(html).toContain('data-status="running"');
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/class="generation-pixel"/g)).toHaveLength(9);
  });
});
