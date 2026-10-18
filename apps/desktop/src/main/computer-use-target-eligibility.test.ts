import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DENY_RULESET_PATHS,
  denyRulesetCanonicalText as generatorCanonicalText,
  loadDenyRuleset,
  materializeGoldenCases,
  renderDenyRulesetOutputs,
} from '../../../../generate-computer-use-deny-ruleset.mjs';
import { DENY_RULESET } from './computer-use-deny-ruleset.generated';
import {
  classifyTarget,
  classifyTargetExplained,
  denyRulesetCanonicalText,
  denyRulesetRecordedSha256,
  denyRulesetVersion,
  type TargetEligibility,
  type TargetEligibleMode,
  type TargetFacts,
  type TargetUpperMode,
} from './computer-use-target-eligibility';
import {
  randomTargetFacts,
  rankOf,
  refusalMutations,
  seededRandom,
} from './computer-use-target-eligibility-fixture';

// S5-c-3 (#500) PR-1: the shared target eligibility core. Nothing calls it yet.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const readNative = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const model = loadDenyRuleset();
const golden = materializeGoldenCases(model);

/**
 * Every content a platform's ruleset has ever had, by version. Changing what a platform sees
 * changes its hash: give it a new version in deny-ruleset.json and add the pair here (never edit
 * or remove a pair once it is on main; v2 was re-recorded on the unmerged PR-1 branch). Each
 * platform has its own versions (decision H).
 */
const RULESET_LEDGER: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  win32: {
    2: '06a9ae9573a2a192bb80a00a713736576bcdcade21eb199d12efb26952a4fb4f',
  },
};

describe('target eligibility core golden vectors', () => {
  it.each(golden.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const facts = entry.facts as unknown as TargetFacts;
    const explained = classifyTargetExplained(facts);
    expect({ kind: explained.verdict.kind, class: explained.denyClass }).toEqual(entry.expect);
    expect(classifyTarget(facts)).toEqual(explained.verdict);
    const admitted = entry.expect.kind === 'eligible' || entry.expect.kind === 'upper';
    expect(explained.route !== null).toBe(admitted);
  });

  it('covers every class and every route of the platforms it runs on', () => {
    const classes = new Set(golden.map((entry) => entry.expect.class).filter(Boolean));
    for (const entry of model.classes.filter((item) => item.verdict === 'denied'))
      expect(classes, entry.id).toContain(entry.id);
    const routes = new Set(
      golden.map((entry) => classifyTargetExplained(entry.facts as unknown as TargetFacts).route),
    );
    for (const route of model.routes) expect(routes, route.id).toContain(route.id);
    expect(golden.some((entry) => entry.expect.kind === 'upper')).toBe(true);
    expect(golden.some((entry) => entry.expect.kind === 'unresolvable')).toBe(true);
  });

  it('says nothing about a refusal but that it is one', () => {
    for (const entry of golden) {
      const verdict = classifyTarget(entry.facts as unknown as TargetFacts);
      if (verdict.kind === 'denied' || verdict.kind === 'unresolvable')
        expect(Object.keys(verdict)).toEqual(['kind']);
      else {
        expect(Object.keys(verdict).sort()).toEqual(['kind', 'maximumMode']);
        expect(verdict.maximumMode).toBe(
          verdict.kind === 'eligible' ? 'full_access_app' : 'observe_only',
        );
      }
    }
  });
});

describe('target eligibility core monotonicity', () => {
  const starts: { label: string; facts: TargetFacts }[] = golden.map((entry) => ({
    label: entry.name,
    facts: entry.facts as unknown as TargetFacts,
  }));
  const random = seededRandom(0x500c3);
  const admitted = starts.filter((start) => rankOf(start.facts) > 0);
  for (let index = 0; index < 400; index++)
    starts.push({ label: `random ${index}`, facts: randomTargetFacts(random) });
  // Near an admitted target, where a single refusal signal is what decides.
  for (let index = 0; index < 400; index++)
    starts.push({
      label: `near ${index}`,
      facts: randomTargetFacts(random, admitted[index % admitted.length]!.facts),
    });

  it('never makes a target more eligible when a refusal signal is added or a fact is unmeasured', () => {
    let checked = 0;
    let admittedStarts = 0;
    for (const start of starts) {
      const before = rankOf(start.facts);
      if (before > 0) admittedStarts++;
      for (const mutation of refusalMutations(start.facts)) {
        checked++;
        const after = rankOf(mutation.facts);
        if (after > before)
          throw new Error(`${start.label}: ${mutation.label} made it more eligible`);
      }
    }
    // The property is not vacuous: many starts are admitted and many mutations were applied.
    expect(admittedStarts).toBeGreaterThan(100);
    expect(checked).toBeGreaterThan(10_000);
  });

  it('answers unresolvable for any one unmeasured fact', () => {
    const base = golden[0]!.facts as unknown as TargetFacts;
    for (const signal of DENY_RULESET.signals)
      expect(classifyTarget({ ...base, [signal.name]: null } as TargetFacts), signal.name).toEqual({
        kind: 'unresolvable',
      });
    const missing = { ...base } as Record<string, unknown>;
    delete missing.imageRoot;
    expect(classifyTarget(missing as TargetFacts)).toEqual({ kind: 'unresolvable' });
  });
});

