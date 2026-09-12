#!/usr/bin/env node
// Summarize a Playwright JSON report (PLAYWRIGHT_JSON_OUTPUT_NAME / --reporter=json) into
// <out>/triage.json and <out>/triage.md with a classification hint and a stable fingerprint per failure.
//   node triage-e2e.mjs <report.json> --out DIR [--repo owner/repo]
// Hints are only hints: the sprint-coder-e2e skill's 4-way split (env / opt-in skip / known flake /
// real) is decided by the operator after an independent re-run of each real candidate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const reportPath = argv[0];
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const outDir = opt('--out', path.dirname(reportPath ?? '.'));
const repo = opt('--repo', 'Robbits-CO-LTD/sprint-coder');
if (!reportPath || !fs.existsSync(reportPath)) { console.error('usage: triage-e2e.mjs <report.json> --out DIR'); process.exit(64); }
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const ANSI = new RegExp('\\u001b\\[[0-9;]*m', 'g');
const stripAnsi = (s) => String(s ?? '').replace(ANSI, '');

const tests = [];
function walk(suite, file, titles) {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const results = t.results ?? [];
      const last = results[results.length - 1];
      tests.push({
        file, line: spec.line, title: [...titles, spec.title].join(' › '),
        status: t.status, outcome: last?.status ?? 'unknown',
        errors: results.flatMap((r) => (r.errors ?? []).map((e) => stripAnsi(e.message))),
        stdout: results.flatMap((r) => (r.stdout ?? []).map((o) => stripAnsi(o.text ?? ''))),
        annotations: (t.annotations ?? []).map((a) => `${a.type}${a.description ? `: ${a.description}` : ''}`),
        durationMs: results.reduce((a, r) => a + (r.duration ?? 0), 0),
      });
    }
  }
  for (const s of suite.suites ?? []) walk(s, file, [...titles, s.title]);
}
for (const s of report.suites ?? []) walk(s, s.file ?? s.title, []);

const ENV_RE = /Packaged app not found|did not become ready|electron-forge package|ECONNREFUSED[^\n]*5173|NODE_MODULE_VERSION|Sprint Coder API unavailable/i;
const FIRSTWINDOW_RE = /firstWindow|Timeout \d+ms exceeded[^\n]*firstWindow/i;
const OPTIN_FILE_RE = /leader-mcp-smoke|leader-mcp-codex-smoke|cli-workspace-egress/;
const failures = tests.filter((t) => t.status === 'unexpected' || t.status === 'flaky');
const firstWindowFails = failures.filter((t) => t.errors.some((e) => FIRSTWINDOW_RE.test(e))).length;
const wholesaleEnv = tests.length > 0 && firstWindowFails >= Math.max(3, Math.ceil(tests.length * 0.8));

