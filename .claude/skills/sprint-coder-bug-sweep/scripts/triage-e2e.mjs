#!/usr/bin/env node
// Summarize a Playwright JSON report (PLAYWRIGHT_JSON_OUTPUT_NAME / --reporter=json) into
// <out>/triage.json and <out>/triage.md with a classification hint and a stable fingerprint per failure.
//   node triage-e2e.mjs <report.json> --out DIR [--repo owner/repo] [--stale-vite-cache] [--repo-root DIR]
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
// "does not provide an export named 'X'" is environmental ONLY when both hold: Vite's optimize cache
// is provably older than the shipped package sources (--stale-vite-cache, or the mtimes at triage
// time) AND the package really exports X today. The same SyntaxError is a real regression when an
// export was removed/renamed without updating its importer, so the export lookup is never skipped —
// the flag replaces the mtime evidence, not the lookup. Test sources are ignored by the mtime scan:
// touching a *.test.ts must not turn a genuine missing export into an environment story.
const MISSING_EXPORT_RE = /does not provide an export named ['"`]?([A-Za-z_$][A-Za-z0-9_$]*)/;
const OUTDATED_DEP_RE = /Outdated Optimize Dep/i;
const PKG_RE = /@sprint-coder[_/]([a-z0-9][a-z0-9-]*)/i;
const repoRoot = opt('--repo-root', process.env.REPO_ROOT ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..'));
const NON_SOURCE_RE = /(?:\.test\.tsx?|\.spec\.tsx?|\.d\.ts)$/;
function sourceFiles(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); }
      else if (/\.tsx?$/.test(e.name) && !NON_SOURCE_RE.test(e.name)) files.push(p);
    }
  };
  try { walk(dir); } catch { /* missing dir */ }
  return files;
}
function newestMtime(dir) {
  let newest = 0;
  for (const f of sourceFiles(dir)) { try { newest = Math.max(newest, fs.statSync(f).mtimeMs); } catch { /* raced */ } }
  return newest;
}
function viteCacheStale() {
  try {
    const deps = path.join(repoRoot, 'apps', 'desktop', 'node_modules', '.vite', 'deps');
    const files = fs.readdirSync(deps).filter((f) => /^@sprint-coder_.*\.js$/.test(f));
    if (files.length === 0) return false;
    const cache = Math.max(...files.map((f) => fs.statSync(path.join(deps, f)).mtimeMs));
    return newestMtime(path.join(repoRoot, 'packages', 'contracts', 'src')) > cache || newestMtime(path.join(repoRoot, 'packages', 'domain', 'src')) > cache;
  } catch { return false; }
}
const staleCache = argv.includes('--stale-vite-cache') || viteCacheStale();
// true = the package source exports the name today, false = it does not, null = cannot tell.
const exportLookup = new Map();
function packageExportsName(pkg, name) {
  const key = `${pkg}#${name}`;
  if (exportLookup.has(key)) return exportLookup.get(key);
  const dir = path.join(repoRoot, 'packages', pkg, 'src');
  const files = sourceFiles(dir);
  let result = files.length === 0 ? null : false;
  const declared = new RegExp(`export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:const|let|var|function\\s*\\*?|class|type|interface|enum|namespace)\\s+${name}\\b`);
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (declared.test(text)) { result = true; break; }
    for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
      const named = m[1].split(',').map((s) => s.trim().replace(/^type\s+/, '')).map((s) => (/\sas\s/.test(s) ? s.split(/\s+as\s+/)[1].trim() : s));
      if (named.includes(name)) { result = true; break; }
    }
    if (result) break;
  }
  exportLookup.set(key, result);
  return result;
}
function classifyMissingExport(msg) {
  const name = MISSING_EXPORT_RE.exec(msg)[1];
  const pkg = (PKG_RE.exec(msg) ?? [])[1] ?? null;
  const has = pkg ? packageExportsName(pkg, name) : null;
  if (has === null) return { cls: 'real_candidate', reason: `export '${name}' の提供元 package を特定できず（pkg=${pkg ?? '不明'}）、環境起因と断定できない` };
  if (has === false) return { cls: 'real_candidate', reason: `@sprint-coder/${pkg} の src に '${name}' の export が無い → キャッシュではなく export の削除/改名の疑い` };
  if (!staleCache) return { cls: 'real_candidate', reason: `@sprint-coder/${pkg} は '${name}' を export しているが、Vite 依存キャッシュ陳腐化の証拠（mtime / --stale-vite-cache）が無い` };
  return { cls: 'env_stale_vite_cache', reason: `@sprint-coder/${pkg} は '${name}' を export しており、依存キャッシュが source より古い` };
}
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
  if (t.status === 'skipped') return { cls: OPTIN_FILE_RE.test(t.file) || /opt-in/i.test(t.annotations.join(' ')) ? 'optin_skip' : 'skipped', reason: '' };
  if (t.status === 'expected') return { cls: 'pass', reason: '' };
  if (wholesaleEnv && FIRSTWINDOW_RE.test(msg)) return { cls: 'env_wholesale', reason: '' };
  if (ENV_RE.test(msg)) return { cls: 'env', reason: '' };
  if (MISSING_EXPORT_RE.test(msg)) return classifyMissingExport(msg);
  if (OUTDATED_DEP_RE.test(msg)) return staleCache
    ? { cls: 'env_stale_vite_cache', reason: 'Outdated Optimize Dep + 依存キャッシュが source より古い' }
    : { cls: 'real_candidate', reason: 'Outdated Optimize Dep だがキャッシュ陳腐化の証拠が無い' };
  if (/command-runner-flow\.spec\.ts$/.test(t.file) && /toBeFocused|focus/i.test(msg)) return { cls: 'known_flake', reason: '' };
  if (t.status === 'flaky') return { cls: 'flaky_in_run', reason: '' };
  return { cls: 'real_candidate', reason: '' };
}
const rows = tests.map((t) => {
  const { cls, reason } = classify(t);
  const first = t.errors[0] ?? '';
  const fp = cls === 'pass' || cls === 'optin_skip' || cls === 'skipped' ? null
    : crypto.createHash('sha256').update([repo, 'phase1', t.file, normalize(t.title), errorClass(first), delta(first)].join('|')).digest('hex');
  return { ...t, classification: cls, reason, errorClass: errorClass(first), delta: delta(first), firstError: first.slice(0, 400), fingerprint: fp };
});
const perf = rows.filter((r) => /perf-budgets/.test(r.file)).flatMap((r) => r.stdout.filter((l) => /startup|p95|fps|ms/i.test(l)).map((l) => l.trim()));
const stats = report.stats ?? {};
const summary = {
  report: reportPath, repo, generated_at: new Date().toISOString(), stale_vite_cache_evidence: staleCache,
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
const sidebarTimeouts = rows.filter((r) => r.classification !== 'pass' && /sidebar-new-task-button|composer-textarea/.test(r.firstError) && /Timeout/.test(r.firstError)).length;
if (sidebarTimeouts >= Math.max(3, Math.ceil(tests.length * 0.5))) md.push('> **renderer が起動していない疑い**: window は開くが sidebar/composer が現れずに timeout する失敗が大半。Vite の依存キャッシュ（apps/desktop/node_modules/.vite/deps）が workspace パッケージの新しい export を含まない可能性が高い。`rm -rf apps/desktop/node_modules/.vite node_modules/.vite` して dev server を再起動し、Computer Use の app_screenshot で forge window が真っ黒でないことを確認する。', '');
md.push('| 分類 | 件数 |', '|---|---|', ...Object.entries(summary.by_class).map(([k, v]) => `| ${k} | ${v} |`), '');
if (summary.failures.length) {
  md.push('## 失敗（分類ヒント付き）', '');
  for (const f of summary.failures) {
    md.push(`### ${f.file}:${f.line} › ${f.title}`, '', `- 分類ヒント: **${f.classification}** (${f.errorClass})`, ...(f.reason ? [`- 分類の根拠: ${f.reason}`] : []), `- 期待/実測: ${f.delta || '(なし)'}`, `- fingerprint: \`${f.fingerprint}\``, '', '```', f.firstError, '```', '');
  }
} else md.push('## 失敗: なし', '');
if (summary.skipped.length) { md.push('## skip', '', ...summary.skipped.map((s) => `- ${s.classification}: ${s.file} › ${s.title}${s.annotations.length ? ` (${s.annotations.join('; ')})` : ''}`), ''); }
if (perf.length) md.push('## perf-budgets 実測', '', ...perf.map((l) => `- ${l}`), '');
fs.writeFileSync(path.join(outDir, 'triage.md'), md.join('\n'));
console.log(JSON.stringify({ out: outDir, totals: summary.totals, by_class: summary.by_class, wholesale_env: wholesaleEnv }));