describe('deny ruleset content hash and version', () => {
  it('maps each platform content hash to its version in the ledger', () => {
    const platforms = Object.keys(DENY_RULESET.platforms);
    expect(platforms.sort()).toEqual(Object.keys(RULESET_LEDGER).sort());
    for (const platform of platforms) {
      const text = denyRulesetCanonicalText(platform);
      expect(text).not.toBeNull();
      // The generator (from the JSON) and the TS core (from the generated module) build the same
      // text; the C++ harness checks its own tables against the same recorded hash.
      expect(text).toBe(generatorCanonicalText(model, platform));
      const hash = sha256(text!);
      expect(denyRulesetRecordedSha256(platform)).toBe(hash);
      const version = denyRulesetVersion(platform)!;
      const ledger = RULESET_LEDGER[platform]!;
      expect(ledger[version], `${platform} v${version}`).toBe(hash);
      // The current version is the newest one the ledger has seen, and no two versions share a hash.
      expect(Math.max(...Object.keys(ledger).map(Number))).toBe(version);
      expect(new Set(Object.values(ledger)).size).toBe(Object.keys(ledger).length);
    }
  });

  it('gives a platform without a ruleset no version, no text and no hash', () => {
    expect(denyRulesetVersion('darwin')).toBeNull();
    expect(denyRulesetCanonicalText('darwin')).toBeNull();
    expect(denyRulesetRecordedSha256('darwin')).toBeNull();
  });

  it('changes a platform hash with its content and leaves the other platforms alone', () => {
    const source = JSON.parse(readFileSync(DENY_RULESET_PATHS.source, 'utf8')) as {
      platforms: Record<string, unknown>;
      rules: { when: { values?: string[] }[] }[];
    };
    const changed = structuredClone(source);
    changed.rules[changed.rules.length - 1]!.when[0]!.values!.push('example.exe');
    const edited = loadDenyRuleset(JSON.stringify(changed));
    expect(edited.platforms.win32!.contentSha256).not.toBe(model.platforms.win32!.contentSha256);
    // A version bump alone is not a content change.
    const bumped = structuredClone(source) as unknown as {
      platforms: { win32: { rulesetVersion: number } };
    };
    bumped.platforms.win32.rulesetVersion += 1;
    expect(loadDenyRuleset(JSON.stringify(bumped)).platforms.win32!.contentSha256).toBe(
      model.platforms.win32!.contentSha256,
    );

    // Another platform's ruleset (its signal, class, route and rule) leaves win32's hash alone,
    // and a win32 change leaves that platform's hash alone (decision H).
    type Json = {
      platforms: Record<string, unknown>;
      signals: unknown[];
      classes: unknown[];
      routes: unknown[];
      rules: { platforms: string[]; when: { values?: string[] }[] }[];
    };
    const withDarwin = structuredClone(source) as unknown as Json;
    withDarwin.platforms.darwin = {
      rulesetVersion: 1,
      eligibleMaximumMode: 'full_access_app',
      upperMaximumMode: 'supervised',
    };
    withDarwin.signals.push({ name: 'bundleIdentifier', type: 'string', platforms: ['darwin'] });
    withDarwin.classes.push({ id: 'M1', verdict: 'denied' });
    withDarwin.routes.push({
      id: 'darwin_application',
      platforms: ['darwin'],
      when: [{ signal: 'bundleIdentifier', match: 'prefix', values: ['com.'] }],
    });
    withDarwin.rules.push({
      class: 'M1',
      platforms: ['darwin'],
      when: [{ signal: 'bundleIdentifier', match: 'equals', values: ['com.apple.terminal'] }],
    } as unknown as Json['rules'][number]);
    const both = loadDenyRuleset(JSON.stringify(withDarwin));
    expect(both.platforms.win32!.contentSha256).toBe(model.platforms.win32!.contentSha256);
    expect(generatorCanonicalText(both, 'win32')).toBe(generatorCanonicalText(model, 'win32'));
    expect(generatorCanonicalText(both, 'darwin')).toContain('class\tM1\tdenied');
    expect(generatorCanonicalText(both, 'darwin')).not.toContain('class\tW4\t');
    const darwinHash = both.platforms.darwin!.contentSha256;
    const win32Changed = structuredClone(withDarwin);
    win32Changed.rules[win32Changed.rules.length - 2]!.when[0]!.values!.push('example.exe');
    const afterWin32 = loadDenyRuleset(JSON.stringify(win32Changed));
    expect(afterWin32.platforms.win32!.contentSha256).not.toBe(
      model.platforms.win32!.contentSha256,
    );
    expect(afterWin32.platforms.darwin!.contentSha256).toBe(darwinHash);
  });
});

