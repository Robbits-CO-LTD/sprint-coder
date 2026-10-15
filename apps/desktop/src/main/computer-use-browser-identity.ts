/**
 * Which applications Main treats as a web browser (#785 T15-7, design R14).
 *
 * A browser is refused as the destination of a pasted artifact: a form on a web page reaches a
 * third party directly, and the outer agent can read a page back with WebFetch. The list is a small
 * constant table with its own version, like the classifier rule sets, so a change to it is a change
 * a reviewer can see.
 *
 * What this does not cover, on purpose: the origin of a window (Main has no origin facts; the native
 * keeps them), and a web view inside another application (Electron and the like). Those are listed
 * as acceptance items for enabling the feature (T15-E).
 */
export const COMPUTER_USE_BROWSER_IDENTITY_TABLE_VERSION = 2 as const;

/** macOS bundle identifiers, compared whole and case-insensitively. */
const BROWSER_BUNDLE_IDS: ReadonlySet<string> = new Set([
  'com.google.chrome',
  'com.google.chrome.beta',
  'com.google.chrome.dev',
  'com.google.chrome.canary',
  'com.microsoft.edgemac',
  'com.microsoft.edgemac.beta',
  'com.microsoft.edgemac.dev',
  'com.microsoft.edgemac.canary',
  'org.mozilla.firefox',
  'org.mozilla.firefoxdeveloperedition',
  'com.apple.safari',
  'com.apple.safaritechnologypreview',
  'com.brave.browser',
  'company.thebrowser.browser',
  'com.operasoftware.opera',
  'com.vivaldi.vivaldi',
  'org.chromium.chromium',
  'com.google.chrome.for.testing',
  'org.mozilla.nightly',
  'org.torproject.torbrowser',
  'com.kagi.kagimacos',
  'com.duckduckgo.macos.browser',
  'com.operasoftware.operagx',
  'company.thebrowser.dia',
  'app.zen-browser.zen',
  'net.waterfox.waterfox',
  'one.ablaze.floorp',
  'io.gitlab.librewolf-community.librewolf',
]);

/**
 * A web app or PWA that a browser installs as its own application keeps the browser's bundle id as a
 * prefix (`com.google.Chrome.app.<id>`), and is as much a web page as the browser is.
 */
const BROWSER_BUNDLE_ID_PREFIXES: readonly string[] = [
  'com.google.chrome.app.',
  'com.microsoft.edgemac.app.',
  'com.apple.safari.webapp.',
  'org.chromium.chromium.app.',
  'com.brave.browser.app.',
  'com.vivaldi.vivaldi.app.',
  'company.thebrowser.browser.app.',
  'com.operasoftware.opera.app.',
];

/** Windows executable file names, compared whole and case-insensitively. */
const BROWSER_EXECUTABLE_NAMES: ReadonlySet<string> = new Set([
  'chrome.exe',
  'msedge.exe',
  'firefox.exe',
  'brave.exe',
  'arc.exe',
  'opera.exe',
  'vivaldi.exe',
  'chromium.exe',
  'iexplore.exe',
  'librewolf.exe',
  'waterfox.exe',
  'floorp.exe',
  'zen.exe',
  'whale.exe',
  'duckduckgo.exe',
]);

/** Yandex Browser is `browser.exe`, a name too general to match on its own: its folder says. */
const YANDEX_PATH = /[\\/]yandex[\\/]/iu;

/**
 * Whether a Computer Use application profile is a browser: its macOS bundle id, or the file name of
 * its Windows executable, is in the table. Anything that cannot be read is not a match here; this is
 * one of the checks a paste goes through, not the only one.
 */
export function isComputerUseBrowserApplication(
  profile: Readonly<{ canonicalPath: string; identity: Readonly<Record<string, unknown>> }>,
): boolean {
  const bundleId = profile.identity['bundleId'];
  if (typeof bundleId === 'string') {
    const id = bundleId.toLowerCase();
    if (BROWSER_BUNDLE_IDS.has(id)) return true;
    if (BROWSER_BUNDLE_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) return true;
  }
  const name = profile.canonicalPath.split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
  if (name === 'browser.exe' && YANDEX_PATH.test(profile.canonicalPath)) return true;
  return BROWSER_EXECUTABLE_NAMES.has(name);
}
