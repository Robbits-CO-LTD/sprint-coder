import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const remarkPlugins = [remarkGfm];
const disallowedElements = ['img'];

/**
 * The body of one Team message line, shared by the Canvas card and the List view so both render
 * the same DOM (the parity spec diffs their innerText). Raw HTML and images stay out of the DOM.
 *
 * Memoized on the text (issue #863): every Team update re-rendered every card, and re-parsing
 * the Markdown of every message line was most of the Renderer's time with a 32-Worker Team.
 */
export const TeamMessageMarkdown = memo(function TeamMessageMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      skipHtml
      disallowedElements={disallowedElements}
      unwrapDisallowed
    >
      {text}
    </ReactMarkdown>
  );
});
