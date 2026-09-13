#!/usr/bin/env node
// Summarize a Playwright JSON report (PLAYWRIGHT_JSON_OUTPUT_NAME / --reporter=json) into
// <out>/triage.json and <out>/triage.md with a classification hint and a stable fingerprint per failure.
//   node triage-e2e.mjs <report.json> --out DIR [--repo owner/repo] [--repo-root DIR]
//        [--stale-vite-cache <pkg>[,<pkg>…]]
// Hints are only hints: the sprint-coder-e2e skill's 4-way split (env / opt-in skip / known flake /
// real) is decided by the operator after an independent re-run of each real candidate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

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
// "does not provide an export named 'X'" is environmental ONLY when both hold: THAT package's Vite
// optimize cache is provably older than its runtime sources (--stale-vite-cache, or the mtimes at
// triage time) AND the package still exports X as a runtime VALUE. The same SyntaxError is a real
// regression when an export was removed, renamed or turned into a type-only export, so the lookup is
// never skipped — the flag replaces the mtime evidence, not the lookup. Test sources are ignored by
// the mtime scan: touching a *.test.ts must not turn a genuine missing export into an env story.
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
// Staleness is decided PER PACKAGE: one @sprint-coder_<pkg>.js bundle can be days old while another
// was just rebuilt, and collapsing them into one max mtime hides exactly the stale one.
function workspacePackages() {
  try { return fs.readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}
function stalePackages() {
  const stale = new Set();
  const deps = path.join(repoRoot, 'apps', 'desktop', 'node_modules', '.vite', 'deps');
  let files = [];
  try { files = fs.readdirSync(deps); } catch { return stale; }
  for (const pkg of workspacePackages()) {
    const re = new RegExp(`^@sprint-coder_${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.[^/]*)?\\.js$`);
    const bundles = files.filter((f) => re.test(f));
    if (bundles.length === 0) continue; // never optimized => nothing to be stale
    let cache = 0;
    for (const f of bundles) { try { cache = Math.max(cache, fs.statSync(path.join(deps, f)).mtimeMs); } catch { /* raced */ } }
    if (newestMtime(path.join(repoRoot, 'packages', pkg, 'src')) > cache) stale.add(pkg);
  }
  return stale;
}
// --stale-vite-cache takes the packages the operator SAW go stale (contracts,domain): staleness is a
// per-package fact, so a bare flag that vouches for every package is not accepted.
const flagIdx = argv.indexOf('--stale-vite-cache');
const flagValue = flagIdx >= 0 ? argv[flagIdx + 1] : null;
if (flagIdx >= 0 && (!flagValue || flagValue.startsWith('--'))) {
  console.error('--stale-vite-cache needs the package list it applies to, e.g. --stale-vite-cache contracts,domain');
  process.exit(64);
}
const flagPkgs = new Set((flagValue ?? '').split(',').map((x) => x.trim()).filter(Boolean));
const stalePkgs = stalePackages();
const staleFor = (pkg) => Boolean(pkg) && (flagPkgs.has(pkg) || stalePkgs.has(pkg));
const staleCache = flagPkgs.size > 0 || stalePkgs.size > 0;
// Only VALUE exports count: `export type` / `export interface` / `export declare …` are erased at
// build time, so treating them as exports would clear a genuine "imported a value that no longer
// exists" regression. The lookup starts at the package's public entrypoint
// (packages/<pkg>/src/index.ts) and follows its `export { … } from` re-exports; `export * from` is
// NOT followed and yields null (cannot tell). Parsing is the repo's own typescript and nothing else:
// comments, strings, regex literals and ambient declarations must not be mistaken for real exports,
// and a hand-written scanner cannot promise that — when typescript does not resolve, every lookup is
// "cannot tell" and no failure is ever cleared as environmental.
const require_ = createRequire(import.meta.url);
let ts = null;
if (!process.env.TRIAGE_E2E_NO_TS) { try { ts = require_('typescript'); } catch { ts = null; } }
function resolveModule(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // a bare specifier leaves this package: cannot tell
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ''));
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    try { if (fs.statSync(cand).isFile()) return cand; } catch { /* next candidate */ }
  }
  return null;
}
function astExportMap(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const map = { values: new Set(), locals: new Set(), named: [], wildcards: false };
  const has = (n, kind) => (n.modifiers ?? []).some((m) => m.kind === kind);
  const runtimeExport = (n) => has(n, ts.SyntaxKind.ExportKeyword) && !has(n, ts.SyntaxKind.DeclareKeyword) && !has(n, ts.SyntaxKind.DefaultKeyword);
  for (const st of sf.statements) {
    // declare module / declare global blocks and type-only statements never produce runtime exports
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        map.locals.add(d.name.text);
        if (runtimeExport(st)) map.values.add(d.name.text);
      }
    } else if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) {
      if (!st.name) continue;
      map.locals.add(st.name.text);
      if (runtimeExport(st)) map.values.add(st.name.text);
    } else if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      if (!st.exportClause) { map.wildcards = true; continue; }
      if (ts.isNamespaceExport(st.exportClause)) { map.values.add(st.exportClause.name.text); continue; }
      for (const sp of st.exportClause.elements) {
        if (sp.isTypeOnly) continue;
        map.named.push({ exported: sp.name.text, local: (sp.propertyName ?? sp.name).text, from });
      }
    }
  }
  return map;
}
const mapCache = new Map();
function exportMapFor(file) {
  if (mapCache.has(file)) return mapCache.get(file);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
  let map = null;
  if (text !== null && ts) { try { map = astExportMap(file, text); } catch { map = null; } }
  mapCache.set(file, map);
  return map;
}
// true = exported as a runtime value, false = not exported, null = cannot tell (fail closed).
function fileExportsValue(file, name, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const map = exportMapFor(file);
  if (!map) return null;
  if (map.values.has(name)) return true;
  let unknown = map.wildcards; // an unfollowed `export * from` can always be hiding the name
  for (const sp of map.named) {
    if (sp.exported !== name) continue;
    if (sp.from === null && map.locals.has(sp.local)) return true; // local value re-exported by name
    if (sp.from) {
      const target = resolveModule(file, sp.from);
      const deeper = target ? fileExportsValue(target, sp.local, seen) : null;
      if (deeper === true) return true;
      unknown = unknown || deeper === null;
    } else unknown = true; // re-exported import alias, or a specifier we could not resolve
  }
  return unknown ? null : false;
}
const exportLookup = new Map();
function packageExportsValue(pkg, name) {
  const key = `${pkg}#${name}`;
  if (exportLookup.has(key)) return exportLookup.get(key);
  const entry = ['index.ts', 'index.tsx'].map((f) => path.join(repoRoot, 'packages', pkg, 'src', f)).find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  const result = entry ? fileExportsValue(entry, name) : null;
  exportLookup.set(key, result);
  return result;
}
function classifyMissingExport(msg) {
  const name = MISSING_EXPORT_RE.exec(msg)[1];
  const pkg = (PKG_RE.exec(msg) ?? [])[1] ?? null;
  const has = pkg ? packageExportsValue(pkg, name) : null;
  if (has === null) return { cls: 'real_candidate', reason: `'${name}' が値として export されているか確認できない（pkg=${pkg ?? '不明'}: entrypoint 不明 / export * 経由 / typescript 不在）ので環境起因と断定しない` };
  if (has === false) return { cls: 'real_candidate', reason: `@sprint-coder/${pkg} の entrypoint に '${name}' の値 export が無い（型だけ、または削除/改名）→ キャッシュではなくコード側の疑い` };
  if (!staleFor(pkg)) return { cls: 'real_candidate', reason: `@sprint-coder/${pkg} は '${name}' を値 export しているが、この package の Vite 依存キャッシュ陳腐化の証拠（mtime / --stale-vite-cache ${pkg}）が無い` };
  return { cls: 'env_stale_vite_cache', reason: `@sprint-coder/${pkg} は '${name}' を値 export しており、この package の依存キャッシュが source より古い` };
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
  // Before the wholesale check: a removed export makes every spec die at firstWindow too, and
  // "80% failed the same way" must not launder it into an environment story.
  if (MISSING_EXPORT_RE.test(msg)) return classifyMissingExport(msg);
  if (wholesaleEnv && FIRSTWINDOW_RE.test(msg)) return { cls: 'env_wholesale', reason: '' };
  if (ENV_RE.test(msg)) return { cls: 'env', reason: '' };
  if (OUTDATED_DEP_RE.test(msg)) {
    const pkg = (PKG_RE.exec(msg) ?? [])[1] ?? null;
    if (!pkg) return { cls: 'real_candidate', reason: 'Outdated Optimize Dep だが対象 package を特定できず、陳腐化の証拠と結び付けられない' };
    return staleFor(pkg)
      ? { cls: 'env_stale_vite_cache', reason: `Outdated Optimize Dep + @sprint-coder/${pkg} の依存キャッシュが source より古い` }
      : { cls: 'real_candidate', reason: `Outdated Optimize Dep だが @sprint-coder/${pkg} の陳腐化の証拠が無い` };
  }
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
  stale_vite_cache_packages: [...stalePkgs].sort(), stale_vite_cache_flag_packages: [...flagPkgs].sort(),
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
