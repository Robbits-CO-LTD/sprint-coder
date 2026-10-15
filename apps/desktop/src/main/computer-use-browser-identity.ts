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
export const COMPUTER_USE_BROWSER_IDENTITY_TABLE_VERSION = 1 as const;

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
]);

/** Windows executable file names, compared whole and case-insensitively. */
const BROWSER_EXECUTABLE_NAMES: ReadonlySet<string> = new Set([
  'chrome.exe',
  'msedge.exe',
  'firefox.exe',
  'brave.exe',
  'arc.exe',
  'opera.exe',
  'vivaldi.exe',
]);

/**
 * Whether a Computer Use application profile is a browser: its macOS bundle id, or the file name of
 * its Windows executable, is in the table. Anything that cannot be read is not a match here; this is
 * one of the checks a paste goes through, not the only one.
 */
export function isComputerUseBrowserApplication(
  profile: Readonly<{ canonicalPath: string; identity: Readonly<Record<string, unknown>> }>,
): boolean {
  const bundleId = profile.identity['bundleId'];
  if (typeof bundleId === 'string' && BROWSER_BUNDLE_IDS.has(bundleId.toLowerCase())) return true;
  const name = profile.canonicalPath.split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
  return BROWSER_EXECUTABLE_NAMES.has(name);
}
