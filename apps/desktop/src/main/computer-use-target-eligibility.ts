import {
  DENY_RULESET,
  TARGET_PLATFORMS,
  type TargetFacts,
} from './computer-use-deny-ruleset.generated';

// Target eligibility core shared by both platforms (S5-c-3, #500 PR-1). It mirrors
// computer_use_target_eligibility.h rule for rule; the golden vectors and the seam hold the two
// together. Main will judge each native answer with it on its own (ADR v2 INV-1); nothing calls it
// yet.
//
//   * a platform with no ruleset, or any fact of that platform that was not measured (or is not a
//     value the ruleset knows), is unresolvable: the default is not eligible;
//   * a denied rule that matches refuses (the first one in order names the class);
//   * otherwise a route must admit the target, or it is refused as W-NR;
//   * an upper rule that matches caps the mode; anything else is eligible;
//   * a refusal carries neither a label nor a class outward: classifyTarget returns only the kind,
//     and only classifyTargetExplained (tests) says which class refused.

export type { TargetFacts, TargetPlatformName } from './computer-use-deny-ruleset.generated';

type Ruleset = typeof DENY_RULESET;
type Mode = Ruleset['platforms'][keyof Ruleset['platforms']]['eligibleMaximumMode'];
type Condition = Readonly<{
  signal: string;
  match: 'true' | 'false' | 'equals' | 'prefix' | 'glob';
  negate: boolean;
  values: readonly string[];
}>;
type PlatformRuleset = Readonly<{
  rulesetVersion: number;
  eligibleMaximumMode: string;
  upperMaximumMode: string;
  contentSha256: string;
}>;

/** A measured string longer than this (in UTF-8 bytes) is treated as not measured. */
export const TARGET_FACT_MAX_BYTES = 1024;

/** What leaves the core. A refusal says nothing but that it is one. */
export type TargetEligibility =
  | Readonly<{ kind: 'eligible'; maximumMode: Mode }>
  | Readonly<{ kind: 'upper'; maximumMode: Mode }>
  | Readonly<{ kind: 'denied' }>
  | Readonly<{ kind: 'unresolvable' }>;

/** For tests only: which class refused, or which route admitted. */
export type TargetClassification = Readonly<{
  verdict: TargetEligibility;
  denyClass: string | null;
  route: string | null;
}>;

const encoder = new TextEncoder();
const asciiLower = (value: string): string =>
  value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());

/** `*` matches any run of characters (including none); every other character matches itself. */
function globMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      resume = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++resume;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

function rulesetFor(platform: unknown): PlatformRuleset | null {
  if (typeof platform !== 'string' || !Object.hasOwn(DENY_RULESET.platforms, platform)) return null;
  return (DENY_RULESET.platforms as Readonly<Record<string, PlatformRuleset>>)[platform] ?? null;
}

const fact = (facts: TargetFacts, name: string): unknown =>
  (facts as unknown as Readonly<Record<string, unknown>>)[name];

function conditionHolds(facts: TargetFacts, condition: Condition): boolean {
  const value = fact(facts, condition.signal);
  let holds = false;
  if (condition.match === 'true' || condition.match === 'false')
    holds = typeof value === 'boolean' && value === (condition.match === 'true');
  else if (typeof value === 'string') {
    const folded = asciiLower(value);
    holds = condition.values.some((candidate) =>
      condition.match === 'equals'
        ? folded === candidate
        : condition.match === 'prefix'
          ? folded.startsWith(candidate)
          : globMatches(candidate, folded),
    );
  }
  return condition.negate ? !holds : holds;
}

const allHold = (facts: TargetFacts, when: readonly Condition[]): boolean =>
  when.every((condition) => conditionHolds(facts, condition));

/** True when every fact the platform's ruleset reads was measured and is a value it knows. */
export function targetFactsAreComplete(facts: TargetFacts): boolean {
  const platform = (facts as { platform?: unknown }).platform;
  if (rulesetFor(platform) === null) return false;
  return DENY_RULESET.signals.every((signal) => {
    if (!(signal.platforms as readonly string[]).includes(platform as string)) return true;
    const value = fact(facts, signal.name);
    if (signal.type === 'boolean') return typeof value === 'boolean';
    if (typeof value !== 'string' || encoder.encode(value).length > TARGET_FACT_MAX_BYTES)
      return false;
    return signal.type !== 'enum' || (signal.values as readonly string[]).includes(value);
  });
}

