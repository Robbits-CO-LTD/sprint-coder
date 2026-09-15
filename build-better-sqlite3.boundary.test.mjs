import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { sanitizedNativeBuildEnvironment } from './native-build-environment.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const target = resolve(root, 'build-better-sqlite3.mjs');
const canary = 'CONTROLLED_TEST_CANARY_NOT_A_CREDENTIAL';
const environment = Object.freeze({
  PATH: '/controlled/compiler-path',
  HOME: '/controlled/home',
  INCLUDE: 'C:\\controlled-sdk\\include',
  LIB: 'C:\\controlled-sdk\\lib',
  USERPROFILE: 'C:\\controlled-user',
  VSCMD_VER: 'controlled-version',
  APPDATA: 'C:\\controlled-user\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\controlled-user\\AppData\\Local',
  ProgramW6432: 'C:\\controlled-programs',
  SystemDrive: 'C:',
  SystemRoot: 'C:\\controlled-windows',
  VCINSTALLDIR: 'C:\\controlled-vc',
  WindowsSDKVersion: 'controlled-sdk',
  EXTERNAL_INCLUDE: 'C:\\controlled-external',
  LIBPATH: 'C:\\controlled-libpath',
  SPRINT_CODER_CODESIGN_IDENTITY: 'CONTROLLED_SIGNER_IDENTITY',
  OPENROUTER_API_KEY: canary,
  NODE_OPTIONS: '--require=controlled-hook',
  VSCMD_PRIVATE_KEY: canary,
  npm_config_arch: 'controlled-wrong-arch',
  npm_config_target: 'controlled-wrong-target',
  npm_config_loglevel: 'silly',
});
const originalEnvironment = JSON.stringify(environment);

// Evaluate the actual script and pure dependencies, replacing only process creation and artifact
// existence. No node-gyp, compiler, Electron, real credential, or real environment is executed.
async function captureBoundaries(failure = '') {
  const calls = [];
  const output = [];
  const exited = {};
  const context = vm.createContext({
    process: {
      env: environment,
      execPath: process.execPath,
      arch: 'arm64',
      argv: [process.execPath, target],
      stdout: { write: (text) => output.push(String(text)) },
      stderr: { write: (text) => output.push(String(text)) },
      exit: (code) => {
        exited.code = code;
        throw exited;
      },
    },
    Buffer,
    console: { log: (text) => output.push(String(text)) },
  });
  const cache = new Map();
  async function load(url) {
    if (cache.has(url)) return cache.get(url);
    let module;
    if (url.startsWith('node:')) {
      const values = { ...(await import(url)) };
      if (url === 'node:child_process')
        values.spawnSync = (command, args, options) => {
          calls.push({ command, args, options });
          const text = JSON.stringify({ env: options.env ?? environment });
          if (options.stdio === 'inherit') output.push(text);
          const stage = calls.length === 1 ? 'build' : 'probe';
          const fails = failure.startsWith(stage);
          const error =
            fails && (failure.endsWith('error') || failure.endsWith('timeout'))
              ? Object.assign(new Error(canary), {
                  code: failure.endsWith('timeout') ? 'ETIMEDOUT' : 'ENOENT',
                })
              : undefined;
          return {
            status: error ? null : fails ? 17 : 0,
            error,
            stdout: text,
            stderr: `gyp sill controlled env ${text}`,
          };
        };
      if (url === 'node:fs') values.existsSync = () => true;
      module = new vm.SyntheticModule(
        Object.keys(values),
        function () {
          for (const [name, value] of Object.entries(values)) this.setExport(name, value);
        },
        { context, identifier: url },
      );
    } else {
      module = new vm.SourceTextModule(readFileSync(fileURLToPath(url), 'utf8'), {
        context,
        identifier: url,
        initializeImportMeta: (meta) => {
          meta.url = url;
        },
      });
    }
    cache.set(url, module);
    await module.link((specifier, referring) =>
      load(
        specifier.startsWith('node:') ? specifier : new URL(specifier, referring.identifier).href,
      ),
    );
    return module;
  }
  const module = await load(pathToFileURL(target).href);
  try {
    await module.evaluate();
  } catch (error) {
    if (error !== exited) throw error;
  }
  return {
    calls,
    output: output.join('\n'),
    exitCode: exited.code ?? context.process.exitCode ?? 0,
  };
}

