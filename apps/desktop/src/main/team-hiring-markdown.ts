import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const markdownParser = unified().use(remarkParse);

type MarkdownNode = {
  type: string;
  position?: ReturnType<typeof markdownParser.parse>['position'];
  children?: readonly MarkdownNode[];
};

type SourceRange = { start: number; end: number };

const HTML_LITERAL_ELEMENTS = new Set([
  'code',
  'pre',
  'blockquote',
  'q',
  'samp',
  'kbd',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
  'template',
]);

function maskSourceRanges(input: string, ranges: SourceRange[]): string {
  ranges.sort((left, right) => left.start - right.start);
  const fragments: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    const start = Math.max(cursor, range.start);
    fragments.push(
      input.slice(cursor, start),
      input.slice(start, range.end).replace(/[^\r\n]/g, '\uFFFC'),
    );
    cursor = range.end;
  }
  if (cursor === 0) return input;
  fragments.push(input.slice(cursor));
  return fragments.join('');
}

/** Keep source offsets and line boundaries while excluding quoted examples from hiring intent. */
export function maskTeamHiringMarkdown(input: string): string {
  const nodes: MarkdownNode[] = [markdownParser.parse(input)];
  const markdownRanges: SourceRange[] = [];
  const htmlRanges: SourceRange[] = [];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (node === undefined) break;
    if (
      node.type === 'blockquote' ||
      node.type === 'code' ||
      node.type === 'inlineCode' ||
      node.type === 'html'
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        (node.type === 'html' ? htmlRanges : markdownRanges).push({ start, end });
      }
      continue;
    }
    // Source order and skipping masked descendants keep all replacement spans disjoint.
    if (node.children !== undefined) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child !== undefined) nodes.push(child);
      }
    }
  }

  if (htmlRanges.length === 0) return maskSourceRanges(input, markdownRanges);

  // Markdown exposes inline HTML tags separately from their text. Parse whole elements, but
  // hide Markdown examples first so an unclosed tag in a code fence cannot consume real prose.
  const htmlNodes: DefaultTreeAdapterMap['node'][] = [
    parseFragment(maskSourceRanges(input, markdownRanges), { sourceCodeLocationInfo: true }),
  ];
  while (htmlNodes.length > 0) {
    const node = htmlNodes.pop();
    if (node === undefined) break;
    if ('tagName' in node && HTML_LITERAL_ELEMENTS.has(node.tagName)) {
      const location = node.sourceCodeLocation;
      if (location !== undefined && location !== null) {
        htmlRanges.push({ start: location.startOffset, end: location.endOffset });
      }
      continue;
    }
    if ('childNodes' in node) htmlNodes.push(...node.childNodes);
  }
  return maskSourceRanges(input, [...markdownRanges, ...htmlRanges]);
}
