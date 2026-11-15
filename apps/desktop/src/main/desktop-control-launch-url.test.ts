import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopApprovalActionSchema } from '@sprint-coder/contracts';
import {
  desktopControlArgvMode,
  desktopControlArgvRefusal,
  desktopControlLaunchByName,
} from './desktop-control';
import { desktopControlApprovalAction } from './desktop-control-display';
import {
  DESKTOP_CONTROL_URL_BROWSERS,
  DESKTOP_CONTROL_URL_MAX,
  desktopControlLaunchUrl,
  desktopControlUrlBrowser,
  launchUrlShapeRefusal,
} from './desktop-control-launch-url';

// The table the executable is tested against too (`src/dispatch/launch_url_tests.rs`).
const CASES = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', 'desktop-control', 'src', 'dispatch', 'launch_url_cases.json'),
    'utf8',
  ),
) as { url: string; canonical: string | null }[];
// The browsers the executable knows (`CHROMIUM_BROWSERS` and `FIREFOX_BROWSERS`).
const EXECUTABLE_BROWSERS = readFileSync(
  join(__dirname, '..', '..', 'desktop-control', 'src', 'dispatch', 'launch_url.rs'),
  'utf8',
);

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const roots = ['C:\\work\\repo'];
const lookup = { platform: 'win32' as const, realpath: (path: string) => path };
const refusalOf = (argv: string[]) => desktopControlArgvRefusal(argv, roots, lookup);

describe('launch --url: the URL', () => {
  it('seals every URL of the shared table as the executable expects', () => {
    expect(CASES.length).toBeGreaterThan(50);
    for (const { url, canonical } of CASES) {
      const read = desktopControlLaunchUrl(url);
      if (canonical === null) expect(read, JSON.stringify(url)).toHaveProperty('refusal');
      else {
        expect(read, JSON.stringify(url)).toEqual({ url: canonical });
        // Sealed once, it stays as it is, and it is in the shape the executable takes.
        expect(desktopControlLaunchUrl(canonical)).toEqual({ url: canonical });
        expect(launchUrlShapeRefusal(canonical)).toBeNull();
      }
    }
  });

  it('refuses each kind of URL it may not open, with a reason', () => {
    for (const [url, reason] of [
      ['javascript:alert(1)', 'http:// か https://'],
      ['FILE:///C:/x', 'http:// か https://'],
      ['https://user:pass@example.com/', 'user や password'],
      ['https://example.com/ x', '空白'],
      [`https://example.com/${'\u200b'}`, '見えない文字'],
      ['https://[::1]/', 'IPv6'],
      ['http://', 'host が無い'],
      ['https://example.com:99999/', 'URL として読めない'],
    ] as const)
      expect(desktopControlLaunchUrl(url)).toEqual({
        refusal: expect.stringContaining(reason) as unknown as string,
      });
  });

  it('bounds the length before and after sealing', () => {
    const head = 'https://example.com/';
    const longest = `${head}${'a'.repeat(DESKTOP_CONTROL_URL_MAX - head.length)}`;
    expect(desktopControlLaunchUrl(longest)).toEqual({ url: longest });
    expect(desktopControlLaunchUrl(`${longest}a`)).toHaveProperty('refusal');
    // Percent-encoding makes a short Japanese path long: judged on what would be passed.
    expect(desktopControlLaunchUrl(`${head}${'あ'.repeat(700)}`)).toHaveProperty('refusal');
  });

  it('bounds the host and its labels as DNS does', () => {
    const label = (n: number) => 'a'.repeat(n);
    const longest = [label(63), label(63), label(63), label(61)].join('.');
    expect(longest).toHaveLength(253);
    expect(desktopControlLaunchUrl(`https://${longest}/`)).toEqual({ url: `https://${longest}/` });
    expect(desktopControlLaunchUrl(`https://${longest}./`)).toEqual({
      url: `https://${longest}./`,
    });
    expect(desktopControlLaunchUrl(`https://${longest}a/`)).toEqual({
      refusal: expect.stringContaining('253 文字まで') as unknown as string,
    });
    expect(desktopControlLaunchUrl(`https://${label(64)}.com/`)).toEqual({
      refusal: expect.stringContaining('63 文字まで') as unknown as string,
    });
  });
});