function errorClass(msg) {
  const m = /(expect\([^)]*\)\.[A-Za-z]+|TimeoutError|Test timeout|[A-Z][A-Za-z]*Error)/.exec(msg ?? '');
  return m ? m[1] : 'unknown';
}
// Normalize run-specific values out of the expectation delta so that two independent reproductions of
// the same defect hash to the same fingerprint: paths, UUIDs, timestamps, mixed alphanumeric tokens
// (nonces, temp-dir suffixes, ids), long hex, and numbers.
function normalize(s) {
  return String(s ?? '')
    .replace(/[A-Za-z]:\\[^\s'"`)]+/g, 'PATH')
    .replace(/(?:~|\/)[^\s'"`)]*\/[^\s'"`)]*/g, 'PATH')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID')
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, 'TS')
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{6,}\b/g, 'TOK')
    .replace(/[0-9a-f]{6,}/gi, 'H')
    .replace(/\d+/g, 'N');
}
function delta(msg) {
  const lines = (msg ?? '').split('\n').map((l) => l.trim());
  const exp = lines.find((l) => /^Expected/.test(l)) ?? '';
  const rec = lines.find((l) => /^Received/.test(l)) ?? '';
  return normalize(`${exp} | ${rec}`).slice(0, 200);
}
function classify(t) {
  const msg = t.errors.join('\n');
  if (t.status === 'skipped') return OPTIN_FILE_RE.test(t.file) || /opt-in/i.test(t.annotations.join(' ')) ? 'optin_skip' : 'skipped';
  if (t.status === 'expected') return 'pass';
  if (wholesaleEnv && FIRSTWINDOW_RE.test(msg)) return 'env_wholesale';
  if (ENV_RE.test(msg)) return 'env';
  if (/command-runner-flow\.spec\.ts$/.test(t.file) && /toBeFocused|focus/i.test(msg)) return 'known_flake';
  if (t.status === 'flaky') return 'flaky_in_run';
  return 'real_candidate';
}
const rows = tests.map((t) => {
  const cls = classify(t);
  const first = t.errors[0] ?? '';
  const fp = cls === 'pass' || cls === 'optin_skip' || cls === 'skipped' ? null
    : crypto.createHash('sha256').update([repo, 'phase1', t.file, normalize(t.title), errorClass(first), delta(first)].join('|')).digest('hex');
  return { ...t, classification: cls, errorClass: errorClass(first), delta: delta(first), firstError: first.slice(0, 400), fingerprint: fp };
});
const perf = rows.filter((r) => /perf-budgets/.test(r.file)).flatMap((r) => r.stdout.filter((l) => /startup|p95|fps|ms/i.test(l)).map((l) => l.trim()));
const stats = report.stats ?? {};
const summary = {
  report: reportPath, repo, generated_at: new Date().toISOString(),
  totals: { tests: tests.length, expected: stats.expected ?? 0, unexpected: stats.unexpected ?? 0, flaky: stats.flaky ?? 0, skipped: stats.skipped ?? 0, duration_ms: stats.duration ?? null },
  wholesale_env: wholesaleEnv,
  by_class: rows.reduce((a, r) => ((a[r.classification] = (a[r.classification] ?? 0) + 1), a), {}),
  failures: rows.filter((r) => !['pass', 'skipped', 'optin_skip'].includes(r.classification)),
  skipped: rows.filter((r) => ['skipped', 'optin_skip'].includes(r.classification)).map((r) => ({ file: r.file, title: r.title, classification: r.classification, annotations: r.annotations })),
  perf_lines: perf,
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'triage.json'), JSON.stringify(summary, null, 2) + '\n');
const md = [];
md.push(`# E2E triage (${summary.generated_at})`, '');
md.push(`結果: ${summary.totals.expected} passed / ${summary.totals.unexpected} failed / ${summary.totals.skipped} skipped / ${summary.totals.flaky} flaky （${summary.totals.duration_ms != null ? Math.round(summary.totals.duration_ms / 1000) + ' 秒' : '所要不明'}）`, '');
if (wholesaleEnv) md.push('> **環境起因の疑い**: 大半のテストが firstWindow で同形に死んでいる。native 前提（prepare:desktop）と dev server を先に疑うこと。', '');
md.push('| 分類 | 件数 |', '|---|---|', ...Object.entries(summary.by_class).map(([k, v]) => `| ${k} | ${v} |`), '');
if (summary.failures.length) {
  md.push('## 失敗（分類ヒント付き）', '');
  for (const f of summary.failures) {
    md.push(`### ${f.file}:${f.line} › ${f.title}`, '', `- 分類ヒント: **${f.classification}** (${f.errorClass})`, `- 期待/実測: ${f.delta || '(なし)'}`, `- fingerprint: \`${f.fingerprint}\``, '', '```', f.firstError, '```', '');
  }
} else md.push('## 失敗: なし', '');
if (summary.skipped.length) { md.push('## skip', '', ...summary.skipped.map((s) => `- ${s.classification}: ${s.file} › ${s.title}${s.annotations.length ? ` (${s.annotations.join('; ')})` : ''}`), ''); }
if (perf.length) md.push('## perf-budgets 実測', '', ...perf.map((l) => `- ${l}`), '');
fs.writeFileSync(path.join(outDir, 'triage.md'), md.join('\n'));
console.log(JSON.stringify({ out: outDir, totals: summary.totals, by_class: summary.by_class, wholesale_env: wholesaleEnv }));
