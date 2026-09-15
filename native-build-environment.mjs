// Pure child-environment policy. Importing this module never resolves dependencies or starts a build.

// node-gyp fetches the pinned Electron headers over `--dist-url`, and make-fetch-happen reads the
// proxy configuration straight out of the child environment rather than from node-gyp's options
// (`getProxyUri` and `checkNoProxy` in make-fetch-happen/lib/agent.js), so a proxy-only or
// air-gapped-with-proxy network needs these forwarded or every header download fails. These are the
// only network variables this build actually consults: node-gyp never reads ELECTRON_MIRROR, it
// honours NODEJS_ORG_MIRROR only when no `--dist-url` is passed, and its header cache lives under
// the already-allowed HOME/USERPROFILE instead of npm_config_cache.
const PROXY_ENVIRONMENT_KEY = /^(?:HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/iu;

export function sanitizedNativeBuildEnvironment(environment) {
  // Node-gyp consumes npm_config_* after its CLI arguments, so even non-secret ambient
  // values can replace the pinned Electron target, architecture, or header source. Keep
  // every build control on the explicit command line and inject only a fixed log level.
  const allowed =
    /^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMW6432|SYSTEMDRIVE|HOMEDRIVE|HOMEPATH|USER|USERNAME|LOGNAME|SHELL|COMSPEC|PATHEXT|PWD|INIT_CWD|TMPDIR|TEMP|TMP|TERM|LANG|LC_ALL|LC_CTYPE|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|NODE|PYTHON|CC|CXX|SDKROOT|DEVELOPER_DIR|MACOSX_DEPLOYMENT_TARGET|SYSTEMROOT|WINDIR|OS|PROCESSOR_[A-Z0-9_]+|NUMBER_OF_PROCESSORS|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|COMMONPROGRAMFILES(?:\(X86\))?|DRIVERDATA|COMMANDPROMPTTYPE|PLATFORM|PLATFORMTARGET|PREFERREDTOOLARCHITECTURE|INCLUDE|EXTERNAL_INCLUDE|LIB|LIBPATH|IFCPATH|VSINSTALLDIR|VISUALSTUDIOVERSION|DEVENVDIR|VCINSTALLDIR|VCTOOLSINSTALLDIR|VCTOOLSREDISTDIR|WINDOWSLIBPATH|WINDOWSSDKDIR|WINDOWSSDKVERSION|WINDOWSSDKLIBVERSION|WINDOWSSDKVERBINPATH|UCRTVERSION|UNIVERSALCRTSDKDIR|EXTENSIONSDKDIR|FRAMEWORKDIR|FRAMEWORKDIR32|FRAMEWORKVERSION|FRAMEWORKVERSION32|FRAMEWORK40VERSION|NETFXSDKDIR|VSCMD_[A-Z0-9_]+|__VSCMD_PREINIT_PATH)$/iu;
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key, value]) =>
          value !== undefined &&
          allowed.test(key) &&
          !isSecretLikeEnvironmentKey(key) &&
          !carriesEmbeddedCredential(key, value),
      ),
    ),
    npm_config_loglevel: 'error',
  };
}

// A proxy URL may embed `user:password@host`. Those credentials are exactly as sensitive as any
// token, so a proxy variable carrying userinfo is dropped whole rather than forwarded or rewritten;
// an operator behind an authenticating proxy must supply a credential-free endpoint. Any `@` in one
// of these values means userinfo, because proxy endpoints and NO_PROXY host lists never contain one.
function carriesEmbeddedCredential(key, value) {
  return PROXY_ENVIRONMENT_KEY.test(key) && /@|%40/iu.test(String(value));
}

// Fixed, non-secret variable names. A failing build reports which of these the policy forwarded and
// which it withheld, so a proxy-blocked header download stays diagnosable while raw child output,
// ambient values, and every other variable name remain suppressed.
const NETWORK_DIAGNOSTIC_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'npm_config_proxy',
  'npm_config_https_proxy',
  'npm_config_noproxy',
]);