describe('launch --url: the browser', () => {
  it('knows the same browsers as the executable', () => {
    for (const name of DESKTOP_CONTROL_URL_BROWSERS)
      expect(EXECUTABLE_BROWSERS).toContain(`"${name}"`);
    const listed = [...EXECUTABLE_BROWSERS.matchAll(/_BROWSERS: &\[&str\] = &\[([^\]]*)\]/gu)]
      .flatMap((match) => [...match[1]!.matchAll(/"([a-z0-9]+)"/gu)].map((name) => name[1]))
      .sort();
    expect(listed).toEqual([...DESKTOP_CONTROL_URL_BROWSERS].sort());
  });

  it('takes a browser by its file name or its Start menu name, and nothing else', () => {
    for (const app of [
      CHROME,
      'chrome',
      'MSEDGE.EXE',
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'Google Chrome',
      'Microsoft Edge',
      'Firefox',
      'Mozilla Firefox',
      'Brave',
    ])
      expect(desktopControlUrlBrowser(app), app).toBe(true);
    for (const app of [
      'notepad',
      'C:\\Tools\\Google Chrome\\evil.exe',
      'C:\\x\\Google Chrome',
      'chrome.bat',
      'msedgewebview2',
      'iexplore',
      'Google Chrome Helper',
      // Opera's Start menu shortcuts point to its launcher.exe, which is refused once looked up.
      'Opera Browser',
      'Opera GX Browser',
    ])
      expect(desktopControlUrlBrowser(app), app).toBe(false);
  });

  it('judges every app of the shared table as the executable does, nothing trimmed', () => {
    const apps = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', 'desktop-control', 'src', 'dispatch', 'launch_url_apps.json'),
        'utf8',
      ),
    ) as { app: string; browser: boolean }[];
    expect(apps.length).toBeGreaterThan(15);
    for (const { app, browser } of apps)
      expect(desktopControlUrlBrowser(app), JSON.stringify(app)).toBe(browser);
    expect(refusalOf(['launch', 'C:\\x\\chrome.exe ', '--url', 'https://example.com/'])).toContain(
      '知っているブラウザー',
    );
  });
});

describe('launch --url: the arguments Main lets run', () => {
  it('runs a browser with one acceptable URL, in the background unless --activate', () => {
    for (const argv of [
      ['launch', CHROME, '--url', 'https://example.com/'],
      ['launch', CHROME, '--url=https://example.com/', '--no-attach'],
      ['launch', '--url', 'http://localhost:3000/', 'Google Chrome'],
      ['launch', CHROME, '--url', 'https://日本語.jp/'],
    ])
      expect(refusalOf(argv), argv.join(' ')).toBeNull();
    expect(desktopControlArgvMode(['launch', CHROME, '--url', 'https://example.com/'])).toBe(
      'background',
    );
    expect(
      desktopControlArgvMode(['launch', CHROME, '--url', 'https://example.com/', '--activate']),
    ).toBe('foreground');
  });

  it('refuses a non-browser, a second --url, a refused URL and the refused options', () => {
    expect(
      refusalOf(['launch', 'C:\\Windows\\System32\\notepad.exe', '--url', 'https://e.com/']),
    ).toContain('知っているブラウザー');
    expect(refusalOf(['launch', 'calc', '--url', 'https://example.com/'])).toContain(
      '知っているブラウザー',
    );
    expect(
      refusalOf(['launch', CHROME, '--url', 'https://a.com/', '--url=https://b.com/']),
    ).toContain('--url は 1 つだけ');
    expect(refusalOf(['launch', CHROME, '--url', 'file:///C:/Windows/win.ini'])).toContain(
      'http:// か https://',
    );
    expect(refusalOf(['launch', CHROME, '--url', '--new-window'])).toContain('http:// か https://');
    expect(refusalOf(['launch', CHROME, '--url'])).toContain('--url に値が無い');
    for (const option of ['--arg=--remote-debugging-port=9222', '--env=A=1', '--cwd=C:\\', '--cdp'])
      expect(refusalOf(['launch', CHROME, '--url', 'https://example.com/', option])).toContain(
        'は使えない',
      );
    // Without --url, a browser launches as any app did.
    expect(refusalOf(['launch', CHROME])).toBeNull();
  });

  it('judges a launch in a batch the same way', () => {
    const batch = (args: Record<string, unknown>) =>
      refusalOf(['batch', JSON.stringify([{ command: 'launch', args }])]);
    expect(batch({ app: CHROME, url: 'https://example.com/' })).toBeNull();
    expect(batch({ app: 'notepad', url: 'https://example.com/' })).toContain(
      '知っているブラウザー',
    );
    expect(batch({ app: CHROME, url: 'javascript:alert(1)' })).toContain('http:// か https://');
    expect(batch({ app: CHROME, url: ['https://example.com/'] })).toContain('url を判定できない');
    expect(batch({ app: CHROME, url: 'https://example.com/', args: ['--x'] })).toContain(
      'launch の args は使えない',
    );
  });

  it('seals the canonical URL into the argv before the card, also in a batch', () => {
    const seal = (argv: string[]) => desktopControlLaunchByName(argv, roots, lookup);
    expect(seal(['launch', CHROME, '--url', 'HTTPS://Example.COM/検索?q=東京'])).toEqual({
      argv: [
        'launch',
        CHROME,
        '--url',
        'https://example.com/%E6%A4%9C%E7%B4%A2?q=%E6%9D%B1%E4%BA%AC',
      ],
    });
    expect(seal(['launch', CHROME, '--url=https://日本語.jp'])).toEqual({
      argv: ['launch', CHROME, '--url=https://xn--wgv71a119e.jp/'],
    });
    // Already canonical: nothing to replace.
    expect(seal(['launch', CHROME, '--url', 'https://example.com/'])).toBeNull();
    // Also where Start menu names are not looked up.
    expect(
      desktopControlLaunchByName(['launch', 'chrome', '--url', 'https://example.com'], roots, {
        platform: 'linux',
      }),
    ).toEqual({ argv: ['launch', 'chrome', '--url', 'https://example.com/'] });
    const sealed = seal([
      'batch',
      JSON.stringify([
        { command: 'launch', args: { app: CHROME, url: 'https://example.com' } },
        { command: 'snapshot', args: {} },
      ]),
    ]);
    expect(sealed).not.toBeNull();
    expect(JSON.parse((sealed as { argv: string[] }).argv[1]!)).toEqual([
      { command: 'launch', args: { app: CHROME, url: 'https://example.com/' } },
      { command: 'snapshot', args: {} },
    ]);
    // A sealed argv passes the checks again, unchanged.
    expect(refusalOf(['launch', CHROME, '--url=https://xn--wgv71a119e.jp/'])).toBeNull();
  });
});

