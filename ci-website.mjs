import { spawnSync } from 'node:child_process';
import { createReadStream, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

// parse5 is a declared desktop dependency; resolve from that workspace even without hoisting.
const desktopRequire = createRequire(new URL('./apps/desktop/package.json', import.meta.url));
const { parse } = await import(pathToFileURL(desktopRequire.resolve('parse5')).href);
const repository = dirname(fileURLToPath(import.meta.url));
const siteOrigin = 'https://sprintcoder.yuseilab.com';
const maxFileBytes = 25 * 1024 * 1024;
const referenceAttributes = new Set(['href', 'src', 'data-src', 'poster', 'data-poster']);

function routeFor(file) {
  return `/${file}`.replace(/\/index\.html$/u, '/');
}

function sourceSetUrls(value) {
  const urls = [];
  let rest = value;
  while (rest) {
    rest = rest.replace(/^[\s,]+/u, '');
    if (!rest) break;
    const url = /^\S+/u.exec(rest)[0];
    rest = rest.slice(url.length);
    urls.push(url.replace(/,+$/u, ''));
    // A trailing comma ends a candidate without descriptors; commas inside data URLs stay intact.
    if (url.endsWith(',')) continue;
    let parentheses = 0;
    let index = 0;
    for (; index < rest.length; index++) {
      if (rest[index] === '(') parentheses++;
      else if (rest[index] === ')') parentheses--;
      else if (rest[index] === ',' && parentheses === 0) break;
    }
    rest = rest.slice(index + 1);
  }
  return urls;
}

function checkJavaScript(source, label, module, errors) {
  try {
    if (module) {
      const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
    } else new Script(source, { filename: label });
  } catch (error) {
    errors.push(`${label}: invalid JavaScript (${error.message})`);
  }
}

/** Validate the files deploy/website/deploy.sh publishes, without fetching external URLs. */
export function checkWebsite(directory = join(repository, 'website')) {
  const root = resolve(directory);
  const errors = [];
  const files = new Set();
  const references = [];
  const anchors = new Map();
  const modules = new Set();
  function visit(relative = '') {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (file === 'tools' || file === 'README.md') continue;
      const stat = lstatSync(join(root, file));
      if (stat.isDirectory()) visit(file);
      else if (!stat.isFile()) errors.push(`${file}: not a regular file (links are not published)`);
      else {
        files.add(file);
        if (stat.size >= maxFileBytes) errors.push(`${file}: reaches the 25 MiB publishing limit`);
      }
    }
  }
  visit();
  for (const file of ['index.html', 'styles.css', 'film.js'])
    if (!files.has(file)) errors.push(`${file}: required publishing file is missing`);

  function reference(file, value, fragment = false) {
    let url;
    try {
      url = new URL(value, `${siteOrigin}${routeFor(file)}`);
    } catch {
      errors.push(`${file}: invalid URL ${value}`);
      return;
    }
    if (url.origin !== siteOrigin) return;
    try {
      const path = decodeURIComponent(url.pathname);
      if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..'))
        throw new Error('unsafe URL path');
      const target = path.slice(1) + (path.endsWith('/') ? 'index.html' : '');
      references.push({
        file,
        value,
        target,
        hash: fragment ? decodeURIComponent(url.hash.slice(1)) : '',
      });
      return target;
    } catch {
      errors.push(`${file}: invalid local URL ${value}`);
    }
  }

  const htmlFiles = [...files].filter((file) => file.endsWith('.html')).sort();
  for (const file of htmlFiles) {
    const ids = new Set();
    anchors.set(file, ids);
    const document = parse(readFileSync(join(root, file), 'utf8'), {
      onParseError: (error) =>
        errors.push(`${file}:${error.startLine}: invalid HTML (${error.code})`),
    });
    function walk(node) {
      const attrs = Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value]));
      if (attrs.id) {
        if (ids.has(attrs.id)) errors.push(`${file}: duplicate id ${attrs.id}`);
        ids.add(attrs.id);
      }
      if (node.tagName === 'a' && attrs.name) ids.add(attrs.name);
      for (const [name, value] of Object.entries(attrs))
        if (referenceAttributes.has(name))
          reference(file, value, node.tagName === 'a' && name === 'href');
      for (const name of ['srcset', 'imagesrcset'])
        if (attrs[name]) for (const url of sourceSetUrls(attrs[name])) reference(file, url);
      if (
        node.tagName === 'meta' &&
        /^(?:og:(?:image|video|url)|twitter:image)$/u.test(attrs.property ?? attrs.name ?? '')
      )
        reference(file, attrs.content ?? '');
      if (node.tagName === 'script') {
        const type = (attrs.type ?? '').trim().toLowerCase();
        const source = (node.childNodes ?? []).map((child) => child.value ?? '').join('');
        if (type === 'application/ld+json') {
          try {
            JSON.parse(source);
          } catch {
            errors.push(`${file}: invalid JSON-LD`);
          }
        } else if (['', 'module', 'text/javascript', 'application/javascript'].includes(type)) {
          if (!attrs.src)
            checkJavaScript(source, `${file} inline script`, type === 'module', errors);
          else if (type === 'module') {
            const target = reference(file, attrs.src);
            if (target) modules.add(target);
          }
        }
      }
      for (const child of node.childNodes ?? []) walk(child);
      if (node.content) walk(node.content);
    }
    walk(document);
  }
  for (const file of files) {
    if (/\.(?:js|mjs|cjs)$/u.test(file))
      checkJavaScript(
        readFileSync(join(root, file), 'utf8'),
        file,
        file.endsWith('.mjs') || modules.has(file),
        errors,
      );
    if (file.endsWith('.css')) {
      const css = readFileSync(join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
      for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/giu))
        reference(file, match[1] ?? match[2] ?? match[3]);
      for (const match of css.matchAll(/@import\s+["']([^"']+)["']/giu)) reference(file, match[1]);
    }
  }
  for (const { file, value, target, hash } of references) {
    if (!files.has(target)) errors.push(`${file}: missing local reference ${value}`);
    else if (hash && anchors.has(target) && !anchors.get(target).has(hash))
      errors.push(`${file}: missing fragment ${value}`);
  }
  if (errors.length)
    throw new Error(`Website validation failed:\n${[...new Set(errors)].join('\n')}`);
  return { root, files: [...files].sort(), routes: htmlFiles.map(routeFor) };
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
};

