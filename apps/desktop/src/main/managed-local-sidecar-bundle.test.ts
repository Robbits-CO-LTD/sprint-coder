import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadBundledManagedLocalSidecar,
  managedLocalSidecarBundleRoot,
  managedLocalTargetKey,
  verifyManagedLocalSidecarBundle,
  type ManagedLocalArchitecture,
  type ManagedLocalPlatform,
  type ManagedLocalSidecarManifest,
  type ManagedLocalSidecarPin,
  type ManagedLocalTargetKey,
} from './managed-local-sidecar-bundle';

const roots: string[] = [];
const hostTarget = requiredHostTarget();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(target: ManagedLocalTargetKey = hostTarget): Promise<{
  root: string;
  serverPath: string;
  manifestPath: string;
  manifest: ManagedLocalSidecarManifest;
  pin: ManagedLocalSidecarPin;
}> {
  const [platform, architecture] = target.split('-') as [
    ManagedLocalPlatform,
    ManagedLocalArchitecture,
  ];
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sprint-coder-managed-local-')));
  roots.push(root);
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'licenses'));
  const serverName = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const serverPath = join(root, 'bin', serverName);
  const licensePath = join(root, 'licenses', 'llama.cpp-LICENSE');
  const serverBytes = Buffer.from('deterministic llama-server fixture');
  const licenseBytes = Buffer.from('MIT license fixture');
  await writeFile(serverPath, serverBytes, { mode: 0o700 });
  await chmod(serverPath, 0o700);
  await writeFile(licensePath, licenseBytes, { mode: 0o600 });
  const manifest: ManagedLocalSidecarManifest = {
    schemaVersion: 1,
    runtime: 'llama.cpp',
    runtimeVersion: 'b9999-test',
    upstreamRepository: 'https://github.com/ggml-org/llama.cpp',
    upstreamRevision: 'a'.repeat(40),
    platform,
    architecture,
    candidateBackends: platform === 'darwin' ? ['cpu', 'metal'] : ['cpu'],
    artifacts: [
      {
        role: 'server',
        path: `bin/${serverName}`,
        sha256: sha256(serverBytes),
        byteLength: serverBytes.byteLength,
      },
      {
        role: 'license',
        path: 'licenses/llama.cpp-LICENSE',
        sha256: sha256(licenseBytes),
        byteLength: licenseBytes.byteLength,
      },
    ],
  };
  const manifestPath = join(root, 'managed-local-manifest.json');
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  return {
    root,
    serverPath,
    manifestPath,
    manifest,
    pin: {
      target,
      runtimeVersion: manifest.runtimeVersion,
      upstreamRevision: manifest.upstreamRevision,
      manifestSha256: sha256(manifestBytes),
    },
  };
}

