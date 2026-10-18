export type DenyRulesetCondition = {
  signal: string;
  match: 'true' | 'false' | 'equals' | 'prefix' | 'glob';
  negate: boolean;
  values: string[];
};
export type DenyRulesetModel = {
  schemaVersion: number;
  platforms: Record<
    string,
    {
      rulesetVersion: number;
      eligibleMaximumMode: string;
      upperMaximumMode: string;
      contentSha256: string;
    }
  >;
  signals: {
    name: string;
    type: 'boolean' | 'enum' | 'string';
    platforms: string[];
    denyOnly: boolean;
    values: string[];
  }[];
  classes: { id: string; verdict: 'denied' | 'upper' }[];
  routes: { id: string; platforms: string[]; when: DenyRulesetCondition[] }[];
  rules: {
    class: string;
    verdict: 'denied' | 'upper';
    platforms: string[];
    when: DenyRulesetCondition[];
  }[];
};
export type DenyRulesetGoldenCase = {
  name: string;
  facts: Record<string, string | boolean | null>;
  expect: { kind: 'eligible' | 'upper' | 'denied' | 'unresolvable'; class: string | null };
};
export const DENY_RULESET_PATHS: Readonly<{
  source: string;
  golden: string;
  cppHeader: string;
  cppGolden: string;
  tsModule: string;
}>;
export const TARGET_PLATFORMS: readonly string[];
export function loadDenyRuleset(text?: string): DenyRulesetModel;
export function denyRulesetCanonicalText(model: DenyRulesetModel, platform: string): string;
export function cppStringLiteral(value: string): string;
export function renderCppHeader(model: DenyRulesetModel): string;
export function renderTsSource(model: DenyRulesetModel): string;
export function materializeGoldenCases(
  model: DenyRulesetModel,
  text?: string,
): DenyRulesetGoldenCase[];
export function cppFactsStatements(
  model: DenyRulesetModel,
  variable: string,
  facts: Readonly<Record<string, unknown>>,
): string[];
export function renderCppGolden(model: DenyRulesetModel, cases: DenyRulesetGoldenCase[]): string;
export function renderDenyRulesetOutputs(): Promise<Record<string, string>>;
