import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBuild } from './test-support/msvc-build';

const native = (name: string) =>
  readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');

const msvc = findBuild();
const clang =
  process.platform !== 'win32' &&
  spawnSync('clang++', ['--version'], { stdio: 'ignore' }).status === 0;

it.runIf(msvc !== null || clang)(
  'runs supported browser page evidence and origin native cases',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'sc-browser-page-'));
    try {
      const output = join(directory, 'page-tests.exe');
      const source = join(__dirname, '../../computer-use-native/computer_use_protocol_fuzz.cc');
      const command = msvc
        ? msvc.wrap([
            '/nologo',
            '/std:c++20',
            '/EHsc',
            '/utf-8',
            source,
            `/Fe:${output}`,
            `/Fo:${output}.obj`,
          ])
        : { file: 'clang++', args: ['-std=c++20', source, '-o', output], verbatim: false };
      const built = spawnSync(command.file, command.args, {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
        timeout: 120_000,
      });
      expect(built.status, `${built.error ?? ''}\n${built.stdout}\n${built.stderr}`).toBe(0);
      const ran = spawnSync(output, [], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      expect(ran.status, `${ran.error ?? ''}\n${ran.stdout}\n${ran.stderr}`).toBe(0);
      expect(ran.stdout).toContain('Supported browser page evidence: PASS');
      expect(ran.stdout).toContain('Windows page origin: PASS');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  150_000,
);

describe('Windows page origin metadata (N11-B)', () => {
  it('isolates the bounded metadata walk from the legacy capture budget', () => {
    const reader = native('computer_use_windows_shadow_reader.h');
    expect(reader).toContain('kOriginMaxCalls = 128');
    expect(reader).toContain("kOriginDeadlineNs = 30'000'000");
    expect(reader).toContain('if (OriginWithinBudget()) capture->page_origin');
    expect(reader.indexOf('capture.budget_exhausted = gate_.BudgetExhausted()')).toBeLessThan(
      reader.indexOf('CapturePageOrigin(root, &capture)'),
    );
    const harness = native('computer_use_protocol_fuzz.cc');
    for (const name of [
      'winorigin-budget-isolated-from-legacy-capture',
      'winorigin-budget-preserves-classification-and-interlock',
      'winorigin-budget-preserves-subsequent-read',
    ])
      expect(harness).toContain(name);
  });

  it('classifies a freshly verified unique supported browser Document without enabling actions', () => {
    const reader = native('computer_use_windows_shadow_reader.h');
    expect(reader).toContain('CapturePageOrigin(root, &capture)');
    expect(reader).toContain('ClassifyPageOrigin(url).state');
    expect(reader).toContain('ScanPageDocuments(');
    expect(reader).not.toContain('ScanDocuments(');
    expect(reader).toContain('capture.page_origin = OriginState::kUnknown');
    const shadow = native('computer_use_windows_shadow.h');
    expect(shadow.match(/page_origin/gu)).toHaveLength(1);
    expect(native('computer_use_protocol_fuzz.cc')).toContain('CheckWindowsPageOrigin()');
    expect(native('computer_use_windows_uia_source.h')).toContain(
      'get_CurrentValue(value.Receive())',
    );
  });
});

describe('Windows page recheck (N11-C)', () => {
  it('skips page comparison and invalidation for observe-only sessions', () => {
    const observe = native('computer_use_windows_host_pipe.inc');
    expect(observe).toContain('session.maximum_mode != "observe_only" && session.has_observation');
    expect(observe).toContain(
      'session.maximum_mode != "observe_only" && (observed_page.web || current_page.web)',
    );
  });
  it('binds the observation to tickets and approval remeasurement without extending the wire', () => {
    const input = native('computer_use_windows_host_input.inc');
    const preflight = native('computer_use_windows_host_preflight.inc');
    const observe = native('computer_use_windows_host_pipe.inc');
    expect(input).toContain('WindowsPageBinding(session.observed_page)');
    expect(input).toContain('if (!RecheckWindowsPage(session))');
    expect(preflight).toContain('input.identity.window_identity.value += ":" + WindowsPageBinding');
    expect(preflight.match(/if \(!RecheckWindowsPage\(session\)\)/gu)).toHaveLength(2);
    expect(preflight).toContain('InvalidateWindowsPage(session)');
    const common = native('computer_use_windows_host_common.inc');
    expect(common).toContain('approval->second.Invalidate()');
    expect(common).toContain('InvalidateWindowsTicket(key)');
    expect(observe).toContain('WindowsPageAllowsInput(session.observed_page, current_page)');
    expect(observe).toContain('std::swap(session.observed_page, observed_page)');
  });

  it('covers page changes, card return, confirmation changes and unreadable origins in native components', () => {
    const harness = native('computer_use_protocol_fuzz.cc');
    for (const name of [
      'tab_switch_invalidates_pending_action',
      'same_origin_other_tab_rejects_old_approval',
      'approval_return_rechecks_sensitive_surface',
      'confirmation_change_invalidates_approval',
      'unreadable_origin_never_reuses_previous_origin',
      'same_origin_navigation_invalidates_page',
      'native-window-page-check-is-neutral',
    ])
      expect(harness).toContain(name);
    expect(harness).toContain('if (!CheckWindowsPageRecheck()) return 1;');
    const reader = native('computer_use_windows_shadow_reader.h');
    expect(reader).toContain('PageDocumentStillCurrent(root, document)');
    expect(reader).toContain('const bool within = OriginWithinBudget()');
    expect(native('computer_use_origin_classify.h')).toContain('kOriginClassificationVersion = 1');
  });
});
