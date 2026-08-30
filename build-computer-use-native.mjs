import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryDirectory = dirname(fileURLToPath(import.meta.url));
const nativeDirectory = join(repositoryDirectory, 'apps', 'desktop', 'computer-use-native');
const outputDirectory = join(nativeDirectory, 'build', 'Release');
const require = createRequire(import.meta.url);
const electronPackagePath = require.resolve('electron/package.json', {
  paths: [join(repositoryDirectory, 'apps', 'desktop')],
});
const electronVersion = JSON.parse(readFileSync(electronPackagePath, 'utf8')).version;
const protocolVersion = 1;
const apiVersion = 1;

const target =
  process.argv.find((argument) => argument.startsWith('--target='))?.slice('--target='.length) ??
  process.platform;
const architecture =
  process.argv.find((argument) => argument.startsWith('--arch='))?.slice('--arch='.length) ??
  (process.arch === 'arm64' ? 'arm64' : 'x64');

if (!['darwin', 'win32', 'linux'].includes(target))
  throw new Error(`Computer Use native target is unsupported: ${target}`);
if (target !== process.platform)
  throw new Error(
    `Cross-platform Computer Use native builds are unsupported: target ${target} must be built on ${target}`,
  );
if (target === 'darwin' && !['arm64', 'x64'].includes(architecture))
  throw new Error(`Computer Use macOS native architecture is unsupported: ${architecture}`);
if (target === 'win32' && architecture !== 'x64')
  throw new Error(`Computer Use Windows native architecture is unsupported: ${architecture}`);

mkdirSync(outputDirectory, { recursive: true });

function run(command, arguments_, environment = process.env) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryDirectory,
    env: sanitizedNativeBuildEnvironment(environment),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      .split(/\r?\n/u)
      .filter(
        (line) =>
          !line.startsWith('gyp verb') &&
          !line.startsWith('gyp sill') &&
          !line.includes('execFile: opts = {"env"'),
      )
      .slice(-200)
      .join('\n')
      .trim();
    if (diagnostic !== '') process.stderr.write(`${diagnostic}\n`);
    throw new Error(`${command} exited with status ${String(result.status ?? 1)}`);
  }
}

export function sanitizedNativeBuildEnvironment(environment) {
  const allowed =
    /^(?:PATH|HOME|HOMEDRIVE|HOMEPATH|USER|USERNAME|LOGNAME|SHELL|COMSPEC|PATHEXT|PWD|INIT_CWD|TMPDIR|TEMP|TMP|TERM|LANG|LC_ALL|LC_CTYPE|NODE|PYTHON|CC|CXX|SDKROOT|DEVELOPER_DIR|MACOSX_DEPLOYMENT_TARGET|SYSTEMROOT|WINDIR|OS|PROCESSOR_[A-Z0-9_]+|NUMBER_OF_PROCESSORS|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|COMMONPROGRAMFILES(?:\(X86\))?|DRIVERDATA|COMMANDPROMPTTYPE|PLATFORM|PLATFORMTARGET|PREFERREDTOOLARCHITECTURE|INCLUDE|EXTERNAL_INCLUDE|LIB|LIBPATH|IFCPATH|VSINSTALLDIR|VISUALSTUDIOVERSION|DEVENVDIR|VCINSTALLDIR|VCTOOLSINSTALLDIR|VCTOOLSREDISTDIR|WINDOWSLIBPATH|WINDOWSSDKDIR|WINDOWSSDKVERSION|WINDOWSSDKLIBVERSION|WINDOWSSDKVERBINPATH|UCRTVERSION|UNIVERSALCRTSDKDIR|EXTENSIONSDKDIR|FRAMEWORKDIR|FRAMEWORKDIR32|FRAMEWORKVERSION|FRAMEWORKVERSION32|FRAMEWORK40VERSION|NETFXSDKDIR|VSCMD_[A-Z0-9_]+|__VSCMD_PREINIT_PATH)$/iu;
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key, value]) =>
          value !== undefined && allowed.test(key) && !isSecretLikeEnvironmentKey(key),
      ),
    ),
    npm_config_loglevel: 'error',
  };
}

