import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPackageArtifact,
  restorePackageArtifact,
  validateReceipt,
} from '../../ci-windows-package.mjs';

const cleanup = [];
afterEach(() =>
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-windows-package-'));
  cleanup.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=CI fixture',
      '-c',
      'user.email=ci@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ],
    { cwd: root },
  );
  const output = join(root, 'apps/desktop/out/Sprint Coder-win32-x64');
  mkdirSync(join(output, 'resources'), { recursive: true });
  mkdirSync(join(root, 'node_modules/electron'), { recursive: true });
  writeFileSync(join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(
    join(root, 'node_modules/electron/package.json'),
    JSON.stringify({ version: '43.5.0' }),
  );
  writeFileSync(join(output, 'Sprint Coder.exe'), 'fixture executable');
  writeFileSync(join(output, 'resources/app.asar'), 'fixture asar');
  return { root, output, artifact: join(root, 'artifact') };
}

describe('same-run Windows package transfer', () => {
  it('restores the original producer package during a consumer-only rerun', async () => {
    const { root, output, artifact } = fixture();
    const outputs = await createPackageArtifact(root, artifact, {
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
    });
    expect(outputs.artifact).toMatch(/^windows-package-123-1-[a-f0-9]{40}$/u);
    rmSync(output, { recursive: true });
    const executable = await restorePackageArtifact(root, artifact, outputs.archive_sha256);
    expect(readFileSync(executable, 'utf8')).toBe('fixture executable');
    expect(readFileSync(join(output, 'resources/app.asar'), 'utf8')).toBe('fixture asar');
    await expect(restorePackageArtifact(root, artifact, outputs.archive_sha256)).rejects.toThrow(
      'already exists',
    );
  });

  it('rejects an archive changed after the producer sealed it', async () => {
    const { root, output, artifact } = fixture();
    const outputs = await createPackageArtifact(root, artifact, {
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
    });
    rmSync(output, { recursive: true });
    appendFileSync(join(artifact, 'windows-package.tar.gz'), 'changed');
    await expect(restorePackageArtifact(root, artifact, outputs.archive_sha256)).rejects.toThrow(
      'digest mismatch',
    );
  });

  it('rejects a package produced from a different commit or dependency version', async () => {
    const { root, output, artifact } = fixture();
    const outputs = await createPackageArtifact(root, artifact, {
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
    });
    rmSync(output, { recursive: true });
    writeFileSync(
      join(root, 'node_modules/electron/package.json'),
      JSON.stringify({ version: '44.0.0' }),
    );
    await expect(restorePackageArtifact(root, artifact, outputs.archive_sha256)).rejects.toThrow(
      'identity',
    );
    writeFileSync(
      join(root, 'node_modules/electron/package.json'),
      JSON.stringify({ version: '43.5.0' }),
    );
    execFileSync(
      'git',
      [
        '-c',
        'user.name=CI fixture',
        '-c',
        'user.email=ci@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-qm',
        'different checkout',
      ],
      { cwd: root },
    );
    await expect(restorePackageArtifact(root, artifact, outputs.archive_sha256)).rejects.toThrow(
      'identity',
    );
  });

  it('rejects missing producer identity and incomplete package output', async () => {
    const { root, output, artifact } = fixture();
    expect(() => validateReceipt({}, {}, undefined)).toThrow('identity');
    await expect(
      createPackageArtifact(root, artifact, { GITHUB_RUN_ID: 'bad', GITHUB_RUN_ATTEMPT: '1' }),
    ).rejects.toThrow('GITHUB_RUN_ID');
    rmSync(join(output, 'resources/app.asar'));
    await expect(
      createPackageArtifact(root, artifact, { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }),
    ).rejects.toThrow();
  });
});
