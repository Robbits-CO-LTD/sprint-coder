import { basename, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith('--') || value === undefined) fail('Arguments must be --name value pairs');
  options.set(name.slice(2), value);
}

const version = required('version');
const tag = required('tag');
const repository = required('repository');
const zipPath = required('zip');
const outputPath = required('output');
if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) fail(`Invalid version: ${version}`);
if (tag !== `v${version}`) fail(`Tag ${tag} does not match version ${version}`);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
  fail(`Invalid GitHub repository: ${repository}`);

const zipName = basename(zipPath);
if (!zipName.includes(`darwin-`) || !zipName.includes(version) || !zipName.endsWith('.zip'))
  fail(`Not a versioned macOS ZIP: ${zipName}`);

const assetUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(zipName)}`;
const publishedAt = new Date().toISOString();
const manifest = {
  currentRelease: version,
  releases: [
    {
      version,
      updateTo: {
        version,
        pub_date: publishedAt,
        name: `Sprint Coder ${version}`,
        url: assetUrl,
      },
    },
  ],
};

writeFileSync(resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

function required(name) {
  const value = options.get(name);
  if (value === undefined || value.length === 0) fail(`Missing --${name}`);
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
