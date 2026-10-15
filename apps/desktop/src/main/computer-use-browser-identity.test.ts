import { describe, expect, it } from 'vitest';
import {
  COMPUTER_USE_BROWSER_IDENTITY_TABLE_VERSION,
  isComputerUseBrowserApplication,
} from './computer-use-browser-identity';

const mac = (bundleId: string, canonicalPath = '/Applications/X.app/Contents/MacOS/X') => ({
  canonicalPath,
  identity: { bundleId },
});
const windows = (canonicalPath: string) => ({ canonicalPath, identity: {} });

describe('browser identity table (#785 T15-7, R14)', () => {
  it('is versioned', () => {
    expect(COMPUTER_USE_BROWSER_IDENTITY_TABLE_VERSION).toBe(2);
  });

  it.each([
    'com.google.Chrome',
    'com.google.Chrome.canary',
    'com.microsoft.edgemac',
    'org.mozilla.firefox',
    'com.apple.Safari',
    'com.brave.Browser',
    'company.thebrowser.Browser',
    'com.operasoftware.Opera',
    'com.vivaldi.Vivaldi',
    'COM.GOOGLE.CHROME',
    'org.chromium.Chromium',
    'com.google.chrome.for.testing',
    'org.mozilla.nightly',
    'org.torproject.torbrowser',
    'com.kagi.kagimacOS',
    'com.duckduckgo.macos.browser',
    'com.operasoftware.OperaGX',
    'company.thebrowser.dia',
    'app.zen-browser.zen',
  ])('recognises the macOS browser %s', (bundleId) => {
    expect(isComputerUseBrowserApplication(mac(bundleId))).toBe(true);
  });

  it.each([
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Mozilla Firefox\\FIREFOX.EXE',
    'C:\\Users\\a\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Users\\a\\AppData\\Local\\Programs\\Opera\\opera.exe',
    'C:\\Users\\a\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe',
    'C:\\Users\\a\\AppData\\Local\\Arc\\arc.exe',
    'C:\\Windows\\System32\\iexplore.exe',
    'C:\\Program Files\\LibreWolf\\librewolf.exe',
    'C:\\Program Files\\Waterfox\\waterfox.exe',
    'C:\\Program Files\\Floorp\\floorp.exe',
    'C:\\Program Files\\Zen Browser\\zen.exe',
    'C:\\Program Files\\Naver\\Whale\\whale.exe',
    'C:\\Program Files\\DuckDuckGo\\DuckDuckGo.exe',
    'C:\\Users\\a\\AppData\\Local\\Yandex\\YandexBrowser\\Application\\browser.exe',
  ])('recognises the Windows browser %s', (path) => {
    expect(isComputerUseBrowserApplication(windows(path))).toBe(true);
  });

  it.each([
    'com.google.Chrome.app.abcdefghijklmnop',
    'com.microsoft.edgemac.app.xyz',
    'com.apple.Safari.WebApp.ABC123',
    'com.brave.Browser.app.zzz',
  ])('recognises the web app shim %s as part of its browser', (bundleId) => {
    expect(isComputerUseBrowserApplication(mac(bundleId))).toBe(true);
  });

  it.each([
    mac('com.apple.TextEdit'),
    mac('com.google.Chrome.helper'),
    windows('C:\\Tools\\browser.exe'),
    mac('com.google.ChromeRemoteDesktop'),
    mac('com.example.chromeish'),
    windows('C:\\Windows\\System32\\notepad.exe'),
    windows('C:\\Tools\\chrome.exe.bak'),
    windows('C:\\Tools\\notchrome.exe'),
    { canonicalPath: '', identity: {} },
    { canonicalPath: '/Applications/X.app', identity: { bundleId: 7 } },
  ])('does not call %j a browser', (profile) => {
    expect(isComputerUseBrowserApplication(profile)).toBe(false);
  });
});
