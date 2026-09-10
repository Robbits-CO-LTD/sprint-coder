import { createHash } from 'node:crypto';
import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const FORBIDDEN_TAGS = new Set([
  'iframe',
  'frame',
  'object',
  'embed',
  'base',
  'form',
  'template',
  'foreignObject',
]);
const BRIDGE = `(() => {
  const root = document.documentElement;
  const send = (event) => {
    const element = event.target instanceof Element ? event.target.closest('[data-node-id],[data-edge-id]') : null;
    if (!element) return;
    const kind = element.hasAttribute('data-node-id') ? 'node' : 'edge';
    const id = element.getAttribute(kind === 'node' ? 'data-node-id' : 'data-edge-id');
    if (!id) return;
    parent.postMessage({ type: 'sprint-graph-selection', instanceId: root.dataset.graphInstance,
      graphId: root.dataset.graphId, revision: Number(root.dataset.graphRevision), kind, id }, '*');
  };
  document.addEventListener('click', send, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') send(event); }, true);
})();`;

function walk(node: Node, visit: (element: Element) => void): void {
  if ('tagName' in node) visit(node);
  if ('childNodes' in node) for (const child of [...node.childNodes]) walk(child, visit);
}

function text(element: Element): string {
  return element.childNodes.map((child) => ('value' in child ? child.value : '')).join('');
}

export function trustedArchifyScripts(template: string): readonly string[] {
  const scripts: string[] = [];
  walk(parse(template), (element) => {
    if (element.tagName === 'script') scripts.push(text(element));
  });
  if (scripts.length !== 2) throw new Error('Unexpected Archify template script inventory');
  return scripts;
}

export function prepareGraphHtml(
  html: string,
  scripts: readonly string[],
  binding: {
    graphId: string;
    revision: number;
    instanceId: string;
    parentOrigin: string;
  },
): { html: string; csp: string } {
  if (Buffer.byteLength(html) > 4 * 1024 * 1024) throw new Error('Graph output is too large');
  const doc = parse(html);
  const counts = new Map(scripts.map((script) => [script, 0]));
  let root: Element | undefined;
  let body: Element | undefined;
  walk(doc, (element) => {
    const tag = element.tagName;
    if (tag === 'link') {
      const parent = element.parentNode;
      if (parent) parent.childNodes = parent.childNodes.filter((child) => child !== element);
      return;
    }
    if (FORBIDDEN_TAGS.has(tag)) throw new Error('Graph contains an unsafe HTML element');
    if (tag === 'html') root = element;
    if (tag === 'body') body = element;
    for (const attr of element.attrs) {
      if (
        /^on/iu.test(attr.name) ||
        attr.name === 'srcdoc' ||
        (tag === 'meta' && attr.name === 'http-equiv')
      )
        throw new Error('Graph contains an unsafe HTML attribute');
      if (attr.name === 'src' && (tag !== 'img' || !attr.value.startsWith('data:image/')))
        throw new Error('Graph contains an external resource');
    }
    if (tag === 'script') {
      const type = element.attrs.find(({ name }) => name === 'type')?.value ?? '';
      const content = text(element);
      if (type === 'application/json') {
        const id = element.attrs.find(({ name }) => name === 'id')?.value;
        if (!['archify-i18n-data', 'archify-guided-views-data'].includes(id ?? ''))
          throw new Error('Unexpected graph data script');
        JSON.parse(content);
      } else {
        if (type !== '' || !counts.has(content))
          throw new Error('Graph script does not match the pinned viewer');
        counts.set(content, counts.get(content)! + 1);
      }
    }
    element.attrs = element.attrs.filter((attr) => {
      if (attr.name === 'href') return attr.value.startsWith('#');
      return !['target', 'download'].includes(attr.name);
    });
    const id = element.attrs.find(({ name }) => name === 'id')?.value;
    if (
      [
        'btn-export',
        'export-menu',
        'btn-focus-copy',
        'diagram-guide-story-copy',
        'route-probe-copy',
        'semantic-lens-copy',
      ].includes(id ?? '')
    ) {
      element.attrs.push(
        { name: 'hidden', value: '' },
        { name: 'aria-hidden', value: 'true' },
        { name: 'disabled', value: '' },
      );
      const style = element.attrs.find(({ name }) => name === 'style');
      if (style) style.value += ';display:none!important';
      else element.attrs.push({ name: 'style', value: 'display:none!important' });
    }
  });
  if (root === undefined || body === undefined || [...counts.values()].some((count) => count !== 1))
    throw new Error('Graph viewer inventory is incomplete');
  root.attrs.push(
    { name: 'data-graph-id', value: binding.graphId },
    { name: 'data-graph-instance', value: binding.instanceId },
    { name: 'data-graph-revision', value: String(binding.revision) },
  );
  const adapter = parseFragment(`<script>${BRIDGE}</script>`).childNodes[0]!;
  body.childNodes.push(adapter);
  adapter.parentNode = body;
  const hashes = [...scripts, BRIDGE]
    .map((script) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`)
    .join(' ');
  return {
    html: serialize(doc),
    csp: `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${binding.parentOrigin}`,
  };
}
