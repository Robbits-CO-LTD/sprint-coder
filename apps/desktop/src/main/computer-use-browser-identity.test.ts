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
    expect(COMPUTER_USE_BROWSER_IDENTITY_TABLE_VERSION).toBe(1);
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
  ])('recognises the Windows browser %s', (path) => {
    expect(isComputerUseBrowserApplication(windows(path))).toBe(true);
  });

  it.each([
    mac('com.apple.TextEdit'),
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
