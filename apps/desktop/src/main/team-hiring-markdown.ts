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

const PRESENTATION_HTML_TAG = /^<\/?(?:a|b|em|i|mark|span|strong|u)(?:\s[^<>]*)?>$/i;

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

function projectFormattingSpans(
  input: string,
  spaceRanges: readonly SourceRange[],
  presentationTags: readonly SourceRange[] = [],
): string {
  if (spaceRanges.length === 0 && presentationTags.length === 0) return input;
  const characters = input.split('');
  const replace = ({ start, end }: SourceRange, replacement: string) => {
    for (let index = start; index < end; index += 1) {
      // Only AST-issued formatting spans change. Earlier literal masks and line
      // boundaries stay intact, including code inside a link label or inline HTML.
      const character = characters[index];
      if (
        character !== undefined &&
        character !== '\uFFFC' &&
        character !== '\r' &&
        character !== '\n'
      )
        characters[index] = replacement;
    }
  };
  for (const range of spaceRanges) replace(range, ' ');
  // Presentation tags stay barriers inside a hiring phrase, but cannot be confused with a
  // new quoted example whose following particle belongs to that example rather than the Turn.
  for (const range of presentationTags) replace(range, '\uFFFB');
  return characters.join('');
}

/** Keep source offsets and line boundaries while excluding quoted examples from hiring intent. */
export function maskTeamHiringMarkdown(input: string): string {
  const nodes: MarkdownNode[] = [markdownParser.parse(input)];
  const markdownRanges: SourceRange[] = [];
  const htmlRanges: SourceRange[] = [];
  const presentationTags: SourceRange[] = [];
  const emphasisMarkers: SourceRange[] = [];
  const linkSyntax: SourceRange[] = [];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (node === undefined) break;
    if (node.type === 'link' || node.type === 'linkReference' || node.type === 'definition') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        const labelStart = node.children?.at(0)?.position?.start.offset;
        const labelEnd = node.children?.at(-1)?.position?.end.offset;
        if (labelStart === undefined || labelEnd === undefined) linkSyntax.push({ start, end });
        else linkSyntax.push({ start, end: labelStart }, { start: labelEnd, end });
      }
    }
    if (node.type === 'emphasis' || node.type === 'strong') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const width = node.type === 'strong' ? 2 : 1;
      if (start !== undefined && end !== undefined) {
        emphasisMarkers.push({ start, end: start + width }, { start: end - width, end });
      }
    }
    if (
      node.type === 'blockquote' ||
      node.type === 'code' ||
      node.type === 'inlineCode' ||
      node.type === 'html'
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        if (node.type !== 'html') markdownRanges.push({ start, end });
        else if (PRESENTATION_HTML_TAG.test(input.slice(start, end)))
          presentationTags.push({ start, end });
        else htmlRanges.push({ start, end });
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

  if (htmlRanges.length === 0 && presentationTags.length === 0)
    return projectFormattingSpans(maskSourceRanges(input, markdownRanges), [
      ...emphasisMarkers,
      ...linkSyntax,
    ]);

  // Markdown exposes inline HTML tags separately from their text. Parse whole elements, but
  // hide Markdown examples and link metadata first so an unclosed tag in either cannot consume
  // real prose. Same-length projection preserves parse5's offsets into the original source.
  const htmlNodes: DefaultTreeAdapterMap['node'][] = [
    parseFragment(projectFormattingSpans(maskSourceRanges(input, markdownRanges), linkSyntax), {
      sourceCodeLocationInfo: true,
    }),
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
  return projectFormattingSpans(
    maskSourceRanges(input, [...markdownRanges, ...htmlRanges]),
    [...emphasisMarkers, ...linkSyntax],
    presentationTags,
  );
}
