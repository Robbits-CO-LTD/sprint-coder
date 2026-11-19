import { z } from 'zod';
import macUrlBrowsers from '../../desktop-control/src/dispatch/mac-url-browsers.json';

/**
 * `launch <browser> --url <URL>`: what Main lets a desktop-control run open in a browser, judged
 * before any card. Only an http or https URL, read with the URL standard (WHATWG, as `new URL`)
 * and sealed in its canonical form (`URL.href`: a Japanese host becomes punycode, a Japanese path
 * is percent-encoded, `..` is resolved), so the card shows and the browser gets exactly that
 * string. The desktop-control executable takes only that canonical form and checks it again by its
 * shape (`src/dispatch/launch_url.rs`, the same rules as `launchUrlShapeRefusal` here); both are
 * tested against `desktop-control/src/dispatch/launch_url_cases.json`.
 *
 * Refused: any other scheme (`file:`, `javascript:`, `data:`, `chrome:` …) or none, a user name or
 * password (`user@host`, which shows one host and opens another), a value with a space, control or
 * invisible character, quote, backtick, backslash or angle bracket, a value that does not start
 * with `http://` or `https://` (so `http:host`, `//host` and `-` are refused before any parsing),
 * no host, an IPv6 literal, a host that is not letters, digits, `.`, `-` and `_` once read, and
 * anything longer than 2048 characters. A local server (`localhost`, `127.0.0.1`, any port) opens,
 * as it would from the address bar.
 */
export const DESKTOP_CONTROL_URL_MAX = 2_048;

const NOT_SHOWN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Z}\s"'`\\<>]/u;

