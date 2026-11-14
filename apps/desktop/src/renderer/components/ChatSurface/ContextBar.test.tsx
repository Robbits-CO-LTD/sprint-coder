import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextBar } from './ContextBar';

describe('ContextBar Project selection', () => {
  it('shows the Project picker without the legacy Workspace selector', () => {
    const html = renderToStaticMarkup(<ContextBar taskId="task-without-project" />);

    expect(html).toContain('プロジェクトを選択');
    expect(html).not.toContain('Workspace未選択');
    expect(html).not.toContain('Workspaceを選択');
  });

  it('does not show the file opener while the Task has no folder to open from', () => {
    const html = renderToStaticMarkup(<ContextBar taskId="task-without-project" />);

    expect(html).not.toContain('ファイルを開く');
    expect(html).not.toContain('open-file-button');
  });
});
