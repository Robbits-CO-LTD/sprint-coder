import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const nativeDirectory = join(__dirname, '../../computer-use-native');
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
const libraries = [
  'ole32.lib',
  'oleaut32.lib',
  'uiautomationcore.lib',
  'user32.lib',
  'uuid.lib',
  'shell32.lib',
];

function compileArguments(path: string, output: string): string[] {
  return [
    '/nologo',
    '/std:c++20',
    '/EHsc',
    '/W4',
    '/permissive-',
    '/utf-8',
    '/DUNICODE',
    '/D_UNICODE',
    '/DNOMINMAX',
    '/D_WIN32_WINNT=0x0A00',
    `/I${nativeDirectory}`,
    path,
    `/Fe:${output}`,
    `/Fo:${output}.obj`,
    '/link',
    '/DEBUG:NONE',
    ...libraries,
  ];
}

type Build = Readonly<{ name: string; file: string; args: string[]; verbatim: boolean }>;

function findBuild(path: string, output: string): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return {
      name: 'cl.exe',
      file: 'cl.exe',
      args: compileArguments(path, output),
      verbatim: false,
    };
  if (!existsSync(vswhere)) return null;
  const found = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8' },
  );
  const root = found.stdout.trim();
  const vcvars = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (found.status !== 0 || root === '' || !existsSync(vcvars)) return null;
  return {
    name: 'cl.exe (vcvars64)',
    file: 'cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      `"call "${vcvars}" >nul && cl.exe ${compileArguments(path, output)
        .map((argument) => `"${argument}"`)
        .join(' ')}"`,
    ],
    verbatim: true,
  };
}

type Probe = Readonly<{ status: number | null; output: string; facts: Map<string, string> }>;

