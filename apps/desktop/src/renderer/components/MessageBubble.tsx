import type { ChatMessage } from '../types/vibe';
import { Markdown } from './Markdown';

type Props = {
  author: ChatMessage['author'];
  content: string;
  isStreaming?: boolean;
};

export function MessageBubble({ author, content, isStreaming = false }: Props) {
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
      <div className="msg msg-user">
        <div className="bubble">{content}</div>
      </div>
    );
  }

  return (
    <div className="msg msg-assistant">
      <span className="msg-label">Assistant</span>
      <div className={`bubble${isStreaming ? ' caret' : ''}`}>
        <Markdown content={content} />
      </div>
    </div>
  );
}
