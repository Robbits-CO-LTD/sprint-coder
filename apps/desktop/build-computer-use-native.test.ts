import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = join(__dirname, '../../build-computer-use-native.mjs');
const addon = 'sprint_coder_computer_use_windows_main.node';
const native = 'sprint_coder_computer_use_native.node';
const helper = 'sprint-coder-computer-use-host.exe';
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

// Execute the real script with compiler/process and filesystem boundaries replaced, never MSVC.
function build(platform: 'win32' | 'darwin', omitAddon = false) {
  const output = join(__dirname, 'computer-use-native/build/Release');
  const files = new Map<string, string>();
  const commands: string[][] = [];
  const source = readFileSync(script, 'utf8')
    .replace(/^import [\s\S]*? from '[^']+';\r?\n/gmu, '')
    .replace(/^export \{[^}]+\} from '[^']+';\r?\n/gmu, '')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(script).href));
  runInNewContext(source, {
    createHash,
    dirname,
    join,
    fileURLToPath,
    createRequire: () => ({ resolve: (name: string) => name }),
    readFileSync: (path: string) =>
      path === 'electron/package.json' ? JSON.stringify({ version: '43.5.0' }) : files.get(path),
    existsSync: (path: string) => files.has(path),
    statSync: (path: string) => ({ isFile: () => files.has(path), size: files.get(path)?.length }),
    mkdirSync: () => {},
    writeFileSync: (path: string, bytes: string) => files.set(path, bytes),
    spawnSync: (command: string, args: string[]) => {
      if (command === 'git') return { status: 0, stdout: 'a'.repeat(40) };
      commands.push([command, ...args]);
      if (args.includes('rebuild')) {
        files.clear(); // node-gyp really removes the output directory.
        if (!omitAddon) files.set(join(output, platform === 'win32' ? addon : native), 'addon');
      }
      if (command === 'cl.exe') files.set(join(output, helper), 'helper');
      return { status: 0 };
    },
    process: { platform, arch: 'x64', argv: [], env: {}, execPath: 'node' },
    console: { log: () => {} },
    sanitizedNativeBuildEnvironment: (env: unknown) => env,
    nativeBuildFailureDetail: () => 'failed',
    parseEligibilityMode: () => 'v1',
    nativeAcceptanceBuildHeader: () => '',
    eligibilityDeclaration: () => undefined,
    eligibilityBuildHeader: () => '',
    windowsDocumentViewerDeclaration: () => ({}),
  });
  return {
    commands,
    files,
    output,
    manifest: JSON.parse(files.get(join(output, 'computer-use-native.manifest.json'))!),
  };
}

describe('build-computer-use-native Main addon', () => {
  it('builds the binding.gyp target before the helper and records both output digests', () => {
    const result = build('win32');
    expect(result.commands[0]).toContain('rebuild');
    expect(result.commands[1]?.[0]).toBe('cl.exe');
    expect(result.files.has(join(result.output, addon))).toBe(true);
    expect(result.files.has(join(result.output, helper))).toBe(true);
    expect(result.manifest.windowsMainAddon).toEqual({
      kind: 'windows-main-addon',
      file: addon,
      sha256: digest('addon'),
    });
    expect(result.manifest.binaryDigest).toBe(digest('helper'));
    const binding = JSON.parse(
      readFileSync(join(__dirname, 'computer-use-native/binding.gyp'), 'utf8'),
    );
    expect(binding.targets[0]).toMatchObject({
      target_name: addon.slice(0, -5),
      sources: ['computer_use_windows_main.cc'],
    });
  });
  it('fails when node-gyp does not produce the Main addon', () => {
    expect(() => build('win32', true)).toThrow('Windows Main N-API module was not produced');
  });
  it('preserves the macOS single-addon build and manifest', () => {
    const result = build('darwin');
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toContain('rebuild');
    expect(result.files.has(join(result.output, native))).toBe(true);
    expect(result.manifest.windowsMainAddon).toBeUndefined();
    expect(result.manifest.moduleDigest).toBe(digest('addon'));
  });
});
