import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import {
  NATIVE_BUILD_TIMEOUT_ENVIRONMENT_KEY,
  nativeBuildFailureDetail,
  nativeBuildNetworkDiagnostics,
  nativeBuildTimeoutMs,
  sanitizedNativeBuildEnvironment,
} from './native-build-environment.mjs';

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
  // node-gyp downloads Electron headers through make-fetch-happen, which reads the proxy
  // configuration from the child environment. Credential-free settings must survive, a proxy URL
  // that embeds userinfo must not, and npm_config_* stays blocked because it overrides pinned CLI
  // build controls.
  HTTPS_PROXY: 'http://controlled-proxy.invalid:3128',
  NO_PROXY: 'controlled-proxy.invalid,localhost',
  HTTP_PROXY: `http://controlled-user:${canary}@controlled-proxy.invalid:3128`,
  npm_config_proxy: 'http://controlled-npm-proxy.invalid:3128',
});
const originalEnvironment = JSON.stringify(environment);

// Evaluate the actual script and pure dependencies, replacing only process creation and artifact
// existence. No node-gyp, compiler, Electron, real credential, or real environment is executed.
async function captureBoundaries(failure = '', overrides = undefined) {
  // Overrides build a separate frozen object so the shared parent environment stays untouched.
  const activeEnvironment = overrides
    ? Object.freeze({ ...environment, ...overrides })
    : environment;
  const calls = [];
  const output = [];
  const exited = {};
  const context = vm.createContext({
    process: {
      env: activeEnvironment,
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
          const text = JSON.stringify({ env: options.env ?? activeEnvironment });
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
            // spawnSync reports the signal it used when a timeout kills the child.
            signal: fails && failure.endsWith('timeout') ? 'SIGTERM' : null,
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
    // Nothing reads these children's output and it must never be relayed, so it is discarded at the
    // file-descriptor level instead of captured and thrown away. That is a stronger boundary than a
    // pipe, and with nothing captured no maxBuffer ceiling can abort a healthy but noisy build.
    assert.deepEqual(
      Array.from(options.stdio),
      ['ignore', 'ignore', 'ignore'],
      'A native build child must never pipe or inherit its diagnostics',
    );
    assert.equal(options.maxBuffer, undefined, 'Nothing is captured, so no buffer ceiling applies');
    assert.ok(
      Number.isSafeInteger(options.timeout) &&
        options.timeout > 0 &&
        options.timeout <= 4 * 60 * 60_000,
    );
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
  assert.match(
    result.output,
    /SQLite Electron ABI probe failed \(exit 17, error=none, signal=none/u,
  );
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

test('Credential-free proxy settings reach node-gyp while npm build controls stay blocked', async () => {
  const result = await captureBoundaries();
  assert.equal(result.calls.length, 2);
  for (const { options } of result.calls) {
    assert.equal(
      options.env.HTTPS_PROXY,
      environment.HTTPS_PROXY,
      'A credential-free proxy must reach the Electron header download',
    );
    assert.equal(options.env.NO_PROXY, environment.NO_PROXY);
    assert.equal(
      options.env.HTTP_PROXY,
      undefined,
      'A proxy URL carrying userinfo must never reach the child',
    );
    assert.equal(
      options.env.npm_config_proxy,
      undefined,
      'npm_config_* stays blocked because it overrides pinned CLI build controls',
    );
  }
  assert.equal(result.output.includes(canary), false);
});

test('Sanitizer drops credential-bearing proxy URLs instead of rewriting them', () => {
  const child = sanitizedNativeBuildEnvironment(environment);
  assert.equal(child.HTTPS_PROXY, environment.HTTPS_PROXY);
  assert.equal(child.NO_PROXY, environment.NO_PROXY);
  assert.equal(child.HTTP_PROXY, undefined);
  assert.equal(child.npm_config_proxy, undefined);
  assert.equal(
    JSON.stringify(child).includes(canary),
    false,
    'No credential may survive in any forwarded value',
  );
  assert.equal(JSON.stringify(environment) === originalEnvironment, true);
});

test('Network policy summary names variables only and never discloses a value', () => {
  const summary = nativeBuildNetworkDiagnostics(environment);
  assert.equal(
    summary,
    'native build network policy: forwarded=HTTPS_PROXY,NO_PROXY withheld=npm_config_proxy withheld-with-credentials=HTTP_PROXY',
  );
  assert.equal(summary.includes(canary), false);
  assert.equal(summary.includes('controlled-proxy.invalid'), false);
  assert.equal(
    nativeBuildNetworkDiagnostics({ PATH: '/controlled/compiler-path' }),
    'native build network policy: forwarded=none withheld=none withheld-with-credentials=none',
  );
  assert.equal(
    nativeBuildNetworkDiagnostics({ OPENROUTER_API_KEY: canary, SECRET_PROXY_TOKEN: canary }),
    'native build network policy: forwarded=none withheld=none withheld-with-credentials=none',
    'Only the fixed non-secret name set may ever be reported',
  );
});

test('Failed build explains the withheld network variables without leaking any value', async () => {
  const result = await captureBoundaries('build');
  assert.match(result.output, /SQLite source build failed \(exit 17, error=none, signal=none/u);
  assert.match(
    result.output,
    /^native build network policy: forwarded=HTTPS_PROXY,NO_PROXY withheld=npm_config_proxy withheld-with-credentials=HTTP_PROXY$/mu,
  );
  assert.equal(result.output.includes(canary), false, 'Diagnostics must never include a value');
  assert.equal(
    result.output.includes('controlled-proxy.invalid'),
    false,
    'Diagnostics must name variables, never their values',
  );
  assert.equal(result.output.includes('"env"'), false);
});

test('Compiler budget is generous by default and adjustable only from the parent environment', async () => {
  const base = await captureBoundaries();
  assert.equal(
    base.calls[0].options.timeout,
    30 * 60_000,
    'A full sqlite3.c amalgamation compile must not be killed at ten minutes',
  );
  const widened = await captureBoundaries('', {
    [NATIVE_BUILD_TIMEOUT_ENVIRONMENT_KEY]: '5400000',
  });
  assert.equal(widened.calls[0].options.timeout, 5_400_000);
  for (const { options } of widened.calls)
    assert.equal(
      options.env[NATIVE_BUILD_TIMEOUT_ENVIRONMENT_KEY],
      undefined,
      'The budget configures this process only and must never reach node-gyp',
    );
  assert.equal(JSON.stringify(environment) === originalEnvironment, true);
});

test('A malformed or out-of-range build budget falls back to the generous default', () => {
  const fallback = 30 * 60_000;
  assert.equal(nativeBuildTimeoutMs({}), fallback);
  for (const raw of [
    '',
    ' 900000',
    '900000 ',
    '30min',
    '9e8',
    '0x1000',
    '-1',
    '1.5',
    '0',
    '59999',
    '14400001',
    '999999999999',
  ])
    assert.equal(
      nativeBuildTimeoutMs({ [NATIVE_BUILD_TIMEOUT_ENVIRONMENT_KEY]: raw }),
      fallback,
      `Must reject ${JSON.stringify(raw)}`,
    );
  for (const raw of ['60000', '900000', '14400000'])
    assert.equal(
      nativeBuildTimeoutMs({ [NATIVE_BUILD_TIMEOUT_ENVIRONMENT_KEY]: raw }),
      Number(raw),
      `Must accept ${JSON.stringify(raw)}`,
    );
});

test('A killed build names the errno and signal instead of the child message', async () => {
  const result = await captureBoundaries('build-timeout');
  assert.match(
    result.output,
    /^SQLite source build failed \(exit 1, error=ETIMEDOUT, signal=SIGTERM, budget=1800000ms\)$/mu,
  );
  assert.equal(result.output.includes(canary), false, 'The child message must never be relayed');
  assert.equal(result.exitCode, 1);
});

test('Failure detail reports only fixed tokens and never a child-supplied string', () => {
  assert.equal(
    nativeBuildFailureDetail({ error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM' }, 1_800_000),
    'error=ETIMEDOUT, signal=SIGTERM, budget=1800000ms',
  );
  assert.equal(nativeBuildFailureDetail({}), 'error=none, signal=none');
  assert.equal(
    nativeBuildFailureDetail({ error: { code: 'ENOBUFS' } }),
    'error=ENOBUFS, signal=none',
  );
  const leaky = nativeBuildFailureDetail({
    error: { code: `spawn /bin/cc failed: ${canary}` },
    signal: canary,
  });
  assert.equal(leaky, 'error=other, signal=other');
  assert.equal(leaky.includes(canary), false, 'A non-token code must be reduced, never echoed');
});

test('Computer Use build failures report the errno rather than inventing an exit code', () => {
  const source = readFileSync(resolve(root, 'build-computer-use-native.mjs'), 'utf8');
  assert.equal(
    source.includes('exit ${result.error ? 1 : (result.status ?? 1)}'),
    false,
    'A child that never started has no exit code and must not be reported as exit 1',
  );
  assert.ok(
    source.includes('nativeBuildFailureDetail(result)'),
    'The Computer Use build must summarize failures with the shared helper',
  );
  assert.ok(
    source.includes("stdio: ['ignore', 'ignore', 'ignore']"),
    'The build child discards its output at the file descriptor',
  );
  // The helper carries the errno for exactly those cases, with no budget and no child message.
  assert.equal(
    nativeBuildFailureDetail({ error: { code: 'ENOENT' }, status: null }),
    'error=ENOENT, signal=none',
  );
  assert.equal(
    nativeBuildFailureDetail({
      error: Object.assign(new Error(canary), { code: 'ENOBUFS' }),
      status: null,
    }),
    'error=ENOBUFS, signal=none',
    'The child message must never reach the summary',
  );
});

test('Pure helper leaves frozen parent signing configuration intact', () => {
  const child = sanitizedNativeBuildEnvironment(environment);
  assert.equal(JSON.stringify(environment) === originalEnvironment, true);
  assert.equal(environment.SPRINT_CODER_CODESIGN_IDENTITY === 'CONTROLLED_SIGNER_IDENTITY', true);
  assert.equal(child.SPRINT_CODER_CODESIGN_IDENTITY, undefined);
  assert.equal(child.OPENROUTER_API_KEY, undefined);
});
