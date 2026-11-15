import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readStoredTheme, writeStoredTheme } from './window-theme-store';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sprint-coder-theme-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("the profile's theme file", () => {
  it('is the default theme while there is no file', () => {
    expect(readStoredTheme(join(directory, 'theme.json'))).toBe('black');
  });

  it('keeps the chosen theme for the next launch, and the latest choice wins', () => {
    const path = join(directory, 'theme.json');
    writeStoredTheme(path, 'white');
    expect(readStoredTheme(path)).toBe('white');
    writeStoredTheme(path, 'gray');
    expect(readStoredTheme(path)).toBe('gray');
    // Nothing is left beside it.
    expect(readdirSync(directory)).toEqual(['theme.json']);
  });

  it('creates the profile folder when it is not there yet', () => {
    const path = join(directory, 'new-profile', 'theme.json');
    writeStoredTheme(path, 'white');
    expect(readStoredTheme(path)).toBe('white');
  });

  it('is the default theme when the file is damaged', () => {
    const path = join(directory, 'theme.json');
    writeFileSync(path, '{"theme":');
    expect(readStoredTheme(path)).toBe('black');
  });
});