/** A loopback-only server for the same validated publication set, including video byte ranges. */
export function createWebsiteServer(directory) {
  const { root, files } = checkWebsite(directory);
  const published = new Set(files);
  return createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    let file;
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      file = path.slice(1) + (path.endsWith('/') ? 'index.html' : '');
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (!published.has(file)) {
      response.writeHead(404).end();
      return;
    }
    const absolute = join(root, file);
    const { size } = lstatSync(absolute);
    let start = 0;
    let end = size - 1;
    const headers = {
      'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    };
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      } else start = size;
      if (start > end || start < 0 || start >= size) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = String(Math.max(0, end - start + 1));
    response.writeHead(request.headers.range ? 206 : 200, headers);
    if (request.method === 'HEAD' || size === 0) {
      response.end();
      return;
    }
    const stream = createReadStream(absolute, { start, end });
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'check') {
      const result = checkWebsite();
      console.log(
        `Website static checks passed: ${result.routes.length} pages, ${result.files.length} published files`,
      );
    } else if (process.argv[2] === 'serve') {
      const port = Number(process.env.WEBSITE_TEST_PORT ?? '4175');
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('Invalid WEBSITE_TEST_PORT');
      const server = createWebsiteServer();
      server.on('error', (error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
      server.listen(port, '127.0.0.1', () =>
        console.log(`Website test server: http://127.0.0.1:${port}`),
      );
    } else throw new Error('Usage: node ci-website.mjs check|serve');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
