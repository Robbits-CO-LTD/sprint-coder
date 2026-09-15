// Pure child-environment policy. Importing this module never resolves dependencies or starts a build.
export function sanitizedNativeBuildEnvironment(environment) {
  // Node-gyp consumes npm_config_* after its CLI arguments, so even non-secret ambient
  // values can replace the pinned Electron target, architecture, or header source. Keep
  // every build control on the explicit command line and inject only a fixed log level.
  const allowed =
    /^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMW6432|SYSTEMDRIVE|HOMEDRIVE|HOMEPATH|USER|USERNAME|LOGNAME|SHELL|COMSPEC|PATHEXT|PWD|INIT_CWD|TMPDIR|TEMP|TMP|TERM|LANG|LC_ALL|LC_CTYPE|NODE|PYTHON|CC|CXX|SDKROOT|DEVELOPER_DIR|MACOSX_DEPLOYMENT_TARGET|SYSTEMROOT|WINDIR|OS|PROCESSOR_[A-Z0-9_]+|NUMBER_OF_PROCESSORS|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|COMMONPROGRAMFILES(?:\(X86\))?|DRIVERDATA|COMMANDPROMPTTYPE|PLATFORM|PLATFORMTARGET|PREFERREDTOOLARCHITECTURE|INCLUDE|EXTERNAL_INCLUDE|LIB|LIBPATH|IFCPATH|VSINSTALLDIR|VISUALSTUDIOVERSION|DEVENVDIR|VCINSTALLDIR|VCTOOLSINSTALLDIR|VCTOOLSREDISTDIR|WINDOWSLIBPATH|WINDOWSSDKDIR|WINDOWSSDKVERSION|WINDOWSSDKLIBVERSION|WINDOWSSDKVERBINPATH|UCRTVERSION|UNIVERSALCRTSDKDIR|EXTENSIONSDKDIR|FRAMEWORKDIR|FRAMEWORKDIR32|FRAMEWORKVERSION|FRAMEWORKVERSION32|FRAMEWORK40VERSION|NETFXSDKDIR|VSCMD_[A-Z0-9_]+|__VSCMD_PREINIT_PATH)$/iu;
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
