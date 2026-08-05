import type { ChatMessage } from '../types/sprint-coder';
import { Markdown } from './Markdown';

type Props = {
  author: ChatMessage['author'];
  content: string;
  attachments?: ChatMessage['attachments'];
  isStreaming?: boolean;
};

export function MessageBubble({ author, content, attachments = [], isStreaming = false }: Props) {
  if (author === 'system') {
    return (
      <div className="sys-notice" role="status">
        {content}
      </div>
    );
  }

  if (author === 'user') {
    // User content is always rendered as plain text — never passed through Markdown.
    return (
      <div className="msg msg-user" data-testid="user-message">
        <div className="bubble">{content}</div>
        {attachments.length > 0 && (
          <ul className="message-attachment-list" aria-label="この送信で参照した画像">
            {attachments.map((attachment) => (
              <li key={attachment.id} className="message-attachment-chip">
                <span className="message-attachment-name">{attachment.fileName}</span>
                <span className="message-attachment-meta">
                  {attachment.mimeType.replace('image/', '').toUpperCase()} ·{' '}
                  {formatAttachmentBytes(attachment.byteLength)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div
      className="msg msg-assistant"
      data-testid={isStreaming ? 'streaming-assistant-message' : 'assistant-message'}
    >
      <span className="msg-label">Assistant</span>
      <div className={`bubble${isStreaming ? ' caret' : ''}`}>
        <Markdown content={content} />
      </div>
    </div>
  );
}

function formatAttachmentBytes(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${Math.ceil(byteLength / 1024)} KB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
}
