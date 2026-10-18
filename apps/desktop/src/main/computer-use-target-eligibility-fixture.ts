import { DENY_RULESET, type TargetFacts } from './computer-use-deny-ruleset.generated';
import {
  TARGET_FACT_MAX_BYTES,
  classifyTarget,
  type TargetEligibility,
} from './computer-use-target-eligibility';

// Test fixtures for the target eligibility core (S5-c-3, #500 PR-1): a deterministic random fact
// generator and the refusal-signal mutations the monotonicity property is checked over. The C++
// harness derives the same mutations from its own tables. Only tests import this.

type Condition = Readonly<{
  signal: string;
  match: string;
  negate: boolean;
  values: readonly string[];
}>;
type Rule = Readonly<{ class: string; verdict: string; when: readonly Condition[] }>;

const rules = DENY_RULESET.rules as readonly Rule[];
const asciiLower = (value: string): string =>
  value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());

/** A small deterministic PRNG (mulberry32), so failures reproduce from the seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const NEUTRAL_STRINGS = [
  '',
  'editor.exe',
  'contoso ltd',
  'contoso\\editor\\editor.exe',
  'system32\\notepad.exe',
  'microsoft corporation',
  'メモ帳.exe',
  'ÉDITEUR.EXE',
  'Contoso Installer Helper.EXE',
  // Around the 1024-byte limit, counted in UTF-8 bytes (a kana is three bytes).
  'a'.repeat(1023),
  'a'.repeat(1024),
  'a'.repeat(1025),
  'あ'.repeat(341),
  'あ'.repeat(342),
  'メモ帳'.repeat(200),
];

function stringPool(signal: string): readonly string[] {
  const pool = [...NEUTRAL_STRINGS];
  for (const rule of rules)
    for (const condition of rule.when)
      if (condition.signal === signal)
        for (const value of condition.values) {
          const concrete = value.replaceAll('*', 'x');
          pool.push(concrete, concrete.toUpperCase());
        }
  for (const route of DENY_RULESET.routes)
    for (const condition of route.when as readonly Condition[])
      if (condition.signal === signal) pool.push(...condition.values);
  return pool;
}

/**
 * Random facts: mostly measured, occasionally a value the ruleset does not know. Given `near`,
 * each fact of it is kept unless a roll replaces it, so the result stays close to that target.
 */
export function randomTargetFacts(random: () => number, near?: TargetFacts): TargetFacts {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const facts: Record<string, unknown> =
    near === undefined ? { platform: random() < 0.97 ? 'win32' : 'darwin' } : { ...near };
  for (const signal of DENY_RULESET.signals) {
    if (near !== undefined && random() >= 0.1) continue;
    const roll = random();
    if (roll < 0.03) facts[signal.name] = null;
    else if (signal.type === 'boolean') facts[signal.name] = random() < 0.15;
    else if (signal.type === 'enum')
      facts[signal.name] =
        roll < 0.04 ? 'not a known value' : pick(signal.values as readonly string[]);
    else facts[signal.name] = pick(stringPool(signal.name));
  }
  return facts as TargetFacts;
}

function holds(facts: TargetFacts, condition: Condition): boolean {
  const value = (facts as unknown as Record<string, unknown>)[condition.signal];
  let result = false;
  if (condition.match === 'true' || condition.match === 'false')
    result = value === (condition.match === 'true');
  else if (typeof value === 'string') {
    const folded = asciiLower(value);
    result = condition.values.some((candidate) =>
      condition.match === 'equals'
        ? folded === candidate
        : condition.match === 'prefix'
          ? folded.startsWith(candidate)
          : new RegExp(
              `^${candidate.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')}$`,
              'su',
            ).test(folded),
    );
  }
  return condition.negate ? !result : result;
}

const encoder = new TextEncoder();
function measured(facts: TargetFacts, name: string): boolean {
  const value = (facts as unknown as Record<string, unknown>)[name];
  const signal = DENY_RULESET.signals.find((entry) => entry.name === name)!;
  if (signal.type === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'string' || encoder.encode(value).length > TARGET_FACT_MAX_BYTES)
    return false;
  return signal.type !== 'enum' || (signal.values as readonly string[]).includes(value);
}

/**
 * True when the fact already holds a refusal or cap signal (or holds nothing). A fact holds one
 * value, so setting it to another signal would take that one away rather than add one; such a fact
 * is not mutated.
 */
const carriesSignal = (facts: TargetFacts, signal: string): boolean =>
  // An unmeasured fact (or one the ruleset does not know) is not mutated either: measuring it is
  // not adding a signal.
  !measured(facts, signal) ||
  rules.some((rule) =>
    rule.when.some(
      (condition) => condition.signal === signal && !condition.negate && holds(facts, condition),
    ),
  );

const satisfy = (facts: Record<string, unknown>, condition: Condition): void => {
  facts[condition.signal] =
    condition.match === 'true'
      ? true
      : condition.match === 'false'
        ? false
        : condition.values[0]!.replaceAll('*', 'x');
};

export type TargetMutation = Readonly<{ label: string; facts: TargetFacts }>;

/** Every refusal-signal addition and every unmeasured fact, applied to `facts`. */
export function refusalMutations(facts: TargetFacts): TargetMutation[] {
  const mutations: TargetMutation[] = [];
  rules.forEach((rule, index) => {
    if (rule.when.some((condition) => condition.negate)) return;
    if (rule.when.some((condition) => carriesSignal(facts, condition.signal))) {
      for (const condition of rule.when) {
        if (carriesSignal(facts, condition.signal)) continue;
        const single = { ...facts } as Record<string, unknown>;
        satisfy(single, condition);
        mutations.push({
          label: `rule ${index} ${condition.signal}`,
          facts: single as TargetFacts,
        });
      }
      return;
    }
    const whole = { ...facts } as Record<string, unknown>;
    for (const condition of rule.when) {
      const single = { ...facts } as Record<string, unknown>;
      satisfy(single, condition);
      satisfy(whole, condition);
      mutations.push({ label: `rule ${index} ${condition.signal}`, facts: single as TargetFacts });
    }
    mutations.push({ label: `rule ${index} (${rule.class})`, facts: whole as TargetFacts });
  });
  for (const signal of DENY_RULESET.signals)
    mutations.push({
      label: `unknown ${signal.name}`,
      facts: { ...facts, [signal.name]: null } as TargetFacts,
    });
  return mutations;
}

/** More is more permissive. A refusal and an unresolvable target are equally not eligible. */
export const eligibilityRank = (verdict: TargetEligibility): number =>
  verdict.kind === 'eligible' ? 2 : verdict.kind === 'upper' ? 1 : 0;

export const rankOf = (facts: TargetFacts): number => eligibilityRank(classifyTarget(facts));
