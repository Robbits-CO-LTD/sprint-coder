import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkWebsite, createWebsiteServer } from '../../ci-website.mjs';

const cleanup = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-website-'));
  cleanup.push(root);
  function write(path, content) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  write(
    'index.html',
    `<!doctype html><html lang="ja"><head><title>Site</title>
    <link rel="stylesheet" href="/styles.css?v=1"><script src="/film.js" defer></script>
    <script type="application/ld+json">{"name":"Site"}</script></head>
    <body id="main"><a href="/about/#details">About</a>
    <video data-src="/media/clip.mp4" data-poster="/media/poster.jpg"></video></body></html>`,
  );
  write(
    'about/index.html',
    '<!doctype html><title>About</title><h1 id="details">About</h1><a href="../#main">Home</a>',
  );
  write('film.js', 'document.documentElement.classList.add("js");');
  write('styles.css', '@font-face { src: url("/fonts/local.woff2?v=1"); }');
  write('fonts/local.woff2', 'font');
  write('media/poster.jpg', 'poster');
  write('media/clip.mp4', '0123456789');
  return { root, write };
}

describe('website publication validation', () => {
  it('checks published routes, relative URLs, fragments, lazy media, and CSS resources', () => {
    const { root, write } = fixture();
    write('tools/broken.js', 'syntax error intentionally outside publication');
    write('README.md', 'not published');
    const result = checkWebsite(root);
    expect(result.routes).toEqual(['/about/', '/']);
    expect(result.files).not.toContain('README.md');
    expect(result.files.some((file) => file.startsWith('tools/'))).toBe(false);
  });

  it('preserves standalone HTML route names that happen to end in index.html', () => {
    const { root, write } = fixture();
    write('searchindex.html', '<!doctype html><title>Search</title>');
    expect(checkWebsite(root).routes).toContain('/searchindex.html');
  });

  it('validates every responsive image candidate, including candidates not selected by the browser', () => {
    const { root, write } = fixture();
    write(
      'index.html',
      '<!doctype html><main id="main"><img srcset="data:image/png;base64,AAAA 1x, /media/poster.jpg 2x"></main>',
    );
    expect(() => checkWebsite(root)).not.toThrow();
    write(
      'index.html',
      '<!doctype html><main id="main"><img srcset="/media/poster.jpg 1x, /missing.jpg 2x"></main>',
    );
    expect(() => checkWebsite(root)).toThrow('missing local reference /missing.jpg');
  });

  it.each(['index.html', 'styles.css', 'film.js'])('requires %s at publication time', (file) => {
    const { root } = fixture();
    rmSync(join(root, file));
    expect(() => checkWebsite(root)).toThrow(`${file}: required publishing file is missing`);
  });

  it.each([
    ['index.html', '<!doctype html><title x="1" x="2">Invalid</title>', 'invalid HTML'],
    ['film.js', 'const = ;', 'invalid JavaScript'],
    ['index.html', '<!doctype html><script>const = ;</script>', 'invalid JavaScript'],
    [
      'index.html',
      '<!doctype html><script type="module">export const = ;</script>',
      'invalid JavaScript',
    ],
    [
      'index.html',
      '<!doctype html><script type="application/ld+json">{bad}</script>',
      'invalid JSON-LD',
    ],
    ['index.html', '<!doctype html><a href="/about/#missing">Broken</a>', 'missing fragment'],
    ['index.html', '<!doctype html><img src="/missing.png">', 'missing local reference'],
    [
      'index.html',
      '<!doctype html><video data-src="/missing.mp4"></video>',
      'missing local reference',
    ],
    [
      'index.html',
      '<!doctype html><video data-poster="/missing.jpg"></video>',
      'missing local reference',
    ],
    [
      'index.html',
      '<!doctype html><a href="/README.md">Not published</a>',
      'missing local reference',
    ],
    ['index.html', '<!doctype html><a href="/%00">Bad path</a>', 'invalid local URL'],
    [
      'index.html',
      '<!doctype html><h1 id="duplicate">One</h1><p id="duplicate">Two</p>',
      'duplicate id',
    ],
    ['styles.css', 'body { background: url("./missing.png"); }', 'missing local reference'],
    ['styles.css', '@import "missing.css";', 'missing local reference'],
  ])('rejects invalid publication: %s / %s', (file, source, message) => {
    const { root, write } = fixture();
    write(file, source);
    expect(() => checkWebsite(root)).toThrow(message);
  });

  it('checks module syntax without executing scripts or requiring their imports', () => {
    const { root, write } = fixture();
    write(
      'index.html',
      '<!doctype html><script type="module" src="/entry.js"></script><main id="main"></main>',
    );
    write('entry.js', 'import "./unexecuted.js"; export const answer = 42;');
    expect(() => checkWebsite(root)).not.toThrow();
    write('entry.js', 'export const = ;');
    expect(() => checkWebsite(root)).toThrow('entry.js: invalid JavaScript');
  });

  it('ignores external links and data URLs without accessing the network', () => {
    const { root, write } = fixture();
    write(
      'index.html',
      '<!doctype html><main id="main"><a href="https://example.invalid/">External</a><a href="mailto:a@example.invalid">Mail</a></main>',
    );
    write('styles.css', 'body { background: url("data:image/svg+xml,%3Csvg/%3E"); }');
    expect(() => checkWebsite(root)).not.toThrow();
    write(
      'index.html',
      '<!doctype html><link rel="canonical" href="https://sprintcoder.yuseilab.com/missing/">',
    );
    expect(() => checkWebsite(root)).toThrow('missing local reference');
  });

  it('rejects directory links without following them', () => {
    const { root } = fixture();
    symlinkSync(root, join(root, 'loop'), 'junction');
    expect(() => checkWebsite(root)).toThrow('loop: not a regular file');
  });

  it('matches deployment rejection of links even inside excluded tooling', () => {
    const { root, write } = fixture();
    write('tools/readme.txt', 'not published');
    symlinkSync(root, join(root, 'tools/loop'), 'junction');
    expect(() => checkWebsite(root)).toThrow('tools/loop: not a regular file');
    rmSync(join(root, 'tools'), { recursive: true });
    symlinkSync(root, join(root, 'tools'), 'junction');
    expect(() => checkWebsite(root)).toThrow('tools: not a regular file');
  });

  it('rejects files at the same 25 MiB boundary as the deploy script', () => {
    const { root, write } = fixture();
    write('large.mp4', '');
    truncateSync(join(root, 'large.mp4'), 25 * 1024 * 1024);
    expect(() => checkWebsite(root)).toThrow('25 MiB publishing limit');
    truncateSync(join(root, 'large.mp4'), 25 * 1024 * 1024 - 1);
    expect(() => checkWebsite(root)).not.toThrow();
  });
});

