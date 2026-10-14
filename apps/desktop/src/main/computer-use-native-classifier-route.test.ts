import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// C4-0: the classifier route Main bound a session to reaches the macOS addon and is kept there.
// Nothing reads it to decide anything yet (the change that issues approval intents is the first
// reader), so this is a source contract on how it is parsed, written and compared.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const macos = readFileSync(join(nativeDirectory, 'computer_use_macos.mm'), 'utf8');
const windows = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');

function between(start: string, end: string): string {
  const from = macos.indexOf(start);
  const to = macos.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return macos.slice(from, to);
}

describe('macOS addon: the bound classifier route (C4-0)', () => {
  it('parses an optional key that is exactly "v1" or "v2", and defaults to v1', () => {
    const reader = between(
      'bool ReadOptionalClassifierRoute(',
      'bool ReadNamedString(napi_env env, napi_value object, const char* name, std::string* output,\n                     std::size_t maximum) {',
    );
    expect(reader).toContain('"classifierRoute"');
    expect(reader).toMatch(/if \(!has_property\) \{\s*\*output = "v1";\s*return true;\s*\}/u);
    expect(reader).toMatch(/value != "v1" && value != "v2"/u);
    // A value longer than two bytes never reaches the comparison.
    expect(reader).toMatch(/ReadNamedString\(env, object, "classifierRoute", &value, 2\)/u);
    expect(macos).toContain(
      '!ReadOptionalClassifierRoute(env, argv[0], &request.classifier_route)',
    );
  });

  it('writes the route once, at creation, and refuses a different one on reuse before any OS read', () => {
    const start = between('napi_value StartSession(', 'napi_value promise;');
    expect(start.match(/->classifier_route = /gu)).toHaveLength(1);
    expect(start).toContain('work->session->classifier_route = request.classifier_route;');
    // The write sits with the other immutable bindings, before the session is registered pending.
    expect(start.indexOf('->classifier_route = ')).toBeLessThan(
      start.indexOf('mac_pending_sessions.emplace('),
    );
    expect(start).toContain(
      'classifier_route_changed = work->session->classifier_route != request.classifier_route;',
    );
    expect(start).toMatch(
      /if \(classifier_route_changed\)\s*return ThrowNativeError\(env, "CLASSIFIER_ROUTE_CHANGED"/u,
    );
    // The check comes before the promise and the async work: nothing is read for a changed route.
    expect(start.indexOf('if (classifier_route_changed)')).toBeGreaterThan(
      start.indexOf('if (session_ids_reused)'),
    );
  });

  it('is only stored: no decision, receipt, measurement or dispatch reads it yet', () => {
    const uses = [...macos.matchAll(/classifier_route/gu)].length;
    const start = between('napi_value StartSession(', 'napi_value promise;');
    const declarations = between('struct MacComputerUseSession {', 'std::uint32_t pid = 0;');
    const request = between('struct NativeStartSessionRequest {', 'CGRect requested_bounds{};');
    const startUses = [...start.matchAll(/classifier_route/gu)].length;
    const declarationUses = [...declarations.matchAll(/classifier_route/gu)].length;
    const requestUses = [...request.matchAll(/classifier_route/gu)].length;
    const parserUses = [
      ...between(
        'bool ReadOptionalClassifierRoute(',
        'bool ReadNamedString(napi_env env, napi_value object, const char* name, std::string* output,\n                     std::size_t maximum) {',
      ).matchAll(/classifier_route/gu),
    ].length;
    expect(parserUses).toBe(0);
    // Declaration + request member + the start path; nowhere else.
    expect(uses).toBe(startUses + declarationUses + requestUses);
    expect(macos).not.toContain('single_use_approval');
  });

  it('is sent to the macOS addon only: the Windows host does not know the key', () => {
    expect(windows).not.toContain('classifierRoute');
    expect(windows).not.toContain('classifier_route');
  });
});
