import remarkParse from 'remark-parse';
import { unified } from 'unified';

const markdownParser = unified().use(remarkParse);

type MarkdownNode = {
  type: string;
  position?: ReturnType<typeof markdownParser.parse>['position'];
  children?: readonly MarkdownNode[];
};

/** Keep source offsets and line boundaries while excluding quoted examples from hiring intent. */
export function maskTeamHiringMarkdown(input: string): string {
  const nodes: MarkdownNode[] = [markdownParser.parse(input)];
  const fragments: string[] = [];
  let cursor = 0;
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
        fragments.push(
          input.slice(cursor, start),
          input.slice(start, end).replace(/[^\r\n]/g, '\uFFFC'),
        );
        cursor = end;
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
  if (cursor === 0) return input;
  fragments.push(input.slice(cursor));
  return fragments.join('');
}