// MSVC and OS calls belong to the parent verification run, outside the implementation sandbox.
describe.skipIf(process.platform !== 'win32')('Windows association / selection seam', () => {
  let scratch = '';
  let binary = '';
  const probe = (...args: string[]): Probe => {
    const run = spawnSync(binary, args, { encoding: 'utf8', timeout: 30_000 });
    const facts = new Map<string, string>();
    for (const line of run.stdout.split(/\r?\n/u)) {
      const equals = line.indexOf('=');
      if (equals > 0) facts.set(line.slice(0, equals), line.slice(equals + 1));
    }
    return { status: run.status, output: run.stdout + run.stderr, facts };
  };

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'computer-use-association-seam-'));
    binary = join(scratch, 'seam.exe');
    const compiler = findBuild(
      join(nativeDirectory, 'computer_use_windows_association_seam.cc'),
      binary,
    );
    expect(compiler, 'MSVC is required; a missing compiler is not a passing seam').not.toBeNull();
    const built = spawnSync(compiler!.file, compiler!.args, {
      encoding: 'utf8',
      cwd: scratch,
      windowsVerbatimArguments: compiler!.verbatim,
      timeout: 180_000,
      env: { ...process.env, VSLANG: '1033' },
    });
    expect(built.status, built.stdout + built.stderr).toBe(0);
  }, 240_000);

  afterAll(() => {
    if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
  });

  it('runs the portable negative matrix and the OS failure / cancellation boundaries', () => {
    const run = probe();
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('OK');
  });

  it('takes the extension from the resolved real path, never from the display spelling', () => {
    // A right-to-left override shows "report-exe.txt"; the real extension is exe.
    const spoof = join(scratch, 'report-\u202etxt.exe');
    writeFileSync(spoof, '');
    const rlo = probe('association', spoof, 'blocked');
    expect(rlo.status, rlo.output).toBe(0);
    expect(rlo.facts.get('real_path_verified')).toBe('1');
    expect(rlo.facts.get('extension')).toBe('exe');
    expect(rlo.facts.get('real_path')).toBe(`\\\\?\\${realpathSync.native(spoof)}`);
    // Windows runs "setup.exe." as setup.exe: the trailing dot does not hide the extension.
    const dotted = `\\\\?\\${realpathSync.native(scratch)}\\setup.exe.`;
    writeFileSync(dotted, '');
    const trailing = probe('association', dotted, 'blocked');
    expect(trailing.status, trailing.output).toBe(0);
    expect(trailing.facts.get('extension')).toBe('exe');
  });

  it('resolves a junction to the file itself, with the same file id as the direct path', () => {
    const target = join(scratch, 'target');
    const link = join(scratch, 'link');
    mkdirSync(target);
    writeFileSync(join(target, 'document.txt'), '');
    symlinkSync(target, link, 'junction');
    const direct = probe('identity', join(target, 'document.txt'));
    const through = probe('identity', join(link, 'document.txt'));
    expect(direct.status, direct.output).toBe(0);
    expect(through.status, through.output).toBe(0);
    const real = realpathSync.native(join(target, 'document.txt'));
    expect(direct.facts.get('real_path')).toBe(`\\\\?\\${real}`);
    expect(direct.facts.get('canonical')).toBe(real);
    expect(through.facts.get('canonical')).toBe(real);
    expect(through.facts.get('canonical')).not.toBe(join(link, 'document.txt'));
    expect(through.facts.get('file_id')).toMatch(/^[0-9a-f]{16}:[0-9a-f]{32}$/u);
    expect(through.facts.get('file_id')).toBe(direct.facts.get('file_id'));
  });

  it('reads a temporary HKCU association and takes over on every non-static handler', () => {
    const extension = `scgt991x${process.pid}`;
    const progId = `ScgT991.Document${process.pid}`;
    const classes = 'HKCU\\Software\\Classes';
    const command = '"C:\\Windows\\System32\\notepad.exe" "%1"';
    const reg = (...args: string[]): number | null =>
      spawnSync('reg.exe', args, { encoding: 'utf8', timeout: 30_000 }).status;
    const keys = [`${classes}\\.${extension}`, `${classes}\\${progId}`];
    const file = join(scratch, `document.${extension}`);
    writeFileSync(file, '');
    let failure: unknown = null;
    try {
      expect(reg('add', keys[0]!, '/ve', '/d', progId, '/f')).toBe(0);
      expect(reg('add', keys[0]!, '/v', 'PerceivedType', '/d', 'text', '/f')).toBe(0);
      expect(reg('add', `${keys[1]}\\shell`, '/ve', '/d', 'open', '/f')).toBe(0);
      expect(reg('add', `${keys[1]}\\shell\\open\\command`, '/ve', '/d', command, '/f')).toBe(0);
      const plain = probe('association', file, 'takeover');
      expect(plain.status, plain.output).toBe(0);
      expect(plain.facts.get('real_path_verified')).toBe('1');
      expect(plain.facts.get('file_id_known')).toBe('1');
      expect(plain.facts.get('extension')).toBe(extension);
      expect(plain.facts.get('perceived_type')).toBe('text');
      expect(plain.facts.get('prog_id')).toBe(progId);
      expect(plain.facts.get('verb')).toBe('open');
      expect(plain.facts.get('command_key_matches')).toBe('1');
      for (const name of [
        'delegate_execute',
        'drop_target',
        'explorer_command_handler',
        'dde',
        'shell_extension',
      ])
        expect(plain.facts.get(name), name).toBe('0');
      const flagged: ReadonlyArray<readonly [string, string[]]> = [
        [
          'delegate_execute',
          [
            'add',
            `${keys[1]}\\shell\\open\\command`,
            '/v',
            'DelegateExecute',
            '/d',
            '{00000000-0000-0000-0000-000000000991}',
            '/f',
          ],
        ],
        [
          'explorer_command_handler',
          [
            'add',
            `${keys[1]}\\shell\\open`,
            '/v',
            'ExplorerCommandHandler',
            '/d',
            '{00000000-0000-0000-0000-000000000992}',
            '/f',
          ],
        ],
        [
          'drop_target',
          [
            'add',
            `${keys[1]}\\shell\\open\\DropTarget`,
            '/v',
            'CLSID',
            '/d',
            '{00000000-0000-0000-0000-000000000993}',
            '/f',
          ],
        ],
        ['dde', ['add', `${keys[1]}\\shell\\open\\ddeexec`, '/ve', '/d', '[open("%1")]', '/f']],
        [
          'shell_extension',
          [
            'add',
            `${keys[1]}\\shellex\\ContextMenuHandlers\\Synthetic`,
            '/ve',
            '/d',
            '{00000000-0000-0000-0000-000000000994}',
            '/f',
          ],
        ],
      ];
      for (const [name, args] of flagged) {
        expect(reg(...args), name).toBe(0);
        const flaggedProbe = probe('association', file, 'takeover');
        expect(flaggedProbe.status, flaggedProbe.output).toBe(0);
        expect(flaggedProbe.facts.get(name), name).toBe('1');
      }
      const unknown = join(scratch, `document.scgu991x${process.pid}`);
      writeFileSync(unknown, '');
      const unregistered = probe('association', unknown, 'takeover');
      expect(unregistered.status, unregistered.output).toBe(0);
      expect(unregistered.facts.get('prog_id')).toBe('');
    } catch (error) {
      failure = error;
    } finally {
      // The temporary association must be gone; a key that cannot be removed fails the test.
      for (const key of keys) {
        reg('delete', key, '/f');
        if (reg('query', key) !== 1) failure ??= new Error(`HKCU key left behind: ${key}`);
      }
    }
    if (failure !== null) throw failure;
  });
});