export function classifyTargetExplained(facts: TargetFacts): TargetClassification {
  const unresolvable = { verdict: { kind: 'unresolvable' }, denyClass: null, route: null } as const;
  const platform = (facts as { platform?: unknown }).platform as string;
  const ruleset = rulesetFor(platform);
  if (ruleset === null || !targetFactsAreComplete(facts)) return unresolvable;
  const applies = (entry: Readonly<{ platforms: readonly string[] }>): boolean =>
    entry.platforms.includes(platform);
  const rules = DENY_RULESET.rules as readonly Readonly<{
    class: string;
    verdict: 'denied' | 'upper';
    platforms: readonly string[];
    when: readonly Condition[];
  }>[];
  for (const rule of rules)
    if (rule.verdict === 'denied' && applies(rule) && allHold(facts, rule.when))
      return { verdict: { kind: 'denied' }, denyClass: rule.class, route: null };
  const routes = DENY_RULESET.routes as readonly Readonly<{
    id: string;
    platforms: readonly string[];
    when: readonly Condition[];
  }>[];
  const route = routes.find((entry) => applies(entry) && allHold(facts, entry.when));
  if (route === undefined) return { verdict: { kind: 'denied' }, denyClass: 'W-NR', route: null };
  for (const rule of rules)
    if (rule.verdict === 'upper' && applies(rule) && allHold(facts, rule.when))
      return {
        verdict: { kind: 'upper', maximumMode: ruleset.upperMaximumMode as Mode },
        denyClass: null,
        route: route.id,
      };
  return {
    verdict: { kind: 'eligible', maximumMode: ruleset.eligibleMaximumMode as Mode },
    denyClass: null,
    route: route.id,
  };
}

export function classifyTarget(facts: TargetFacts): TargetEligibility {
  return classifyTargetExplained(facts).verdict;
}

/** The ruleset version a platform's targets are judged under, or null when it has no ruleset. */
export function denyRulesetVersion(platform: string): number | null {
  return rulesetFor(platform)?.rulesetVersion ?? null;
}

/** The content hash the generator recorded for a platform, or null when it has no ruleset. */
export function denyRulesetRecordedSha256(platform: string): string | null {
  return rulesetFor(platform)?.contentSha256 ?? null;
}

/**
 * The text the content hash is taken over, rebuilt from the generated tables (the generator and
 * the C++ core build the same text from theirs). Null when the platform has no ruleset.
 */
export function denyRulesetCanonicalText(platform: string): string | null {
  const ruleset = rulesetFor(platform);
  if (ruleset === null) return null;
  const applies = (entry: Readonly<{ platforms: readonly string[] }>): boolean =>
    entry.platforms.includes(platform);
  const when = (condition: Condition): string =>
    [
      'when',
      condition.signal,
      condition.match,
      condition.negate ? '1' : '0',
      ...condition.values,
    ].join('\t');
  const lines = [
    `deny-ruleset canonical ${DENY_RULESET.schemaVersion}`,
    `platform\t${platform}`,
    `mode\teligible\t${ruleset.eligibleMaximumMode}`,
    `mode\tupper\t${ruleset.upperMaximumMode}`,
  ];
  for (const signal of DENY_RULESET.signals)
    if (applies(signal))
      lines.push(
        ['signal', signal.name, signal.type, signal.denyOnly ? '1' : '0', ...signal.values].join(
          '\t',
        ),
      );
  for (const entry of DENY_RULESET.classes) lines.push(`class\t${entry.id}\t${entry.verdict}`);
  for (const route of DENY_RULESET.routes)
    if (applies(route)) {
      lines.push(`route\t${route.id}`);
      for (const condition of route.when as readonly Condition[]) lines.push(when(condition));
    }
  for (const rule of DENY_RULESET.rules)
    if (applies(rule)) {
      lines.push(`rule\t${rule.class}\t${rule.verdict}`);
      for (const condition of rule.when as readonly Condition[]) lines.push(when(condition));
    }
  return `${lines.join('\n')}\n`;
}

/** The platforms the core knows (a platform without a ruleset is always unresolvable). */
export const TARGET_ELIGIBILITY_PLATFORMS = TARGET_PLATFORMS;
