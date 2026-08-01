import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from './forge.config';

describe('desktop package icon', () => {
  it('points Electron Packager at real macOS and Windows icon files', () => {
    const iconPath = resolve(__dirname, 'assets', 'sprint-coder-icon');

    expect(config.packagerConfig?.icon).toBe(iconPath);
    expect(existsSync(`${iconPath}.icns`)).toBe(true);
    expect(existsSync(`${iconPath}.ico`)).toBe(true);
    expect(readFileSync(`${iconPath}.icns`).subarray(0, 4).toString('ascii')).toBe('icns');
    expect([...readFileSync(`${iconPath}.ico`).subarray(0, 4)]).toEqual([0, 0, 1, 0]);
  });
});
