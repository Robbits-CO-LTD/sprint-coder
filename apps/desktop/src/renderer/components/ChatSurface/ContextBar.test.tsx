import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextBar } from './ContextBar';

describe('ContextBar Project selection', () => {
  it('shows the Project picker without the legacy Workspace selector', () => {
    const html = renderToStaticMarkup(<ContextBar taskId="task-without-project" />);

    expect(html).toContain('Projectなし');
    expect(html).not.toContain('Workspace未選択');
    expect(html).not.toContain('Workspaceを選択');
  });
});