describe('Managed Local sidecar bundle boundary', () => {
  it('accepts only a complete bundle whose manifest and every artifact match the application pin', async () => {
    const env = await fixture();

    const verified = await verifyManagedLocalSidecarBundle(env.root, env.pin);

    expect(verified).toMatchObject({
      target: hostTarget,
      rootPath: env.root,
      manifestSha256: env.pin.manifestSha256,
      serverPath: env.serverPath,
      manifest: {
        runtime: 'llama.cpp',
        runtimeVersion: 'b9999-test',
        candidateBackends: env.manifest.candidateBackends,
      },
    });
    expect(verified.licensePath).toBe(join(env.root, 'licenses', 'llama.cpp-LICENSE'));
    expect(Object.keys(verified.artifactPaths)).toEqual([
      env.manifest.artifacts.find((artifact) => artifact.role === 'server')!.path,
      'licenses/llama.cpp-LICENSE',
    ]);
  });

  it('fails before filesystem lookup when the current target has no compiled application pin', async () => {
    await expect(
      loadBundledManagedLocalSidecar({
        rootPath: '/path/must/not/be/read',
        pins: {},
      }),
    ).rejects.toMatchObject({ code: 'unsupported_target' });
  });

  it('loads an injected target pin without consulting PATH or environment overrides', async () => {
    const env = await fixture();

    const verified = await loadBundledManagedLocalSidecar({
      rootPath: env.root,
      pins: { [hostTarget]: env.pin },
    });

    expect(verified.target).toBe(hostTarget);
    expect(verified.serverPath).toBe(env.serverPath);
  });

  it('rejects a correctly pinned bundle for a different native target before reading it', async () => {
    const otherTarget: ManagedLocalTargetKey = hostTarget.startsWith('darwin-')
      ? 'linux-x64'
      : 'darwin-arm64';
    const env = await fixture(otherTarget);
    await rm(env.root, { recursive: true, force: true });

    await expect(verifyManagedLocalSidecarBundle(env.root, env.pin)).rejects.toMatchObject({
      code: 'unsupported_target',
    });
  });

  it('rejects a changed manifest even when the modified JSON remains valid', async () => {
    const env = await fixture();
    await writeFile(
      env.manifestPath,
      `${JSON.stringify({ ...env.manifest, runtimeVersion: 'b10000-tampered' }, null, 2)}\n`,
    );

    await expect(verifyManagedLocalSidecarBundle(env.root, env.pin)).rejects.toMatchObject({
      code: 'manifest_mismatch',
    });
  });

  it('rejects schema-valid manifest identity that differs from its application pin', async () => {
    const env = await fixture();
    const mismatchedPin = { ...env.pin, runtimeVersion: 'b10000-other' };

    await expect(verifyManagedLocalSidecarBundle(env.root, mismatchedPin)).rejects.toMatchObject({
      code: 'manifest_mismatch',
    });
  });

  it('requires a CPU fallback and exactly one server and license', async () => {
    const env = await fixture();
    const invalid = {
      ...env.manifest,
      candidateBackends: ['metal'],
      artifacts: env.manifest.artifacts.filter((artifact) => artifact.role !== 'license'),
    };
    const bytes = Buffer.from(`${JSON.stringify(invalid, null, 2)}\n`);
    await writeFile(env.manifestPath, bytes);

    await expect(
      verifyManagedLocalSidecarBundle(env.root, {
        ...env.pin,
        manifestSha256: sha256(bytes),
      }),
    ).rejects.toMatchObject({ code: 'invalid_manifest' });
  });

  it('rejects traversal and undeclared backend paths even when the manifest digest is repinned', async () => {
    const env = await fixture();
    const invalid = {
      ...env.manifest,
      artifacts: env.manifest.artifacts.map((artifact) =>
        artifact.role === 'server'
          ? { ...artifact, path: '../outside/llama-server', backend: 'cuda' }
          : artifact,
      ),
    };
    const bytes = Buffer.from(`${JSON.stringify(invalid, null, 2)}\n`);
    await writeFile(env.manifestPath, bytes);

    await expect(
      verifyManagedLocalSidecarBundle(env.root, {
        ...env.pin,
        manifestSha256: sha256(bytes),
      }),
    ).rejects.toMatchObject({ code: 'invalid_manifest' });
  });

  it('rejects artifact byte, size, and hardlink changes after the manifest was pinned', async () => {
    const tampered = await fixture();
    await writeFile(tampered.serverPath, 'different bytes', { mode: 0o700 });
    await expect(
      verifyManagedLocalSidecarBundle(tampered.root, tampered.pin),
    ).rejects.toMatchObject({ code: 'artifact_mismatch' });

    const linked = await fixture();
    await link(linked.serverPath, join(linked.root, 'server-hardlink'));
    await expect(verifyManagedLocalSidecarBundle(linked.root, linked.pin)).rejects.toMatchObject({
      code: 'artifact_mismatch',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symlinked bundle roots, parent directories, and non-executable servers',
    async () => {
      const rootLink = await fixture();
      const alias = `${rootLink.root}-alias`;
      roots.push(alias);
      await symlink(rootLink.root, alias, 'dir');
      await expect(verifyManagedLocalSidecarBundle(alias, rootLink.pin)).rejects.toMatchObject({
        code: 'unsafe_bundle',
      });

      const parentLink = await fixture();
      await rename(join(parentLink.root, 'bin'), join(parentLink.root, 'real-bin'));
      await symlink('real-bin', join(parentLink.root, 'bin'), 'dir');
      await expect(
        verifyManagedLocalSidecarBundle(parentLink.root, parentLink.pin),
      ).rejects.toMatchObject({ code: 'unsafe_bundle' });

      const artifactLink = await fixture();
      const realServer = `${artifactLink.serverPath}.real`;
      await rename(artifactLink.serverPath, realServer);
      await symlink('llama-server.real', artifactLink.serverPath, 'file');
      await expect(
        verifyManagedLocalSidecarBundle(artifactLink.root, artifactLink.pin),
      ).rejects.toMatchObject({ code: 'unsafe_bundle' });

      const notExecutable = await fixture();
      await chmod(notExecutable.serverPath, 0o600);
      await expect(
        verifyManagedLocalSidecarBundle(notExecutable.root, notExecutable.pin),
      ).rejects.toMatchObject({ code: 'artifact_mismatch' });
    },
  );

  it('uses only the packaged Resources root or the fixed development build directory', () => {
    expect(
      managedLocalSidecarBundleRoot({
        target: 'win32-x64',
        packaged: true,
        resourcesPath: 'C:\\SprintCoder\\resources',
      }),
    ).toContain(join('resources', 'managed-local', 'win32-x64'));
    expect(
      managedLocalSidecarBundleRoot({
        target: 'linux-arm64',
        packaged: false,
        moduleDirectory: '/repo/apps/desktop/.vite/build',
      }),
    ).toBe(
      join('/repo/apps/desktop/.vite/build', '..', '..', 'managed-local', 'build', 'linux-arm64'),
    );
    expect(managedLocalTargetKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(managedLocalTargetKey('freebsd', 'x64')).toBeNull();
  });
});

function sha256(value: NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(value).digest('hex');
}

function requiredHostTarget(): ManagedLocalTargetKey {
  const target = managedLocalTargetKey();
  if (target === null) throw new Error('Managed Local tests require a supported native host');
  return target;
}
