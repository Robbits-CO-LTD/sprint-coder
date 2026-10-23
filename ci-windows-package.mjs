import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const packageDirectory = 'Sprint Coder-win32-x64';
const archiveName = 'windows-package.tar.gz';
const receiptName = 'windows-package.json';

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function identity(root) {
  const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error('Invalid package source SHA');
  const desktop = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'));
  const electron = JSON.parse(
    readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'),
  );
  return {
    sha,
    platform: 'win32',
    arch: 'x64',
    version: desktop.version,
    electron: electron.version,
    node: process.versions.node,
  };
}

function verifyFiles(root) {
  const directory = join(root, 'apps/desktop/out', packageDirectory);
  for (const relative of ['Sprint Coder.exe', 'resources/app.asar']) {
    const stat = lstatSync(join(directory, relative));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Missing regular packaged file: ${relative}`);
  }
  return join(directory, 'Sprint Coder.exe');
}

export function validateReceipt(receipt, expected, expectedDigest) {
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    !/^[a-f0-9]{64}$/u.test(expectedDigest ?? '') ||
    receipt.archiveSha256 !== expectedDigest ||
    receipt.packageDirectory !== packageDirectory ||
    Object.entries(expected).some(([key, value]) => receipt[key] !== value)
  )
    throw new Error('Windows package identity does not match this checkout and producer');
}

export async function createPackageArtifact(root, directory, environment = process.env) {
  const expected = identity(root);
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])
    if (!/^\d+$/u.test(environment[key] ?? '')) throw new Error(`Invalid ${key}`);
  verifyFiles(root);
  mkdirSync(directory, { recursive: true });
  const archive = join(directory, archiveName);
  execFileSync('tar', ['-czf', archive, '-C', join(root, 'apps/desktop/out'), packageDirectory], {
    stdio: 'inherit',
  });
  const archiveSha256 = await digest(archive);
  writeFileSync(
    join(directory, receiptName),
    `${JSON.stringify({ ...expected, packageDirectory, archiveSha256 })}\n`,
  );
  return {
    artifact: `windows-package-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}-${expected.sha}`,
    archive_sha256: archiveSha256,
  };
}

export async function restorePackageArtifact(root, directory, expectedDigest) {
  const receipt = JSON.parse(readFileSync(join(directory, receiptName), 'utf8'));
  validateReceipt(receipt, identity(root), expectedDigest);
  const archive = join(directory, archiveName);
  if ((await digest(archive)) !== expectedDigest)
    throw new Error('Windows package archive digest mismatch');
  const entries = execFileSync('tar', ['-tf', archive], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
    .trim()
    .split(/\r?\n/u);
  if (
    !entries.length ||
    entries.some(
      (entry) => !entry.startsWith(`${packageDirectory}/`) || entry.split(/[\\/]/u).includes('..'),
    )
  )
    throw new Error('Unexpected Windows package archive paths');
  const output = join(root, 'apps/desktop/out');
  if (existsSync(join(output, packageDirectory)))
    throw new Error('Windows package destination already exists');
  mkdirSync(output, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', output], { stdio: 'inherit' });
  return verifyFiles(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64')
      throw new Error('Windows x64 runner required');
    const root = process.cwd();
    const directory = resolve(process.env.RUNNER_TEMP, 'ci-windows-package');
    if (process.argv[2] === 'create') {
      const outputs = await createPackageArtifact(root, directory);
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(outputs)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(''),
      );
    } else if (process.argv[2] === 'restore') {
      const executable = await restorePackageArtifact(
        root,
        directory,
        process.env.CI_WINDOWS_PACKAGE_SHA256,
      );
      if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required');
      appendFileSync(process.env.GITHUB_ENV, `SPRINT_CODER_E2E_EXECUTABLE_PATH=${executable}\n`);
    } else throw new Error('Usage: node ci-windows-package.mjs create|restore');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