describe('website test server', () => {
  it('serves only the publication set and supports browser video byte-range requests', async () => {
    const { root, write } = fixture();
    write('README.md', 'private preview instructions');
    const server = createWebsiteServer(root);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const homepage = await fetch(`${base}/?v=1`);
      expect(homepage.status).toBe(200);
      expect(homepage.headers.get('content-type')).toContain('text/html');
      expect(await homepage.text()).toContain('id="main"');
      expect((await fetch(`${base}/about/`)).status).toBe(200);
      expect((await fetch(`${base}/README.md`)).status).toBe(404);
      expect((await fetch(`${base}/%2e%2e/film.js`)).status).toBe(200); // URL normalization stays in the published root.
      expect((await fetch(`${base}/%2e%2e%2ffilm.js`)).status).toBe(404);
      expect((await fetch(`${base}/%zz`)).status).toBe(400);
      const range = await fetch(`${base}/media/clip.mp4`, { headers: { Range: 'bytes=2-5' } });
      expect(range.status).toBe(206);
      expect(range.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(await range.text()).toBe('2345');
      const suffix = await fetch(`${base}/media/clip.mp4`, { headers: { Range: 'bytes=-3' } });
      expect(await suffix.text()).toBe('789');
      expect(
        (await fetch(`${base}/media/clip.mp4`, { headers: { Range: 'bytes=20-30' } })).status,
      ).toBe(416);
      expect(
        (await fetch(`${base}/film.js`, { method: 'HEAD' })).headers.get('content-length'),
      ).not.toBe('0');
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
