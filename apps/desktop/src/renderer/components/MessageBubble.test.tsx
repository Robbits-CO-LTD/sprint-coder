import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBubble } from './MessageBubble';

describe('MessageBubble image attachment history', () => {
  it('renders accepted metadata in requested order without image bytes', () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        author="user"
        content="この画像を確認して"
        attachments={[
          {
            id: 'second',
            fileName: 'second.webp',
            mimeType: 'image/webp',
            byteLength: 1_572_864,
            createdAt: '2026-08-05T00:00:01.000Z',
          },
          {
            id: 'first',
            fileName: 'first.png',
            mimeType: 'image/png',
            byteLength: 100,
            createdAt: '2026-08-05T00:00:00.000Z',
          },
        ]}
      />,
    );

    expect(html).toContain('aria-label="この送信で参照した画像"');
    expect(html.indexOf('second.webp')).toBeLessThan(html.indexOf('first.png'));
    expect(html).toContain('WEBP · 1.5 MB');
    expect(html).toContain('PNG · 100 B');
    expect(html).not.toContain('<img');
  });

  it('does not render attachment history for a plain message', () => {
    const html = renderToStaticMarkup(<MessageBubble author="user" content="plain" />);
    expect(html).not.toContain('message-attachment-list');
  });
});