function isSecretLikeEnvironmentKey(key) {
  const canonical = key.toUpperCase().replace(/[^A-Z0-9]/gu, '');
  return [
    'APIKEY',
    'ACCESSKEY',
    'TOKEN',
    'SECRET',
    'PASSWORD',
    'PRIVATEKEY',
    'CREDENTIAL',
    'AUTH',
    'COOKIE',
    'SESSION',
    'CERTIFICATE',
  ].some((marker) => canonical.includes(marker));
}

if (process.argv.includes('--test-environment-sanitizer')) {
  const sanitized = sanitizedNativeBuildEnvironment({
    PATH: '/usr/bin',
    INCLUDE: 'C:\\Windows Kits\\Include',
    LIB: 'C:\\Windows Kits\\Lib',
    LIBPATH: 'C:\\Visual Studio\\LibPath',
    OPENROUTER_API_KEY: 'PRIVATE_CANARY',
    SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD: 'PRIVATE_CANARY',
    npm_config__authToken: 'PRIVATE_CANARY',
    NPM_CONFIG_ACCESSTOKEN: 'PRIVATE_CANARY',
    NPM_CONFIG_OTP: 'PRIVATE_CANARY',
    NPM_CONFIG_KEY: 'PRIVATE_CANARY',
    NPM_CONFIG_CERT: 'PRIVATE_CANARY',
    VSCMD_AUTHTOKEN: 'PRIVATE_CANARY',
    DATABASE_URL: 'PRIVATE_CANARY',
    CODEX_THREAD_ID: 'PRIVATE_CANARY',
  });
  if (
    sanitized.PATH !== '/usr/bin' ||
    sanitized.INCLUDE !== 'C:\\Windows Kits\\Include' ||
    sanitized.LIB !== 'C:\\Windows Kits\\Lib' ||
    sanitized.LIBPATH !== 'C:\\Visual Studio\\LibPath' ||
    sanitized.OPENROUTER_API_KEY !== undefined ||
    sanitized.SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD !== undefined ||
    sanitized.npm_config__authToken !== undefined ||
    sanitized.NPM_CONFIG_ACCESSTOKEN !== undefined ||
    sanitized.NPM_CONFIG_OTP !== undefined ||
    sanitized.NPM_CONFIG_KEY !== undefined ||
    sanitized.NPM_CONFIG_CERT !== undefined ||
    sanitized.VSCMD_AUTHTOKEN !== undefined ||
    sanitized.DATABASE_URL !== undefined ||
    sanitized.CODEX_THREAD_ID !== undefined
  )
    throw new Error('Computer Use native build environment sanitizer failed');
  process.stdout.write('Computer Use native build environment sanitizer: PASS\n');
  process.exit(0);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function computerUseSourceCommit() {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const repositoryCommit = result.status === 0 ? result.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/u.test(repositoryCommit))
    throw new Error('Computer Use source commit is unavailable');
  const requested = process.argv
    .find((argument) => argument.startsWith('--source-commit='))
    ?.slice('--source-commit='.length);
  if (requested !== undefined && requested !== repositoryCommit)
    throw new Error('Computer Use source commit does not match the repository HEAD');
  return repositoryCommit;
}

