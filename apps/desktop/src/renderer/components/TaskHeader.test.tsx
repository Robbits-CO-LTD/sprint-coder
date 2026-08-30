import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskSummary } from '../types/sprint-coder';
import { TaskHeader } from './TaskHeader';

const task: TaskSummary = {
  id: 'task-1',
  projectId: null,
  title: 'UIを整える',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: true,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
};

describe('TaskHeader Team button', () => {
  it('shows only the Team label without an icon or Canvas subtitle', () => {
    const html = renderToStaticMarkup(<TaskHeader task={task} onToggleTeam={() => {}} />);
    const button = html.match(/<button[^>]*data-testid="team-toggle"[^>]*>[\s\S]*?<\/button>/)?.[0];

    expect(button).toBeDefined();
    expect(button).toContain('aria-label="Teamを開く"');
    expect(button).toContain('title="Teamを開く"');
    expect(button).toMatch(/>Team<\/button>$/);
    expect(button).not.toContain('Canvas');
    expect(button).not.toContain('<img');
    expect(button).not.toContain('<svg');
    expect(button).not.toContain('<small');
  });

  it('exposes Computer Use only when Main made the gated entry available', () => {
    const hidden = renderToStaticMarkup(<TaskHeader task={task} onToggleTeam={() => {}} />);
    const visible = renderToStaticMarkup(
      <TaskHeader
        task={task}
        onToggleTeam={() => {}}
        onOpenComputerUse={() => {}}
        computerUseActive
      />,
    );

    expect(hidden).not.toContain('data-testid="computer-use-launch"');
    expect(visible).toContain('data-testid="computer-use-launch"');
    expect(visible).toContain('aria-pressed="true"');
    expect(visible).toContain('Computer Use');
  });
});
