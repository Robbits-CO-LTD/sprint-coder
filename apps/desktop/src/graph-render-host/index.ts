import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function run(): Promise<void> {
  // This entry is only forked by Main. Each invocation owns one fixed render/check operation.
  const [mode, kind, vendor, directory] = process.argv.slice(2);
  if (
    (mode !== 'render' && mode !== 'check') ||
    (kind !== 'architecture' && kind !== 'workflow') ||
    !vendor ||
    !directory
  )
    throw new Error('Invalid graph worker invocation');
  const root = resolve(vendor);
  const work = resolve(directory);
  const modulePath =
    mode === 'check'
      ? join(root, 'scripts', 'check-render-output.mjs')
      : join(root, 'renderers', kind, `render-${kind}.mjs`);
  process.argv =
    mode === 'check'
      ? [process.execPath, modulePath, join(work, 'diagram.html')]
      : [process.execPath, modulePath, join(work, 'input.json'), join(work, 'diagram.html')];
  await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
  process.exit(0);
}

void run().catch(() => {
  console.error('Graph worker failed');
  process.exit(1);
});
