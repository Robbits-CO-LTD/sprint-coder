#!/usr/bin/env node
// Tests for the stale-Vite-cache classification of triage-e2e.mjs.
//   node --test triage-e2e.test.mjs
// Each case builds a throwaway repo root (fake .vite/deps bundles plus packages/<pkg>/src) and runs
// the real script against a synthetic Playwright JSON report, so the assertions are about mtimes and
// exports only — never about the checkout this runs in.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'triage-e2e.mjs');
const OLD = new Date('2024-01-01T00:00:00Z');
const NEW = new Date('2024-06-01T00:00:00Z');

function write(file, body, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
// root layout: one OLD dep bundle per named package; sources are placed by the caller.
function makeRoot(sources, bundles = { contracts: OLD }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-e2e-test-'));
  roots.push(root);
  for (const [pkg, mtime] of Object.entries(bundles)) {
    write(path.join(root, `apps/desktop/node_modules/.vite/deps/@sprint-coder_${pkg}.js`), 'export const a = 1;\n', mtime);
    // every package dir must exist for the per-package scan to consider it
    if (!sources[`packages/${pkg}/src/index.ts`]) write(path.join(root, `packages/${pkg}/src/index.ts`), 'export const placeholder = 1;\n', OLD);
  }
  for (const [rel, [body, mtime]] of Object.entries(sources)) write(path.join(root, rel), body, mtime);
  return root;
}

function depMessage(pkg, name) {
  return `SyntaxError: The requested module '/@fs/x/apps/desktop/node_modules/.vite/deps/@sprint-coder_${pkg}.js?v=abc' does not provide an export named '${name}'`;
}

function runTriage(root, messages, extraArgs = [], extraEnv = {}) {
  const list = Array.isArray(messages) ? messages : [messages];
  const report = {
    stats: { expected: 0, unexpected: list.length, flaky: 0, skipped: 0, duration: 1000 },
    suites: [{
      title: 'golden-path.spec.ts', file: 'golden-path.spec.ts',
      specs: list.map((message, i) => ({ title: `case ${i}`, line: i + 1, tests: [{ status: 'unexpected', results: [{ status: 'failed', duration: 1000, errors: [{ message }] }] }] })),
      suites: [],
    }],
  };
  const reportPath = path.join(root, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report));
  const out = path.join(root, 'triage');
  execFileSync(process.execPath, [script, reportPath, '--out', out, '--repo-root', root, ...extraArgs], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  return JSON.parse(fs.readFileSync(path.join(out, 'triage.json'), 'utf8'));
}

test('test-only edits are not stale-cache evidence and a missing export stays a real candidate', () => {
  const root = makeRoot({
    'packages/contracts/src/index.ts': ['export const Existing = 1;\n', OLD],
    'packages/contracts/src/index.test.ts': ['import { Existing } from "./index";\n', NEW],
    'packages/contracts/src/types.d.ts': ['export declare const Ghost: number;\n', NEW],
    'packages/contracts/src/__tests__/helper.ts': ['export const helper = 1;\n', NEW],
  });
  const summary = runTriage(root, depMessage('contracts', 'Removed'));
  assert.equal(summary.stale_vite_cache_evidence, false, '*.test.ts / *.d.ts / __tests__ must not count as newer sources');
  assert.equal(summary.failures[0].classification, 'real_candidate');
  assert.match(summary.failures[0].reason, /値 export が無い/);
});

test('a source newer than the cache plus a real value export is classified as environmental', () => {
  const root = makeRoot({
    'packages/contracts/src/index.ts': ['export const Existing = 1;\nexport function Renamed() {}\n', NEW],
  });
  const summary = runTriage(root, depMessage('contracts', 'Renamed'));
  assert.deepEqual(summary.stale_vite_cache_packages, ['contracts']);
  assert.equal(summary.failures[0].classification, 'env_stale_vite_cache');
});

test('a type-only export is not a runtime export', () => {
  const root = makeRoot({
    'packages/contracts/src/index.ts': ['export type TaskSummary = { id: string };\nexport interface Other { a: 1 }\n', NEW],
  });
  const summary = runTriage(root, [depMessage('contracts', 'TaskSummary'), depMessage('contracts', 'Other')]);
  assert.equal(summary.failures[0].classification, 'real_candidate');
  assert.equal(summary.failures[1].classification, 'real_candidate');
  assert.match(summary.failures[0].reason, /型だけ、または削除\/改名/);
});

test('`export { type X }` and `export type { X }` are not runtime exports', () => {
  const root = makeRoot({
    'packages/contracts/src/model.ts': ['type A = 1;\ntype B = 2;\nexport type { B };\nexport { type A };\n', NEW],
    'packages/contracts/src/index.ts': ['export { type A } from "./model";\nexport type { B } from "./model";\n', NEW],
  });
  const summary = runTriage(root, [depMessage('contracts', 'A'), depMessage('contracts', 'B')]);
  assert.equal(summary.failures[0].classification, 'real_candidate');
  assert.equal(summary.failures[1].classification, 'real_candidate');
});

test('ambient declarations and commented-out code are never runtime exports', () => {
  const root = makeRoot({
    'packages/contracts/src/index.ts': [
      'export declare const Foo: string;\n// export const Bar = 1;\n/* export const Qux = 2; */\nconst s = "export const Str = 3;";\nconst re = /export const Rx = 4;/;\nexport const Baz = 1;\n', NEW,
    ],
  });
  const summary = runTriage(root, [
    depMessage('contracts', 'Foo'), depMessage('contracts', 'Bar'), depMessage('contracts', 'Qux'),
    depMessage('contracts', 'Str'), depMessage('contracts', 'Rx'), depMessage('contracts', 'Baz'),
  ]);
  const cls = summary.failures.map((f) => f.classification);
  assert.deepEqual(cls.slice(0, 5), Array(5).fill('real_candidate'), 'declare / comment / string / regex literal must not count');
  assert.equal(cls[5], 'env_stale_vite_cache', 'a plain value export still counts');
});

test('without typescript nothing can be cleared as environmental', () => {
  const root = makeRoot({ 'packages/contracts/src/index.ts': ['export const Baz = 1;\n', NEW] });
  const summary = runTriage(root, depMessage('contracts', 'Baz'), [], { TRIAGE_E2E_NO_TS: '1' });
  assert.equal(summary.failures[0].classification, 'real_candidate');
  assert.match(summary.failures[0].reason, /typescript 不在/);
});

test('a value re-exported from the entrypoint counts as present', () => {
  const root = makeRoot({
    'packages/contracts/src/model.ts': ['const inner = 1;\nexport { inner as Reexported };\n', NEW],
    'packages/contracts/src/index.ts': ['export { Reexported } from "./model";\n', NEW],
  });
  const summary = runTriage(root, depMessage('contracts', 'Reexported'));
  assert.equal(summary.failures[0].classification, 'env_stale_vite_cache');
});

test('a value only reachable through `export * from` is not cleared as environmental', () => {
  const root = makeRoot({
    'packages/contracts/src/model.ts': ['export const Hidden = 1;\n', NEW],
    'packages/contracts/src/index.ts': ['export * from "./model";\n', NEW],
  });
  const summary = runTriage(root, depMessage('contracts', 'Hidden'));
  assert.equal(summary.failures[0].classification, 'real_candidate');
  assert.match(summary.failures[0].reason, /export \* 経由/);
});

test('a value that is not on the public entrypoint is not cleared as environmental', () => {
  const root = makeRoot({
    'packages/contracts/src/internal.ts': ['export const Internal = 1;\n', NEW],
    'packages/contracts/src/index.ts': ['export const Other = 1;\n', NEW],
  });
  const summary = runTriage(root, depMessage('contracts', 'Internal'));
  assert.equal(summary.failures[0].classification, 'real_candidate');
});

test('--stale-vite-cache does not replace the export lookup', () => {
  const root = makeRoot({ 'packages/contracts/src/index.ts': ['export const Existing = 1;\n', OLD] });
  const summary = runTriage(root, depMessage('contracts', 'Removed'), ['--stale-vite-cache', 'contracts']);
  assert.deepEqual(summary.stale_vite_cache_flag_packages, ['contracts']);
  assert.equal(summary.failures[0].classification, 'real_candidate');
});

test('--stale-vite-cache only vouches for the packages it names', () => {
  const root = makeRoot({
    'packages/contracts/src/index.ts': ['export const Existing = 1;\n', OLD],
    'packages/domain/src/index.ts': ['export const Moved = 1;\n', OLD],
  }, { contracts: NEW, domain: NEW });
  const summary = runTriage(root, [depMessage('domain', 'Moved'), depMessage('contracts', 'Existing')], ['--stale-vite-cache', 'domain']);
  assert.equal(summary.failures[0].classification, 'env_stale_vite_cache', 'domain was vouched for');
  assert.equal(summary.failures[1].classification, 'real_candidate', 'contracts was not');
});

test('a bare --stale-vite-cache is refused', () => {
  const root = makeRoot({ 'packages/contracts/src/index.ts': ['export const Existing = 1;\n', OLD] });
  assert.throws(() => runTriage(root, depMessage('contracts', 'Existing'), ['--stale-vite-cache']), /status 64|Command failed/);
});

test('Outdated Optimize Dep is judged per package', () => {
  const root = makeRoot({
    'packages/contracts/src/index.ts': ['export const Existing = 1;\n', NEW],
    'packages/domain/src/index.ts': ['export const Other = 1;\n', OLD],
  }, { contracts: OLD, domain: NEW });
  const summary = runTriage(root, [
    "Error: Outdated Optimize Dep for '/@fs/x/node_modules/.vite/deps/@sprint-coder_contracts.js?v=1'",
    "Error: Outdated Optimize Dep for '/@fs/x/node_modules/.vite/deps/@sprint-coder_domain.js?v=1'",
    'Error: Outdated Optimize Dep',
  ]);
  assert.equal(summary.failures[0].classification, 'env_stale_vite_cache', 'contracts cache is stale');
  assert.equal(summary.failures[1].classification, 'real_candidate', 'domain cache is not');
  assert.equal(summary.failures[2].classification, 'real_candidate', 'no package in the message');
});

test('an export that exists without cache evidence stays a real candidate', () => {
  const root = makeRoot({ 'packages/contracts/src/index.ts': ['export const Existing = 1;\n', OLD] });
  const summary = runTriage(root, depMessage('contracts', 'Existing'));
  assert.equal(summary.stale_vite_cache_evidence, false);
  assert.equal(summary.failures[0].classification, 'real_candidate');
  assert.match(summary.failures[0].reason, /証拠（mtime/);
});

test('staleness is judged per package, not across all bundles', () => {
  // contracts' bundle is fresh, domain's is old and its source moved on: only domain is stale.
  const root = makeRoot({
    'packages/contracts/src/index.ts': ['export const Existing = 1;\n', OLD],
    'packages/domain/src/index.ts': ['export const Moved = 1;\n', NEW],
  }, { contracts: NEW, domain: OLD });
  const summary = runTriage(root, [depMessage('domain', 'Moved'), depMessage('contracts', 'Existing')]);
  assert.deepEqual(summary.stale_vite_cache_packages, ['domain']);
  assert.equal(summary.failures[0].classification, 'env_stale_vite_cache', 'domain cache is older than domain sources');
  assert.equal(summary.failures[1].classification, 'real_candidate', 'contracts cache is newer: not this package');
});

test('an unknown package cannot be cleared as environmental', () => {
  const root = makeRoot({ 'packages/contracts/src/index.ts': ['export const Existing = 1;\n', NEW] });
  const summary = runTriage(root, "SyntaxError: The requested module './x.js' does not provide an export named 'Whatever'");
  assert.equal(summary.failures[0].classification, 'real_candidate');
  assert.match(summary.failures[0].reason, /確認できない/);
});

test('a wholesale firstWindow failure does not launder a removed export', () => {
  const root = makeRoot({ 'packages/contracts/src/index.ts': ['export const Existing = 1;\n', NEW] });
  const firstWindow = 'TimeoutError: electronApp.firstWindow: Timeout 30000ms exceeded';
  const summary = runTriage(root, [
    depMessage('contracts', 'Removed'), firstWindow, firstWindow, firstWindow, firstWindow,
  ]);
  assert.equal(summary.wholesale_env, true, 'the run does look wholesale-environmental');
  assert.equal(summary.failures[0].classification, 'real_candidate');
  assert.equal(summary.failures[1].classification, 'env_wholesale');
});
