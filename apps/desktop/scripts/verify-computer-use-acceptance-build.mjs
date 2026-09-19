#!/usr/bin/env node
// Verifies, on the produced package rather than on the build inputs, whether the Computer Use
// `windows-unsigned-acceptance` mode was compiled into Main. Release jobs run it with
// `--expect absent`; the acceptance build workflow runs it with `--expect present`.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const MARKER = 'sprint-coder-computer-use-acceptance-build-do-not-release';
const RECEIPT_NAME = 'computer-use-acceptance-build.json';
const MAIN_BUNDLE_ENTRY = join('.vite', 'build', 'index.js');

function fail(message) {
  console.error(`Computer Use acceptance build verification failed: ${message}`);
  process.exit(1);
}

function parseArguments(argv) {
  let expected = null;
  let root = resolve(dirname(process.argv[1] ?? '.'), '..', 'out');
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--expect') expected = argv[index + 1];
    else if (argv[index] === '--out') root = resolve(argv[index + 1] ?? '');
  }
  if (expected !== 'present' && expected !== 'absent')
    fail('--expect must be either "present" or "absent"');
  return { expected, root };
}

function findArchives(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.name === 'app.asar' && statSync(path).isFile()) found.push(path);
    else if (entry.isDirectory()) findArchives(path, found);
  }
  return found;
}

const { expected, root } = parseArguments(process.argv.slice(2));
if (!existsSync(root)) fail(`packaged output directory ${root} does not exist`);

let extractFile;
try {
  ({ extractFile } = await import('@electron/asar'));
} catch {
  fail('@electron/asar is unavailable, so the packaged Main bundle cannot be inspected');
}

const archives = findArchives(root);
if (archives.length === 0) fail(`no packaged app.asar was found under ${root}`);

for (const archive of archives) {
  const resources = dirname(archive);
  let main;
  try {
    main = extractFile(archive, MAIN_BUNDLE_ENTRY).toString('utf8');
  } catch {
    fail(`${archive} does not contain ${MAIN_BUNDLE_ENTRY}`);
  }
  const marked = main.includes(MARKER);
  const receipt = existsSync(join(resources, RECEIPT_NAME));
  if (marked !== receipt)
    fail(`${archive} disagrees with its receipt (main: ${marked}, receipt: ${receipt})`);
  if (marked !== (expected === 'present'))
    fail(
      expected === 'present'
        ? `${archive} was not built with the acceptance mode`
        : `${archive} was built with the acceptance mode and must not be published`,
    );
}

console.log(
  `Verified ${archives.length} packaged app.asar under ${root}: acceptance mode ${expected}.`,
);
