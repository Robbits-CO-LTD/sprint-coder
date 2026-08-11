import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskActivityIndicator, taskActivityState } from './Sidebar';

describe('Sidebar Task activity', () => {
  it.each(['running', 'canceling'] as const)('shows %s as running', (status) => {
    expect(taskActivityState(status)).toBe('running');
    expect(renderToStaticMarkup(<TaskActivityIndicator activity="running" />)).toContain(
      'aria-label="実行中"',
    );
  });

  it('shows only a successful terminal Turn as completed', () => {
    expect(taskActivityState('completed')).toBe('completed');
    const markup = renderToStaticMarkup(<TaskActivityIndicator activity="completed" />);
    expect(markup).toContain('aria-label="完了"');
    expect(markup).toContain('sb-task-activity--completed');
  });

  it.each(['failed', 'canceled', 'interrupted', undefined] as const)(
    'does not mark %s as completed',
    (status) => {
      expect(taskActivityState(status)).toBeNull();
      expect(renderToStaticMarkup(<TaskActivityIndicator activity={null} />)).toBe('');
    },
  );
});