describe('target eligibility outward types', () => {
  it('types each admitted kind with the mode the generated ruleset gives it', () => {
    type Eligible = Extract<TargetEligibility, { kind: 'eligible' }>;
    type Upper = Extract<TargetEligibility, { kind: 'upper' }>;
    expectTypeOf<Upper['maximumMode']>().toEqualTypeOf<'observe_only'>();
    expectTypeOf<Eligible['maximumMode']>().toEqualTypeOf<'full_access_app'>();
    expectTypeOf<TargetUpperMode>().toEqualTypeOf<
      (typeof DENY_RULESET.platforms)['win32']['upperMaximumMode']
    >();
    expectTypeOf<TargetEligibleMode>().toEqualTypeOf<
      (typeof DENY_RULESET.platforms)['win32']['eligibleMaximumMode']
    >();
    // A caller can compare an upper verdict with observe_only without a type error.
    const verdict = classifyTarget(golden[0]!.facts as unknown as TargetFacts);
    if (verdict.kind === 'upper') expect(verdict.maximumMode === 'observe_only').toBe(true);
    const upper = golden.find((entry) => entry.expect.kind === 'upper')!;
    const capped = classifyTarget(upper.facts as unknown as TargetFacts);
    expect(capped.kind === 'upper' && capped.maximumMode === 'observe_only').toBe(true);
  });
});

describe('deny ruleset generated outputs', () => {
  it('are exactly what deny-ruleset.json produces', async () => {
    const outputs = await renderDenyRulesetOutputs();
    expect(Object.keys(outputs).sort()).toEqual(
      [
        DENY_RULESET_PATHS.cppHeader,
        DENY_RULESET_PATHS.cppGolden,
        DENY_RULESET_PATHS.tsModule,
      ].sort(),
    );
    for (const [path, content] of Object.entries(outputs))
      expect(readFileSync(path, 'utf8').replace(/\r\n/gu, '\n'), path).toBe(content);
  });

  it('refuses a ruleset that would let a deny-only signal admit, a title in, or loose values', () => {
    const source = readFileSync(DENY_RULESET_PATHS.source, 'utf8');
    const mutate = (edit: (json: Record<string, unknown>) => void): string => {
      const json = JSON.parse(source) as Record<string, unknown>;
      edit(json);
      return JSON.stringify(json);
    };
    type Json = {
      routes: { when: Record<string, unknown>[] }[];
      rules: { when: Record<string, unknown>[] }[];
      signals: Record<string, unknown>[];
    };
    const cases: [string, (json: Json) => void][] = [
      [
        'deny-only',
        (json) =>
          json.routes[0]!.when.push({ signal: 'imageLeaf', match: 'equals', values: ['a.exe'] }),
      ],
      [
        'deny-only',
        (json) =>
          json.rules[0]!.when.push({
            signal: 'windowClass',
            match: 'equals',
            negate: true,
            values: ['x'],
          }),
      ],
      [
        'title',
        (json) => json.signals.push({ name: 'windowTitle', type: 'string', platforms: ['win32'] }),
      ],
      [
        'title',
        (json) => json.signals.push({ name: 'displayName', type: 'string', platforms: ['win32'] }),
      ],
      [
        'lower case',
        (json) =>
          json.rules[0]!.when.push({ signal: 'imageLeaf', match: 'glob', values: ['A.EXE'] }),
      ],
      ['unknown key', (json) => ((json.rules[0] as Record<string, unknown>).label = 'x')],
      [
        'does not fit',
        (json) =>
          json.rules[0]!.when.push({ signal: 'tokenElevated', match: 'equals', values: ['x'] }),
      ],
    ];
    for (const [message, edit] of cases)
      expect(() =>
        loadDenyRuleset(mutate(edit as (json: Record<string, unknown>) => void)),
      ).toThrow(message);
  });
});