if (target === 'linux') {
  // Linux is intentionally outside the Computer Use platform contract.  Do not emit a manifest
  // that could be mistaken for a supported target; Forge does not package this directory on Linux.
  console.log(`[computer-use-native] ${target}-${architecture}: disabled (PLATFORM_UNSUPPORTED)`);
} else {
  const sourceCommit = computerUseSourceCommit();
  let artifact;
  if (target === 'darwin') {
    const nodeGypPath = require.resolve('@electron/node-gyp/bin/node-gyp.js');
    const environment = {
      ...process.env,
      MACOSX_DEPLOYMENT_TARGET: '12.3',
    };
    run(
      process.execPath,
      [
        nodeGypPath,
        'rebuild',
        '--directory',
        nativeDirectory,
        `--target=${electronVersion}`,
        `--arch=${architecture}`,
        '--dist-url=https://electronjs.org/headers',
        '--loglevel=error',
      ],
      environment,
    );
    const path = join(outputDirectory, 'sprint_coder_computer_use_native.node');
    if (!existsSync(path) || !statSync(path).isFile())
      throw new Error('Computer Use macOS N-API module was not produced');
    artifact = {
      kind: 'napi-addon',
      file: 'sprint_coder_computer_use_native.node',
      sizeBytes: statSync(path).size,
      sha256: sha256File(path),
    };
  } else {
    const executable = join(outputDirectory, 'sprint-coder-computer-use-host.exe');
    const provenanceHeader = join(outputDirectory, 'computer_use_build_provenance.h');
    writeFileSync(
      provenanceHeader,
      `#pragma once\n#define SPRINT_CODER_SOURCE_COMMIT "${sourceCommit}"\n`,
      { mode: 0o600 },
    );
    const compiler = process.env['CXX'] ?? process.env['CC'] ?? 'cl.exe';
    // The Windows runner is intentionally built with the host's MSVC developer environment.  A
    // missing compiler is an explicit Gate 0 failure; falling back to a PATH binary would make the
    // packaged helper provenance ambiguous.
    run(compiler, [
      '/nologo',
      '/std:c++20',
      '/EHsc',
      '/W4',
      '/GS',
      '/guard:cf',
      '/sdl',
      '/permissive-',
      '/utf-8',
      '/DUNICODE',
      '/D_UNICODE',
      '/DWIN32_LEAN_AND_MEAN',
      '/DNOMINMAX',
      '/D_WIN32_WINNT=0x0A00',
      '/DSPRINT_CODER_REQUIRE_WINDOWS_GRAPHICS_CAPTURE=1',
      `/FI${provenanceHeader}`,
      `/I${nativeDirectory}`,
      join(nativeDirectory, 'computer_use_windows_host.cc'),
      `/Fe:${executable}`,
      '/link',
      '/guard:cf',
      '/NXCOMPAT',
      '/DYNAMICBASE',
      '/HIGHENTROPYVA',
      'ole32.lib',
      'oleaut32.lib',
      'uiautomationcore.lib',
      'user32.lib',
      'dwmapi.lib',
      'd3d11.lib',
      'dxgi.lib',
      'windowscodecs.lib',
      'bcrypt.lib',
      'advapi32.lib',
      'userenv.lib',
      'crypt32.lib',
      'wintrust.lib',
      'shell32.lib',
      'runtimeobject.lib',
      'windowsapp.lib',
      'uuid.lib',
    ]);
    if (!existsSync(executable) || !statSync(executable).isFile())
      throw new Error('Computer Use Windows helper was not produced');
    artifact = {
      kind: 'windows-helper',
      file: 'sprint-coder-computer-use-host.exe',
      sizeBytes: statSync(executable).size,
      sha256: sha256File(executable),
    };
  }

  const digest = artifact.sha256;
  const manifest = {
    version: 1,
    sourceCommit,
    platform: target,
    architecture,
    protocolVersion,
    apiVersion,
    nativeVersion: 'computer-use-native-gate0-1',
    // V1 has one native artifact per platform. Binding both canonical digest fields to the same
    // signed bytes keeps package verification uniform for the N-API module and Windows helper.
    moduleDigest: digest,
    binaryDigest: digest,
    // Signing is verified only after Forge signs the packaged graph.  Build-time environment
    // variables are never treated as proof of a certificate or Developer ID identity.
    signerDigest: null,
    capabilities: ['observe', 'capture', 'accessibility', 'input'],
  };
  const manifestPath = join(outputDirectory, 'computer-use-native.manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `[computer-use-native] ${target}-${architecture}: ${artifact.kind} ${digest} (signature-pending)`,
  );
}
