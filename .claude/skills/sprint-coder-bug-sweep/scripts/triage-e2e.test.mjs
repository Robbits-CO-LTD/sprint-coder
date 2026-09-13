#!/usr/bin/env node
// Tests for the stale-Vite-cache classification of triage-e2e.mjs.
//   node --test triage-e2e.test.mjs
// Each case builds a throwaway repo root (a fake .vite/deps bundle plus packages/<pkg>/src) and runs
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
// root layout: the Vite dep bundle is OLD; sources are placed by the caller.
function makeRoot(sources) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-e2e-test-'));
  roots.push(root);
  write(path.join(root, 'apps/desktop/node_modules/.vite/deps/@sprint-coder_contracts.js'), 'export const a = 1;\n', OLD);
  for (const [rel, [body, mtime]] of Object.entries(sources)) write(path.join(root, rel), body, mtime);
  return root;
}

function errorMessage(name) {
  return `SyntaxError: The requested module '/@fs/x/apps/desktop/node_modules/.vite/deps/@sprint-coder_contracts.js?v=abc' does not provide an export named '${name}'`;
}

function runTriage(root, message, extraArgs = []) {
  const report = {
    stats: { expected: 0, unexpected: 1, flaky: 0, skipped: 0, duration: 1000 },
    suites: [{
      title: 'golden-path.spec.ts', file: 'golden-path.spec.ts',
      specs: [{ title: 'renderer boots', line: 12, tests: [{ status: 'unexpected', results: [{ status: 'failed', duration: 1000, errors: [{ message }] }] }] }],
      suites: [],
    }],
  };
  const reportPath = path.join(root, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report));
  const out = path.join(root, 'triage');
  execFileSync(process.execPath, [script, reportPath, '--out', out, '--repo-root', root, ...extraArgs], { encoding: 'utf8' });
  return JSON.parse(fs.readFileSync(path.join(out, 'triage.json'), 'utf8'));
}

test('test-only edits are not stale-cache evidence and a missing export stays a real candidate', () => {
  const root = makeRoot({
    'packages/contracts/src/index.ts': ['export const Existing = 1;\n', OLD],
    'packages/contracts/src/index.test.ts': ['import { Existing } from "./index";\n', NEW],
    'packages/contracts/src/types.d.ts': ['export declare const Ghost: number;\n', NEW],
    'packages/contracts/src/__tests__/helper.ts': ['export const helper = 1;\n', NEW],
  });
  const summary = runTriage(root, errorMessage('Removed'));
  assert.equal(summary.stale_vite_cache_evidence, false, '*.test.ts / *.d.ts / __tests__ must not count as newer sources');
  assert.equal(summary.failures[0].classification, 'real_candidate');
  assert.match(summary.failures[0].reason, /export が無い/);
});

test('a source newer than the cache plus a real export is classified as environmental', () => {
  const root = makeRoot({
    'packages/contracts/src/index.ts': ['export const Existing = 1;\nexport function Renamed() {}\n', NEW],
  });
  const summary = runTriage(root, errorMessage('Renamed'));
  assert.equal(summary.stale_vite_cache_evidence, true);
  assert.equal(summary.failures[0].classification, 'env_stale_vite_cache');
});

test('an export re-exported through a brace list counts as present', () => {
  const root = makeRoot({
    'packages/contracts/src/model.ts': ['const inner = 1;\nexport { inner as Reexported };\n', NEW],
  });
  const summary = runTriage(root, errorMessage('Reexported'));
  assert.equal(summary.failures[0].classification, 'env_stale_vite_cache');
});

test('--stale-vite-cache does not replace the export lookup', () => {
  const root = makeRoot({
    'packages/contracts/src/index.ts': ['export const Existing = 1;\n', OLD],
  });
  const summary = runTriage(root, errorMessage('Removed'), ['--stale-vite-cache']);
  assert.equal(summary.stale_vite_cache_evidence, true, 'the flag itself is still recorded as evidence');
  assert.equal(summary.failures[0].classification, 'real_candidate');
  assert.match(summary.failures[0].reason, /export の削除\/改名/);
});

test('an export that exists without cache evidence stays a real candidate', () => {
  const root = makeRoot({
    'packages/contracts/src/index.ts': ['export const Existing = 1;\n', OLD],
  });
  const summary = runTriage(root, errorMessage('Existing'));
  assert.equal(summary.stale_vite_cache_evidence, false);
  assert.equal(summary.failures[0].classification, 'real_candidate');
  assert.match(summary.failures[0].reason, /証拠（mtime/);
});

test('an unknown package cannot be cleared as environmental', () => {
  const root = makeRoot({ 'packages/contracts/src/index.ts': ['export const Existing = 1;\n', NEW] });
  const summary = runTriage(root, "SyntaxError: The requested module './x.js' does not provide an export named 'Whatever'");
  assert.equal(summary.failures[0].classification, 'real_candidate');
  assert.match(summary.failures[0].reason, /特定できず/);
});
