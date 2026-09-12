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
// Injected as the FIRST child of <head> — see prepareGraphHtml. The pinned viewer is a single
// ~9,400-line inline script that the parser only reaches AFTER the diagram's <svg>, so appending
// this bridge to the end of <body> left a window in which the diagram was painted and
// hit-testable while no click listener existed yet: the click was delivered to the frame and
// silently dropped (issue #464). Registering from <head> puts the listeners in place before the
// SVG element is even parsed, and the readiness announcement lets the panel refuse to present the
// frame as interactive until then.
const BRIDGE = `(() => {
  const root = document.documentElement;
  const send = (event) => {
    const element = event.target instanceof Element ? event.target.closest('[data-node-id],[data-edge-id],[data-relationship-hit-key][data-relationship-id]') : null;
    if (!element) return;
    const kind = element.hasAttribute('data-node-id') ? 'node' : 'edge';
    const id = kind === 'node' ? element.getAttribute('data-node-id') : element.getAttribute('data-edge-id') || element.getAttribute('data-relationship-id');
    if (!id) return;
    parent.postMessage({ type: 'sprint-graph-selection', instanceId: root.dataset.graphInstance,
      graphId: root.dataset.graphId, revision: Number(root.dataset.graphRevision), kind, id }, '*');
  };
  const announce = () => parent.postMessage({ type: 'sprint-graph-ready', instanceId: root.dataset.graphInstance,
    graphId: root.dataset.graphId, revision: Number(root.dataset.graphRevision) }, '*');
  const labels = { assigned: '開始待ち', queued: '待機中', waiting_verification: '確認待ち', waiting_rate_limit: '接続待ち', running: '実行中', waiting_resume: '再開待ち', completed: '完了', failed: '失敗', canceled: '中止' };
  const saved = new Map();
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || !data || data.type !== 'sprint-graph-execution' || data.instanceId !== root.dataset.graphInstance || data.graphId !== root.dataset.graphId || data.revision !== Number(root.dataset.graphRevision) || !Array.isArray(data.nodes) || data.nodes.length > 64) return;
    // The parent posts execution state for this exact artifact on every load, so answering it
    // re-announces readiness: the handshake cannot deadlock if the parent attached its own
    // listener after the announcements below.
    announce();
    if (data.nodes.some((node) => !node || typeof node.id !== 'string' || node.id.length > 128 || !Object.hasOwn(labels, node.state))) return;
    for (const [element, previous] of saved) {
      element.style.filter = previous.filter;
      if (previous.label === null) element.removeAttribute('aria-label'); else element.setAttribute('aria-label', previous.label);
      delete element.dataset.executionState;
    }
    saved.clear();
    for (const node of data.nodes) {
      const element = document.querySelector('[data-node-id="' + CSS.escape(node.id) + '"]');
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
      const label = element.getAttribute('aria-label');
      saved.set(element, { filter: element.style.filter, label });
      element.dataset.executionState = node.state;
      element.setAttribute('aria-label', (label || node.id) + ' · ' + labels[node.state]);
      const color = node.state === 'completed' ? '#22c55e' : node.state === 'running' ? '#38bdf8' : ['failed','canceled'].includes(node.state) ? '#f87171' : '#fbbf24';
      element.style.filter = 'drop-shadow(0 0 4px ' + color + ')';
    }
  });
  document.addEventListener('click', send, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') send(event); }, true);
  // Announced twice on purpose: the immediate one is what normally unblocks the panel, and the
  // load one cannot lose the race against the parent registering its own message listener.
  announce();
  window.addEventListener('load', announce);
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
  let head: Element | undefined;
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
    if (tag === 'head') head = element;
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
  if (
    root === undefined ||
    head === undefined ||
    body === undefined ||
    [...counts.values()].some((count) => count !== 1)
  )
    throw new Error('Graph viewer inventory is incomplete');
  root.attrs.push(
    { name: 'data-graph-id', value: binding.graphId },
    { name: 'data-graph-instance', value: binding.instanceId },
    { name: 'data-graph-revision', value: String(binding.revision) },
  );
  // First child of <head>, ahead of the pinned viewer scripts and of the diagram markup, so the
  // selection listeners exist before anything the user can click has been parsed. Also wins the
  // capture phase over any viewer listener on `document`, whatever order those register in.
  const adapter = parseFragment(`<script>${BRIDGE}</script>`).childNodes[0]!;
  head.childNodes.unshift(adapter);
  adapter.parentNode = head;
  const hashes = [...scripts, BRIDGE]
    .map((script) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`)
    .join(' ');
  return {
    html: serialize(doc),
    csp: `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${binding.parentOrigin}`,
  };
}