describe('launch --url: the approval card', () => {
  const card = (argv: readonly string[]) => {
    // No snapshot is read for a launch; the folder does not exist.
    const action = desktopControlApprovalAction(argv, {
      stateRoot: join(tmpdir(), 'sc-dc-launch-url-no-state'),
      names: false,
    });
    expect(desktopApprovalActionSchema.parse(action)).toEqual(action);
    return action;
  };

  it('says it opens the URL, shows it whole, and never offers the Task grant', () => {
    expect(card(['launch', CHROME, '--url', 'https://example.com/a?q=1'])).toMatchObject({
      kind: 'launch',
      title: 'ブラウザーで URL を開きます',
      mode: 'background',
      target: { resolved: true, app: CHROME },
      text: 'https://example.com/a?q=1',
      textRole: 'url',
      allowTaskGrant: false,
      notes: [
        expect.stringContaining('ブラウザーの新しい窓で開きます') as unknown as string,
        '起動した窓は、今使っている窓の後ろに置きます。一瞬だけ手前に見えることがあります。',
      ],
    });
    expect(card(['launch', CHROME, '--url', 'https://example.com/', '--activate'])).toMatchObject({
      mode: 'foreground',
      allowTaskGrant: false,
    });
    // A plain launch is as before.
    expect(card(['launch', CHROME])).toMatchObject({
      title: 'アプリを起動します',
      allowTaskGrant: true,
    });
    expect(card(['launch', CHROME]).textRole).toBeUndefined();
  });

  it('keeps the host of a long URL whole and cuts the middle of the rest', () => {
    const host = `https://${'sub.'.repeat(40)}example.com:8443`;
    const url = `${host}/${'p'.repeat(1_500)}?q=END`;
    const action = card(['launch', CHROME, '--url', url]);
    expect(action.text!.startsWith(`${host}/p`)).toBe(true);
    expect(action.text!.endsWith('q=END')).toBe(true);
    expect(action.text).toContain('…');
    expect(action.text!.length).toBeLessThanOrEqual(1_000);
    expect(action.openDetails).toBe(true);
    expect(action.notes).toContain(
      'URL が長いため、途中を省いて表示しています（開く先の名前までは全部出しています）。全文は「詳細（実行内容）」で確かめてください。',
    );
  });

  it('shows the whole of the longest host Main lets through, however long the rest is', () => {
    const label = (n: number) => 'a'.repeat(n);
    const origin = `https://${[label(63), label(63), label(63), label(61)].join('.')}.:65535`;
    for (const rest of [
      `/${'p'.repeat(1_700)}`,
      `/?${'q'.repeat(1_700)}`,
      `/#${'f'.repeat(1_700)}`,
    ]) {
      const url = `${origin}${rest}`;
      expect(desktopControlLaunchUrl(url)).toEqual({ url });
      const action = card(['launch', CHROME, '--url', url]);
      expect(action.text!.startsWith(`${origin}/`), rest.slice(0, 3)).toBe(true);
      expect(action.text).toContain('…');
      expect(action.text!.length).toBeLessThanOrEqual(1_000);
    }
  });

  it('shows the URL of a launch in a batch and keeps the Task grant off for the batch', () => {
    const action = card([
      'batch',
      JSON.stringify([
        { command: 'launch', args: { app: CHROME, url: 'https://example.com/' } },
        { command: 'list-windows', args: {} },
      ]),
    ]);
    expect(action.steps?.[0]).toMatchObject({
      kind: 'launch',
      title: 'ブラウザーで URL を開きます',
      text: 'https://example.com/',
      textRole: 'url',
    });
    expect(action.allowTaskGrant).toBe(false);
  });
});
