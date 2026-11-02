import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const directory = join(__dirname, '../../computer-use-native');
const read = (name: string): string =>
  name === 'computer_use_windows_host.cc'
    ? readWindowsHostSource()
    : readFileSync(join(directory, name), 'utf8');
const measurement = read('computer_use_effect_measurement.h');
const windows = read('computer_use_windows_approval_measurement.h');
const risk = read('computer_use_windows_risk_terms.h');
const harness = read('computer_use_protocol_fuzz.cc');
const terms = (name: string): string[] => {
  const body = new RegExp(`${name} = \\{([\\s\\S]*?)\\};`, 'u').exec(risk);
  expect(body, name).not.toBeNull();
  return [...body![1]!.matchAll(/u8"([^"]+)"/gu)].map((entry) => entry[1]!);
};

// Frozen Windows V1 vocabulary, including the matching mode. Do not derive it from the split.
const substring = [
  'payment',
  'checkout',
  'purchase',
  'billing',
  'credit card',
  'card number',
  'wire transfer',
  'contract',
  'agreement',
  'sign agreement',
  'installer',
  'install application',
  'administrator',
  'admin privileges',
  'sudo',
  'root access',
  'security settings',
  'privacy settings',
  'firewall',
  'accessibility permission',
  'screen recording permission',
  '決済',
  '支払い',
  '支払う',
  '購入',
  '注文を確定',
  '注文する',
  '請求',
  '送金',
  '契約',
  '署名',
  'インストール',
  '管理者',
  'セキュリティ',
  'プライバシー',
  'ファイアウォール',
];
const payment = [
  'pay',
  'pay now',
  'place order',
  'submit order',
  'complete order',
  'buy now',
  'pagar',
  'comprar',
  'acheter',
  'bestellen',
  'bezahlen',
  'pagare',
  'acquistare',
  'betalen',
  'kopen',
];
const shell = [
  'integrated terminal',
  'terminal',
  'console',
  'shell',
  'powershell',
  'command prompt',
  'cmd.exe',
  'pwsh',
  'wsl',
];

describe('Windows portable approval core (N8-1a)', () => {
  it('preserves the exact V1 union and matching modes', () => {
    expect([...terms('kConfirmationSubstring'), ...terms('kOtherSubstring')].sort()).toEqual(
      substring.sort(),
    );
    expect(terms('kConfirmationBounded').sort()).toEqual(payment.sort());
    expect(terms('kOtherBounded').sort()).toEqual(shell.sort());
    expect(risk).toContain('AnySubstring(lowercase_text, kConfirmationSubstring)');
    expect(risk).toContain('AnySubstring(lowercase_text, kOtherSubstring)');
    expect(risk).toContain('AnyBounded(lowercase_text, kConfirmationBounded)');
    expect(risk).toContain('AnyBounded(lowercase_text, kOtherBounded)');
    expect(read('computer_use_windows_host_uia_semantic.inc')).toContain(
      'ClassifyWindowsRiskText(text)',
    );
    expect(read('computer_use_windows_host.cc')).toContain(
      '#include "computer_use_windows_risk_terms.h"',
    );
  });

  it('uses the same facts core from AX and Windows, never the AX entry from Windows', () => {
    expect(measurement).toContain('MeasureApprovalFromFacts(');
    expect(measurement).toContain('return MeasureApprovalFromFacts(input, built.facts);');
    expect(windows).toContain('BuildWindowsShadowFacts(');
    expect(windows).toContain('WindowsCaptureChainOwnedBy(');
    expect(windows).toContain('WindowsCaptureTargetNotWeb(');
    expect(windows).toContain('return MeasureApprovalFromFacts(shared, built.facts);');
    for (const name of readdirSync(directory).filter(
      (name) => name.startsWith('computer_use_windows') && /\.(h|cc|inc)$/u.test(name),
    )) {
      expect(read(name), name).not.toMatch(/\bMeasureApproval\s*\(/u);
    }
  });

  it('rejects incomplete Windows metadata before the shared relaxation', () => {
    const source = read('computer_use_native_approved_risk.h');
    const entry = source.slice(source.indexOf('ClassifyWindowsNativeRisk('));
    expect(entry).toContain('bool metadata_complete');
    expect(entry.indexOf('if (!metadata_complete)')).toBeGreaterThanOrEqual(0);
    expect(entry.indexOf('if (!metadata_complete)')).toBeLessThan(
      entry.indexOf('return ClassifyNativeRisk('),
    );
  });

  it('ties portable behavioral regressions to the harness entry point', () => {
    expect(harness).toContain('if (!CheckWindowsApprovalCore()) return 1;');
    for (const name of [
      'windows-risk-frozen-v1',
      'windows-risk-incomplete-confirmation',
      'windows-risk-other-mixed',
      'windows-risk-secure',
      'windows-document-approval',
      'windows-document-closed',
      'windows-document-unsafe',
      'macos-new-extension-refused',
      'approval-extension-boundary',
      'approval-operation-table',
    ]) {
      expect(harness, name).toContain(`"${name}"`);
    }
  });

  it('links every ADR operation to the classifier positive cases, including confirmation toggle/select', () => {
    const adr = readFileSync(
      join(
        __dirname,
        '../../../../tasks/designs/adr-computer-use-windows-approval-path-20261102.md',
      ),
      'utf8',
    );
    const effects: Record<string, string> = {
      kSupervisedAction: 'supervised_action',
      kHighImpactConfirmation: 'high_impact_confirmation',
      kDownloadOpen: 'download_open',
      kFileManagerOpen: 'file_manager_open',
    };
    const actions: Record<string, string> = {
      kClick: 'click',
      kDoubleClick: 'double_click',
      kInvoke: 'invoke',
      kSetText: 'set_text',
      kType: 'type',
      kKey: 'key',
      kScroll: 'scroll',
      kSelect: 'select',
      kToggle: 'toggle',
      kExpandCollapse: 'expand_collapse',
    };
    const table = /kApprovalOperationCases\[\] = \{([\s\S]*?)\n\};/u.exec(harness)![1]!;
    const rows = [...table.matchAll(/NativeApprovalEffect::(\w+),\s*\{([^}]+)\}/gu)];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const effect = effects[row[1]!];
      expect(effect).toBeDefined();
      const line = adr.split(/\r?\n/u).find((line) => line.startsWith(`| \`${effect}\` |`));
      expect(line).toBeDefined();
      const operations = [...line!.split('|')[2]!.matchAll(/`([^`]+)`/gu)].map((entry) => entry[1]);
      const positive = [...row[2]!.matchAll(/ActionKind::(\w+)/gu)].map(
        (entry) => actions[entry[1]!],
      );
      expect(positive).not.toContain(undefined);
      expect(positive.sort()).toEqual(operations.sort());
    }
    const existing =
      /for \(const ActionKind action : \{([^}]+)\}\) \{\s*const auto decision = ClassifyEffect\(EffLabel\(label, action\)\);[\s\S]*?"effect-confirm"/u.exec(
        harness,
      );
    expect(existing).not.toBeNull();
    const confirmation = rows.find((row) => row[1] === 'kHighImpactConfirmation')![2]!;
    for (const action of existing![1]!.matchAll(/ActionKind::(\w+)/gu)) {
      expect(confirmation).toContain(`ActionKind::${action[1]}`);
    }
    expect(confirmation).toContain('ActionKind::kToggle');
    expect(confirmation).toContain('ActionKind::kSelect');
  });
});
