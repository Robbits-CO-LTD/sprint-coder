import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  findFixedReleases,
  MIN_FIXED_LIBUV,
} from './scripts/node-libuv-watch.mjs';

const workflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/node-libuv-watch.yml'),
  'utf8',
);

describe('Node libuv watch (#734)', () => {
  it('compares semantic versions numerically', () => {
    expect(compareVersions('1.53.0', '1.52.1')).toBeGreaterThan(0);
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('v26.11.1', '26.11.1')).toBe(0);
    expect(() => compareVersions('1.53', '1.53.0')).toThrow(/invalid version/u);
  });

  it('reports only releases whose libuv is at least 1.53.0', () => {
    expect(MIN_FIXED_LIBUV).toBe('1.53.0');
    const index = [
      { version: 'v26.12.0', date: '2026-11-01', uv: '1.53.0', lts: false },
      { version: 'v24.22.0', date: '2026-11-02', uv: '1.54.1', lts: 'Krypton' },
      { version: 'v26.11.1', date: '2026-10-07', uv: '1.52.1', lts: false },
      { version: 'v22.23.3', date: '2026-09-01', uv: '1.51.0', lts: 'Jod' },
    ];
    expect(findFixedReleases(index)).toEqual([
      { version: 'v26.12.0', date: '2026-11-01', uv: '1.53.0', lts: false },
      { version: 'v24.22.0', date: '2026-11-02', uv: '1.54.1', lts: 'Krypton' },
    ]);
  });

  it('fails closed on malformed entries and rejects a non-array index', () => {
    const index = [
      { version: 'v27.0.0' },
      { version: 'v27.0.0', uv: '1.53' },
      { version: 'nightly', uv: '1.60.0' },
      { version: 'v27.0.0', uv: 1.6 },
      { version: 'v27.0.0', date: '2026-11-01 | @owner', uv: '1.60.0' },
      null,
    ];
    expect(findFixedReleases(index)).toEqual([]);
    expect(
      findFixedReleases([
        { version: 'v27.0.0', date: '2026-11-01', uv: '1.60.0', lts: '![x](https://example.test)' },
      ]),
    ).toEqual([{ version: 'v27.0.0', date: '2026-11-01', uv: '1.60.0', lts: false }]);
    expect(() => findFixedReleases({})).toThrow(/must be an array/u);
  });

  it('runs on a schedule with job-scoped, least-privilege permissions', () => {
    expect(workflow).toMatch(/^permissions:\s*\{\}\s*$/mu);
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron: '/u);
    expect(workflow).toMatch(/workflow_dispatch:/u);
    expect(workflow).toMatch(/ {4}permissions:\n {6}contents: read\n {6}issues: write/u);
    expect(workflow).toMatch(
      /uses: actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7\.0\.0/u,
    );
    expect(workflow).toMatch(/persist-credentials: false/u);
  });

  it('opens at most one tracking issue identified by a marker', () => {
    expect(workflow).toMatch(/marker='node-libuv-watch:1\.53\.0'/u);
    expect(workflow).toMatch(/--state all --search "\\"\$\{marker\}\\" in:body"/u);
    expect(workflow).toMatch(/監視マーカー: \$\{marker\}/u);
    expect(workflow).toMatch(
      /if: steps\.find\.outputs\.count != '' && steps\.find\.outputs\.count != '0'/u,
    );
    expect(workflow).toMatch(/count="\$\(jq 'length'/u);
  });
});