test('SQLite compiler and ABI probe use explicit child allowlists and never inherit raw stdio', async () => {
  const result = await captureBoundaries();
  assert.equal(result.calls.length, 2);
  for (const { options } of result.calls) {
    assert.ok(options.env, 'Each child must have an explicit environment');
    assert.equal(options.env.OPENROUTER_API_KEY, undefined, 'Canary must not reach child');
    assert.equal(options.env.VSCMD_PRIVATE_KEY, undefined);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.npm_config_target, undefined);
    assert.equal(options.env.npm_config_arch, undefined);
    assert.equal(options.env.npm_config_loglevel, 'error');
    assert.equal(options.env.INCLUDE, environment.INCLUDE);
    assert.equal(options.env.LIB, environment.LIB);
    assert.equal(options.env.USERPROFILE, environment.USERPROFILE);
    assert.equal(options.env.VSCMD_VER, environment.VSCMD_VER);
    for (const key of [
      'APPDATA',
      'LOCALAPPDATA',
      'ProgramW6432',
      'SystemDrive',
      'SystemRoot',
      'VCINSTALLDIR',
      'WindowsSDKVersion',
      'EXTERNAL_INCLUDE',
      'LIBPATH',
    ])
      assert.equal(options.env[key], environment[key], 'Required Windows build path must survive');
    assert.ok(
      Number.isSafeInteger(options.maxBuffer) &&
        options.maxBuffer > 0 &&
        options.maxBuffer <= 16 * 1024 * 1024,
    );
    assert.ok(
      Number.isSafeInteger(options.timeout) &&
        options.timeout > 0 &&
        options.timeout <= 10 * 60_000,
    );
    assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe']);
  }
  assert.equal(result.calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(result.calls[1].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(result.output.includes(canary), false, 'No canary may be relayed');
  assert.equal(result.output.includes('"env"'), false, 'No environment dump may be relayed');
  assert.equal(
    JSON.stringify(environment) === originalEnvironment,
    true,
    'Parent environment must stay unchanged',
  );
});

test('Failed compiler diagnostics cannot reflect even controlled environment output', async () => {
  const result = await captureBoundaries('build');
  assert.equal(result.calls.length, 1);
  assert.equal(result.output.includes(canary), false, 'No canary may be relayed on failure');
  assert.equal(
    result.output.includes('"env"'),
    false,
    'No environment dump may be relayed on failure',
  );
});

test('Failed ABI probe also suppresses raw child diagnostics', async () => {
  const result = await captureBoundaries('probe');
  assert.equal(result.calls.length, 2);
  assert.equal(result.output.includes(canary), false);
  assert.equal(result.output.includes('"env"'), false);
  assert.match(result.output, /SQLite Electron ABI probe failed \(exit 17\)/u);
});

for (const stage of ['build', 'probe']) {
  for (const failure of ['status', 'error', 'timeout']) {
    test(`${stage} ${failure} uses only fixed diagnostics and preserves failure status`, async () => {
      const result = await captureBoundaries(`${stage}-${failure}`);
      assert.equal(result.calls.length, stage === 'build' ? 1 : 2);
      assert.equal(result.output.includes(canary), false);
      assert.equal(result.output.includes('"env"'), false);
      assert.equal(result.exitCode, failure === 'status' ? 17 : 1);
    });
  }
}

test('Pure helper leaves frozen parent signing configuration intact', () => {
  const child = sanitizedNativeBuildEnvironment(environment);
  assert.equal(JSON.stringify(environment) === originalEnvironment, true);
  assert.equal(environment.SPRINT_CODER_CODESIGN_IDENTITY === 'CONTROLLED_SIGNER_IDENTITY', true);
  assert.equal(child.SPRINT_CODER_CODESIGN_IDENTITY, undefined);
  assert.equal(child.OPENROUTER_API_KEY, undefined);
});