/** The canonical URL Main seals for `--url`, or why it is refused (for the agent, no 。). */
export function desktopControlLaunchUrl(raw: string): { url: string } | { refusal: string } {
  const refused = (reason: string) => ({ refusal: `launch の --url: ${reason}` });
  if (raw.length === 0 || raw.length > DESKTOP_CONTROL_URL_MAX)
    return refused(`URL は 1〜${DESKTOP_CONTROL_URL_MAX} 文字にする`);
  if (NOT_SHOWN.test(raw))
    return refused('URL に空白・制御文字・見えない文字・引用符・`・\\・< > を含めない');
  if (!/^https?:\/\//iu.test(raw))
    return refused('開けるのは http:// か https:// で始まる URL だけ（ほかの scheme は開けない）');
  const afterSlashes = raw.slice(raw.indexOf('//') + 2);
  const authority = afterSlashes.slice(0, afterSlashes.search(/[/?#]|$/u));
  if (authority.includes('@')) return refused('URL に user や password（@ の前）を含めない');
  if (authority === '') return refused('URL に host が無い');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refused('URL として読めない');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname === ''
  )
    return refused('開けるのは user や password の無い http か https の URL だけ');
  const url = parsed.href;
  const shape = launchUrlShapeRefusal(url);
  return shape === null ? { url } : refused(`${shape}（読んだ形: ${url.slice(0, 200)}）`);
}

/**
 * Why a canonical URL is not in the shape the executable takes, or `null`: the same rules as
 * `url_shape_refusal` in `src/dispatch/launch_url.rs`.
 */
export function launchUrlShapeRefusal(url: string): string | null {
  if (url.length === 0 || url.length > DESKTOP_CONTROL_URL_MAX)
    return `URL は 1〜${DESKTOP_CONTROL_URL_MAX} 文字にする`;
  if (!/^[\x21-\x7e]*$/u.test(url) || /["'`\\<>]/u.test(url))
    return 'URL に空白・制御文字・ASCII でない文字・引用符・`・\\・< > を含めない';
  const scheme = url.startsWith('https://') ? 'https' : url.startsWith('http://') ? 'http' : null;
  if (scheme === null) return '開けるのは http:// か https:// で始まる URL だけ';
  const rest = url.slice(scheme.length + 3);
  const end = rest.search(/[/?#]|$/u);
  const authority = rest.slice(0, end);
  const tail = rest.slice(end);
  if (!tail.startsWith('/')) return 'URL に path が無い';
  if (authority.includes('@')) return 'URL に user や password（@ の前）を含めない';
  const colon = authority.lastIndexOf(':');
  const host = colon < 0 ? authority : authority.slice(0, colon);
  const port = colon < 0 ? undefined : authority.slice(colon + 1);
  const hostRefusal = launchUrlHostRefusal(host);
  if (hostRefusal !== null) return hostRefusal;
  if (
    port !== undefined &&
    (!/^(0|[1-9][0-9]{0,4})$/u.test(port) ||
      Number(port) > 65_535 ||
      port === (scheme === 'https' ? '443' : '80'))
  )
    return 'port の番号を読めない';
  if (/%(?![0-9A-Fa-f]{2})/u.test(tail)) return 'URL の % の後に 16 進の 2 文字が無い';
  const path = tail.slice(0, tail.search(/[?#]|$/u));
  if (
    path
      .split('/')
      .some((segment) => ['.', '..'].includes(segment.toLowerCase().replaceAll('%2e', '.')))
  )
    return 'URL の path に . や .. の区切りがある';
  return null;
}

// As DNS bounds them (`MAX_HOST_CHARS`, `MAX_LABEL_CHARS`), so the card always shows the whole host.
const HOST_MAX = 253;
const LABEL_MAX = 63;

function launchUrlHostRefusal(host: string): string | null {
  if (host === '') return 'URL に host が無い';
  const shape = 'host は、小文字・数字・. - _ の名前か、IPv4 の番号だけ（IPv6 は使えない）';
  if (!/^[a-z0-9._-]+$/u.test(host)) return shape;
  // A trailing dot is kept in the canonical form (`example.com.`) and is not counted.
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (name.length > HOST_MAX) return `host は ${HOST_MAX} 文字まで`;
  const labels = name.split('.');
  if (labels.some((label) => label === '')) return 'host に空の区切りがある';
  if (labels.some((label) => label.length > LABEL_MAX))
    return `host の . で区切った各部分は ${LABEL_MAX} 文字まで`;
  const last = labels.at(-1)!;
  // As the URL standard reads a host that ends in a number: an IPv4 address.
  if (
    (/^[0-9]+$/u.test(last) || last.startsWith('0x')) &&
    !/^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/u.test(
      host,
    )
  )
    return shape;
  return null;
}

// The browsers `--url` is for, by executable name without `.exe`, in lower case: the same list as
// `src/dispatch/launch_url.rs`. Chromium-based ones get `--new-window <URL>`, Firefox-based ones
// `-new-window <URL>`, from the executable; nothing else is passed.
export const DESKTOP_CONTROL_URL_BROWSERS: readonly string[] = [
  'chrome',
  'msedge',
  'brave',
  'vivaldi',
  'opera',
  'chromium',
  'thorium',
  'firefox',
  'librewolf',
  'waterfox',
];
// The Start menu names of those browsers (letters and digits only, in lower case), which Main
// replaces with the executable's path before the card (`desktopControlLaunchByName`); the path is
// then judged by its file name as above.
// Opera's Start menu shortcuts point to its `launcher.exe`, so its names are not listed.
const BROWSER_MENU_NAMES = new Set([
  'googlechrome',
  'microsoftedge',
  'bravebrowser',
  'mozillafirefox',
]);

/**
 * Whether `launch` may take `--url` for this app: a path or name whose file name is a known
 * browser's executable (`chrome.exe`, `firefox` …), or a Start menu name of one. The file name is
 * read as the executable reads it (`browser_family`): after the last `\` or `/`, ASCII letters in
 * lower case, nothing trimmed, so both come to the same answer (`launch_url_apps.json`).
 */
export function desktopControlUrlBrowser(app: string): boolean {
  const base = asciiLower(app.split(/[\\/]/u).at(-1)!);
  const stem = base.endsWith('.exe') ? base.slice(0, -4) : base;
  if (DESKTOP_CONTROL_URL_BROWSERS.includes(stem)) return true;
  return !/[\\/]/u.test(app) && BROWSER_MENU_NAMES.has(stem.replace(/[^a-z0-9]/gu, ''));
}

/** How a browser is told to open a page in a new window (`BrowserFamily` of the executable). */
export type DesktopControlUrlBrowserFamily = 'chromium' | 'firefox';

/**
 * The browsers `--url` is for on macOS: the bundle's file name without `.app` and its bundle id
 * (`CFBundleIdentifier`), the same table as `MAC_URL_BROWSER_TABLE` in
 * `src/dispatch/launch_url.rs`; a browser whose id is not known is left out. Main judges the name
 * the agent gave by this table (as the executable does) and every bundle the name resolves to by
 * its bundle id, so a renamed app does not pass for a browser (and an id listed wrongly refuses
 * that browser rather than passing another app).
 */
export const DESKTOP_CONTROL_MAC_URL_BROWSERS = z
  .array(
    z.object({
      name: z.string().min(1),
      bundleId: z.string().min(1),
      family: z.enum(['chromium', 'firefox']),
    }),
  )
  .readonly()
  .parse(macUrlBrowsers);

/**
 * The browser a macOS `launch` names, by a bundle's file name (with or without a lower-case `.app`,
 * the only suffix the executable reads as a file name) or a bundle id of
 * `DESKTOP_CONTROL_MAC_URL_BROWSERS`, or `null`. Read as the executable reads it
 * (`mac_browser_family`): ASCII letters in any case otherwise, nothing trimmed
 * (`launch_url_mac_apps.json`).
 */
export function desktopControlMacUrlBrowser(app: string): DesktopControlUrlBrowserFamily | null {
  const lower = asciiLower(app);
  const name = asciiLower(app.endsWith('.app') ? app.slice(0, -'.app'.length) : app);
  return (
    DESKTOP_CONTROL_MAC_URL_BROWSERS.find(
      (browser) => name === asciiLower(browser.name) || lower === asciiLower(browser.bundleId),
    )?.family ?? null
  );
}

/** The browser a macOS bundle id (`CFBundleIdentifier`, letter case ignored) is, or `null`. */
export function desktopControlMacUrlBrowserById(
  id: string | null,
): DesktopControlUrlBrowserFamily | null {
  if (id === null) return null;
  return (
    DESKTOP_CONTROL_MAC_URL_BROWSERS.find(
      (browser) => asciiLower(id) === asciiLower(browser.bundleId),
    )?.family ?? null
  );
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}