describe('target facts source contract', () => {
  const titleLike = /title|display|caption|label/iu;
  const between = (source: string, start: string, end: string): string => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    expect(from, start).toBeGreaterThanOrEqual(0);
    expect(to, end).toBeGreaterThan(from);
    return source.slice(from, to);
  };

  it('has no title or display field in the facts on either side', () => {
    for (const signal of model.signals) expect(signal.name).not.toMatch(titleLike);
    const tsModule = readFileSync(DENY_RULESET_PATHS.tsModule, 'utf8');
    const tsFacts = between(tsModule, 'export type TargetFacts = {', '};');
    expect(tsFacts).not.toMatch(titleLike);
    const tsFields = [...tsFacts.matchAll(/readonly (\w+):/gu)].map((match) => match[1]);
    expect(tsFields).toEqual(['platform', ...model.signals.map((signal) => signal.name)]);
    const cppFacts = between(
      readNative('computer_use_deny_ruleset_generated.h'),
      'struct TargetFacts {',
      '};',
    );
    expect(cppFacts).not.toMatch(titleLike);
    expect(cppFacts.match(/std::optional</gu)?.length).toBe(model.signals.length);
  });

  it('carries no class or label out of a refusal on either side', () => {
    const tsCore = readFileSync(join(__dirname, 'computer-use-target-eligibility.ts'), 'utf8');
    const outward = between(tsCore, 'export type TargetEligibility =', '\n\n');
    expect(outward).toContain("Readonly<{ kind: 'denied' }>");
    expect(outward).toContain("Readonly<{ kind: 'unresolvable' }>");
    expect(outward).not.toMatch(/class|label|reason|route/iu);
    const cppCore = readNative('computer_use_target_eligibility.h');
    const verdict = between(cppCore, 'struct TargetVerdict {', '};');
    const fields = [...verdict.matchAll(/^\s+[\w:<>]+ (\w+)(?: = [^;]+)?;/gmu)].map((m) => m[1]);
    expect(fields).toEqual(['kind', 'maximum_mode']);
    for (const source of [tsCore, cppCore]) expect(source).not.toMatch(/displayName|display_name/u);
  });

  it('is called from nowhere yet', () => {
    const mainDirectory = __dirname;
    const allowed = new Set([
      'computer-use-target-eligibility.ts',
      'computer-use-target-eligibility-fixture.ts',
      'computer-use-deny-ruleset.generated.ts',
    ]);
    for (const name of readdirSync(mainDirectory)) {
      if (!/\.(ts|tsx)$/u.test(name) || /\.test\.tsx?$/u.test(name) || allowed.has(name)) continue;
      const source = readFileSync(join(mainDirectory, name), 'utf8');
      expect(source, name).not.toMatch(
        /computer-use-target-eligibility|computer-use-deny-ruleset/u,
      );
    }
    // PR-2 (#500): the Windows target facts fill TargetFacts, so their portable header reads the
    // core's tables and the Windows host includes that header. The host still judges nothing: no
    // native source but the core's own files and the harness names the core's entry points.
    const factsReaders = new Set([
      'computer_use_windows_target_facts.h',
      'computer_use_windows_host.cc',
    ]);
    for (const name of readdirSync(nativeDirectory)) {
      if (!/\.(cc|mm|h)$/u.test(name)) continue;
      if (
        name.startsWith('computer_use_target_eligibility') ||
        name === 'computer_use_deny_ruleset_generated.h'
      )
        continue;
      const source = readNative(name);
      expect(source, name).not.toMatch(
        /\bClassifyTarget(?:Explained)?\(|TargetFactsAreComplete\(/u,
      );
      if (factsReaders.has(name)) continue;
      expect(source, name).not.toMatch(
        /computer_use_target_eligibility|computer_use_deny_ruleset|computer_use_windows_target_facts/u,
      );
    }
    const host = readNative('computer_use_windows_host.cc');
    expect(host).toContain('#include "computer_use_windows_target_facts.h"');
    expect(host).not.toMatch(/#include "computer_use_(?:target_eligibility|deny_ruleset)/u);
  });
});
