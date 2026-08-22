import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectMemoryDialog } from './ProjectMemoryDialog';

const source = {
  projectId: 'project-1',
  turnId: 'turn-1',
  request: 'Request text',
  answer: 'Answer text',
};

describe('ProjectMemoryDialog', () => {
  it('uses a labelled icon button and dialog-specific dark-theme input classes', () => {
    const html = renderToStaticMarkup(<ProjectMemoryDialog source={source} onClose={() => {}} />);

    expect(html).toContain('class="project-memory-close"');
    expect(html).toContain('aria-label="閉じる"');
    expect(html).not.toContain('class="settings-close"');
    expect(html).not.toContain('>閉じる</button>');
    expect(html).toContain('class="project-memory-input"');
    expect(html).toContain('maxLength="4000"');
  });
});