export function nativeBuildNetworkDiagnostics(environment) {
  const child = sanitizedNativeBuildEnvironment(environment);
  const entriesFor = (source, name) =>
    Object.entries(source).filter(
      ([key, value]) => key.toLowerCase() === name.toLowerCase() && value !== undefined,
    );
  const forwarded = [];
  const withheld = [];
  const withheldWithCredentials = [];
  for (const name of NETWORK_DIAGNOSTIC_KEYS) {
    const present = entriesFor(environment, name);
    if (present.length === 0) continue;
    if (entriesFor(child, name).length > 0) forwarded.push(name);
    else if (present.some(([key, value]) => carriesEmbeddedCredential(key, value)))
      withheldWithCredentials.push(name);
    else withheld.push(name);
  }
  const list = (names) => (names.length === 0 ? 'none' : names.join(','));
  return `native build network policy: forwarded=${list(forwarded)} withheld=${list(withheld)} withheld-with-credentials=${list(withheldWithCredentials)}`;
}

// better-sqlite3 compiles the whole sqlite3.c amalgamation with optimizations enabled. On a
// two-core CI runner, under Windows/MSBuild, or when the Electron headers still have to come down
// through a proxy, that legitimately runs past ten minutes, and spawnSync answers a timeout by
// killing the child and reporting an error — turning a healthy build into a reported compiler
// failure. Keep a generous default and let an operator widen it, but read the budget only in the
// parent: this key is deliberately absent from the child allowlist above, so it configures this
// process and never reaches node-gyp.
export const NATIVE_BUILD_TIMEOUT_ENVIRONMENT_KEY = 'SPRINT_CODER_NATIVE_BUILD_TIMEOUT_MS';
const DEFAULT_NATIVE_BUILD_TIMEOUT_MS = 30 * 60_000;
const MINIMUM_NATIVE_BUILD_TIMEOUT_MS = 60_000;
const MAXIMUM_NATIVE_BUILD_TIMEOUT_MS = 4 * 60 * 60_000;

export function nativeBuildTimeoutMs(environment) {
  const raw = environment?.[NATIVE_BUILD_TIMEOUT_ENVIRONMENT_KEY];
  // Only a plain decimal integer counts. Padding, exponents, hex, signs, and fractions are rejected
  // outright rather than coerced, so a typo falls back to the default instead of silently producing
  // a tiny budget that would kill every build.
  if (typeof raw !== 'string' || !/^\d{1,9}$/u.test(raw)) return DEFAULT_NATIVE_BUILD_TIMEOUT_MS;
  const requested = Number(raw);
  if (requested < MINIMUM_NATIVE_BUILD_TIMEOUT_MS || requested > MAXIMUM_NATIVE_BUILD_TIMEOUT_MS)
    return DEFAULT_NATIVE_BUILD_TIMEOUT_MS;
  return requested;
}

// Node's errno identifier is what separates a real compiler failure from a child this script killed
// (ETIMEDOUT) or a capture ceiling (ENOBUFS), and without it those are indistinguishable once raw
// output is discarded. Both the errno and the signal name are fixed tokens; anything that does not
// look like one — a child-supplied message above all — is reduced to "other" so nothing rides along.
export function nativeBuildFailureDetail(result, timeoutMs) {
  const budget = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? `, budget=${timeoutMs}ms` : '';
  const code = fixedToken(result?.error?.code, /^[A-Z][A-Z0-9_]{1,31}$/u);
  const signal = fixedToken(result?.signal, /^SIG[A-Z0-9]{1,15}$/u);
  return `error=${code}, signal=${signal}${budget}`;
}

function fixedToken(value, shape) {
  if (value === undefined || value === null) return 'none';
  return shape.test(String(value)) ? String(value) : 'other';
}

function isSecretLikeEnvironmentKey(key) {
  const canonical = key.toUpperCase().replace(/[^A-Z0-9]/gu, '');
  return [
    'APIKEY',
    'ACCESSKEY',
    'TOKEN',
    'OTP',
    'SECRET',
    'PASSWORD',
    'PASS',
    'PRIVATEKEY',
    'KEY',
    'CREDENTIAL',
    'AUTH',
    'COOKIE',
    'SESSION',
    'CERT',
    'CERTIFICATE',
  ].some((marker) => canonical.includes(marker));
}
