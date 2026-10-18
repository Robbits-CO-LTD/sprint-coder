import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// S5-c-3 (#500) PR-1: deny-ruleset.json is the single source of the shared target eligibility
// core. This writes the committed C++ header and the TS module from it, plus the C++ copy of the
// golden vectors. `--check` writes nothing and fails when a committed file is not what the JSON
// produces. Nothing here reads the environment.

const root = dirname(fileURLToPath(import.meta.url));
const nativeDirectory = join(root, 'apps', 'desktop', 'computer-use-native');

export const DENY_RULESET_PATHS = Object.freeze({
  source: join(nativeDirectory, 'deny-ruleset.json'),
  golden: join(nativeDirectory, 'target-eligibility-golden.json'),
  cppHeader: join(nativeDirectory, 'computer_use_deny_ruleset_generated.h'),
  cppGolden: join(nativeDirectory, 'computer_use_target_eligibility_golden_generated.h'),
  tsModule: join(root, 'apps', 'desktop', 'src', 'main', 'computer-use-deny-ruleset.generated.ts'),
});

// The platforms the core knows. A platform without an entry in `platforms` has no ruleset, and
// every target on it is unresolvable.
export const TARGET_PLATFORMS = Object.freeze(['win32', 'darwin']);
const SIGNAL_TYPES = new Set(['boolean', 'enum', 'string']);
const MATCHES_BY_TYPE = Object.freeze({
  boolean: new Set(['true', 'false']),
  enum: new Set(['equals']),
  string: new Set(['equals', 'prefix', 'glob']),
});
const VERDICTS = new Set(['denied', 'upper']);
const MODES = new Set(['observe_only', 'supervised', 'full_access_app']);
// Facts are verified attributes. A title or a display name is written by the target itself, so
// no signal may be named after one (ADR v2 principle 1 of S5-c-3).
const FORBIDDEN_SIGNAL_NAME = /title|display|caption|label/iu;

const fail = (message) => {
  throw new Error(`deny-ruleset.json: ${message}`);
};
const asciiLower = (value) => value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
const onlyKeys = (object, allowed, where) => {
  if (object === null || typeof object !== 'object' || Array.isArray(object))
    fail(`${where} must be an object`);
  for (const key of Object.keys(object))
    if (!allowed.includes(key)) fail(`${where} has an unknown key ${key}`);
};
const checkValue = (value, where) => {
  if (typeof value !== 'string' || value.length === 0) fail(`${where} must be a non-empty string`);
  if (/[\t\n\r\0]/u.test(value)) fail(`${where} must not hold a tab, a newline or NUL`);
  if (value !== asciiLower(value)) fail(`${where} must be lower case (matching is ASCII-folded)`);
  if (!/^[\x20-\x7e]+$/u.test(value)) fail(`${where} must be printable ASCII`);
};

/** Reads and strictly validates the JSON, and returns the normalized model both outputs use. */
export function loadDenyRuleset(text = readFileSync(DENY_RULESET_PATHS.source, 'utf8')) {
  const json = JSON.parse(text);
  onlyKeys(
    json,
    ['$comment', 'schemaVersion', 'platforms', 'signals', 'classes', 'lists', 'routes', 'rules'],
    'the ruleset',
  );
  if (json.schemaVersion !== 1) fail('schemaVersion must be 1');

  const platforms = {};
  onlyKeys(json.platforms, TARGET_PLATFORMS, 'platforms');
  for (const [name, entry] of Object.entries(json.platforms)) {
    onlyKeys(
      entry,
      ['rulesetVersion', 'eligibleMaximumMode', 'upperMaximumMode'],
      `platforms.${name}`,
    );
    if (!Number.isInteger(entry.rulesetVersion) || entry.rulesetVersion < 1)
      fail(`platforms.${name}.rulesetVersion must be a positive integer`);
    if (entry.rulesetVersion > 0xffff) fail(`platforms.${name}.rulesetVersion must fit 16 bits`);
    for (const key of ['eligibleMaximumMode', 'upperMaximumMode'])
      if (!MODES.has(entry[key])) fail(`platforms.${name}.${key} is not a mode`);
    platforms[name] = { ...entry };
  }

  const checkPlatforms = (list, where) => {
    if (!Array.isArray(list) || list.length === 0) fail(`${where}.platforms must be a list`);
    for (const platform of list)
      if (!TARGET_PLATFORMS.includes(platform)) fail(`${where} names an unknown platform`);
    if (new Set(list).size !== list.length) fail(`${where} repeats a platform`);
    return [...list];
  };

  if (!Array.isArray(json.signals) || json.signals.length === 0) fail('signals must be a list');
  const signals = json.signals.map((signal, index) => {
    const where = `signals[${index}]`;
    onlyKeys(signal, ['name', 'type', 'platforms', 'values', 'denyOnly'], where);
    if (typeof signal.name !== 'string' || !/^[a-z][A-Za-z0-9]*$/u.test(signal.name))
      fail(`${where}.name must be lowerCamelCase`);
    if (signal.name === 'platform') fail(`${where}.name must not be platform`);
    if (FORBIDDEN_SIGNAL_NAME.test(signal.name))
      fail(`${where}.name must not name a title or a display string`);
    if (!SIGNAL_TYPES.has(signal.type)) fail(`${where}.type is unknown`);
    const values = signal.type === 'enum' ? signal.values : undefined;
    if (signal.type === 'enum') {
      if (!Array.isArray(values) || values.length === 0) fail(`${where}.values must be a list`);
      values.forEach((value, at) => checkValue(value, `${where}.values[${at}]`));
      if (new Set(values).size !== values.length) fail(`${where}.values repeats a value`);
    } else if (signal.values !== undefined) fail(`${where}.values is only for an enum`);
    if (signal.denyOnly !== undefined && signal.denyOnly !== true)
      fail(`${where}.denyOnly is true or absent`);
    if (signal.denyOnly === true && signal.type !== 'string')
      fail(`${where}: only a string signal is deny-only`);
    return {
      name: signal.name,
      type: signal.type,
      platforms: checkPlatforms(signal.platforms, where),
      denyOnly: signal.denyOnly === true,
      values: values === undefined ? [] : [...values],
    };
  });
  const signalByName = new Map(signals.map((signal) => [signal.name, signal]));
  if (signalByName.size !== signals.length) fail('a signal name is repeated');

  if (!Array.isArray(json.classes) || json.classes.length === 0) fail('classes must be a list');
  const classes = json.classes.map((entry, index) => {
    onlyKeys(entry, ['id', 'verdict'], `classes[${index}]`);
    if (typeof entry.id !== 'string' || !/^[A-Z][A-Z0-9-]*$/u.test(entry.id))
      fail(`classes[${index}].id is malformed`);
    if (!VERDICTS.has(entry.verdict)) fail(`classes[${index}].verdict is unknown`);
    return { id: entry.id, verdict: entry.verdict };
  });
  const verdictByClass = new Map(classes.map((entry) => [entry.id, entry.verdict]));
  if (verdictByClass.size !== classes.length) fail('a class id is repeated');
  // A target that no route admits is refused under this class.
  if (verdictByClass.get('W-NR') !== 'denied') fail('the W-NR (no route) class must be denied');

  const lists = json.lists ?? {};
  onlyKeys(lists, Object.keys(lists), 'lists');
  for (const [name, list] of Object.entries(lists)) {
    if (!Array.isArray(list) || list.length === 0) fail(`lists.${name} must be a list`);
    list.forEach((value, at) => checkValue(value, `lists.${name}[${at}]`));
  }
  const usedLists = new Set();

  const condition = (entry, where, inRoute) => {
    onlyKeys(entry, ['signal', 'match', 'values', 'list', 'negate'], where);
    const signal = signalByName.get(entry.signal);
    if (signal === undefined) fail(`${where}.signal is unknown`);
    if (!MATCHES_BY_TYPE[signal.type].has(entry.match))
      fail(`${where}.match ${entry.match} does not fit a ${signal.type} signal`);
    if (entry.negate !== undefined && entry.negate !== true)
      fail(`${where}.negate is true or absent`);
    const negate = entry.negate === true;
    // A deny-only signal can only refuse: it never admits a route and is never negated.
    if (signal.denyOnly && (inRoute || negate))
      fail(`${where}: the deny-only signal ${signal.name} must not admit or be negated`);
    let values = [];
    if (signal.type === 'boolean') {
      if (entry.values !== undefined || entry.list !== undefined)
        fail(`${where}: a boolean match carries no values`);
    } else {
      if ((entry.values === undefined) === (entry.list === undefined))
        fail(`${where} needs exactly one of values and list`);
      if (entry.list !== undefined) {
        if (!Object.hasOwn(lists, entry.list)) fail(`${where}.list is unknown`);
        usedLists.add(entry.list);
        values = [...lists[entry.list]];
      } else {
        if (!Array.isArray(entry.values) || entry.values.length === 0)
          fail(`${where}.values must be a list`);
        values = [...entry.values];
      }
      values.forEach((value, at) => checkValue(value, `${where}.values[${at}]`));
      if (new Set(values).size !== values.length) fail(`${where} repeats a value`);
      if (signal.type === 'enum')
        for (const value of values)
          if (!signal.values.includes(value)) fail(`${where}: ${value} is not a ${signal.name}`);
    }
    return { signal: signal.name, match: entry.match, negate, values };
  };
  const conditions = (list, where, inRoute, platforms) => {
    if (!Array.isArray(list) || list.length === 0) fail(`${where}.when must be a list`);
    return list.map((entry, index) => {
      const parsed = condition(entry, `${where}.when[${index}]`, inRoute);
      for (const platform of platforms)
        if (!signalByName.get(parsed.signal).platforms.includes(platform))
          fail(`${where} uses ${parsed.signal}, which ${platform} does not measure`);
      return parsed;
    });
  };

  if (!Array.isArray(json.routes) || json.routes.length === 0) fail('routes must be a list');
  const routes = json.routes.map((route, index) => {
    const where = `routes[${index}]`;
    onlyKeys(route, ['id', 'platforms', 'note', 'when'], where);
    if (typeof route.id !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(route.id))
      fail(`${where}.id is malformed`);
    const platforms = checkPlatforms(route.platforms, where);
    return { id: route.id, platforms, when: conditions(route.when, where, true, platforms) };
  });
  if (new Set(routes.map((route) => route.id)).size !== routes.length) fail('a route id repeats');

  if (!Array.isArray(json.rules) || json.rules.length === 0) fail('rules must be a list');
  const rules = json.rules.map((rule, index) => {
    const where = `rules[${index}]`;
    onlyKeys(rule, ['class', 'platforms', 'note', 'when'], where);
    if (!verdictByClass.has(rule.class)) fail(`${where}.class is unknown`);
    if (rule.class === 'W-NR') fail(`${where}: W-NR is the no-route outcome, not a rule`);
    const platforms = checkPlatforms(rule.platforms, where);
    return {
      class: rule.class,
      verdict: verdictByClass.get(rule.class),
      platforms,
      when: conditions(rule.when, where, false, platforms),
    };
  });
  for (const name of Object.keys(lists)) if (!usedLists.has(name)) fail(`lists.${name} is unused`);
  for (const name of Object.keys(platforms)) {
    if (!routes.some((route) => route.platforms.includes(name)))
      fail(`platforms.${name} has no route`);
    if (!signals.some((signal) => signal.platforms.includes(name)))
      fail(`platforms.${name} measures no signal`);
  }

  const model = { schemaVersion: json.schemaVersion, platforms, signals, classes, routes, rules };
  for (const name of Object.keys(platforms))
    platforms[name].contentSha256 = createHash('sha256')
      .update(denyRulesetCanonicalText(model, name), 'utf8')
      .digest('hex');
  return model;
}

/**
 * The text the content hash is taken over. The C++ harness and the TS core rebuild it from their
 * own generated tables and must reach the same hash. Notes are not content; versions are not
 * either (the ledger maps a hash to its version).
 */
export function denyRulesetCanonicalText(model, platform) {
  const lines = [`deny-ruleset canonical ${model.schemaVersion}`, `platform\t${platform}`];
  const entry = model.platforms[platform];
  lines.push(`mode\teligible\t${entry.eligibleMaximumMode}`);
  lines.push(`mode\tupper\t${entry.upperMaximumMode}`);
  for (const signal of model.signals)
    if (signal.platforms.includes(platform))
      lines.push(
        ['signal', signal.name, signal.type, signal.denyOnly ? '1' : '0', ...signal.values].join(
          '\t',
        ),
      );
  // Only the classes this platform can answer with: W-NR (no route) and those its rules name.
  // A class another platform adds must not change this platform's hash (decision H).
  const used = new Set(
    model.rules.filter((rule) => rule.platforms.includes(platform)).map((rule) => rule.class),
  );
  for (const entry of model.classes)
    if (entry.id === 'W-NR' || used.has(entry.id))
      lines.push(`class\t${entry.id}\t${entry.verdict}`);
  const when = (condition) =>
    [
      'when',
      condition.signal,
      condition.match,
      condition.negate ? '1' : '0',
      ...condition.values,
    ].join('\t');
  for (const route of model.routes)
    if (route.platforms.includes(platform)) {
      lines.push(`route\t${route.id}`);
      for (const condition of route.when) lines.push(when(condition));
    }
  for (const rule of model.rules)
    if (rule.platforms.includes(platform)) {
      lines.push(`rule\t${rule.class}\t${rule.verdict}`);
      for (const condition of rule.when) lines.push(when(condition));
    }
  return `${lines.join('\n')}\n`;
}

const snake = (name) => name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
const pascal = (name) => name.charAt(0).toUpperCase() + name.slice(1);
const enumMember = (name) => `k${pascal(name)}`;
const platformMember = (name) => enumMember(name);
const platformBit = (name) => 1 << TARGET_PLATFORMS.indexOf(name);
const platformMask = (list) => list.reduce((mask, name) => mask | platformBit(name), 0);
const cppMatch = {
  true: 'kTrue',
  false: 'kFalse',
  equals: 'kEquals',
  prefix: 'kPrefix',
  glob: 'kGlob',
};

/** A C++ string literal: every byte outside printable ASCII is a three-digit octal escape. */
export function cppStringLiteral(value) {
  let output = '"';
  for (const byte of Buffer.from(value, 'utf8')) {
    if (byte === 0x22 || byte === 0x5c) output += `\\${String.fromCharCode(byte)}`;
    else if (byte >= 0x20 && byte < 0x7f && byte !== 0x3f) output += String.fromCharCode(byte);
    else output += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `${output}"`;
}

const GENERATED_BANNER = (from) =>
  `// Generated by generate-computer-use-deny-ruleset.mjs from ${from}. Do not edit; commit it.`;

export function renderCppHeader(model) {
  const out = [
    '#pragma once',
    '',
    GENERATED_BANNER('deny-ruleset.json'),
    '// The tables the target eligibility core (computer_use_target_eligibility.h) reads. Portable',
    '// C++20 with no platform header, so MSVC (/W4 /sdl) and clang both compile it.',
    '',
    '#include <cstddef>',
    '#include <cstdint>',
    '#include <optional>',
    '#include <span>',
    '#include <string>',
    '#include <string_view>',
    '',
    'namespace sprint_coder::computer_use {',
    '',
    `inline constexpr std::uint32_t kDenyRulesetSchemaVersion = ${model.schemaVersion};`,
    '',
    'enum class TargetPlatform : std::uint8_t {',
    '  kUnknown,',
    ...TARGET_PLATFORMS.map((name) => `  ${platformMember(name)},`),
    '};',
    '',
    'enum class TargetSignalType : std::uint8_t { kBoolean, kEnum, kString };',
    'enum class TargetMatch : std::uint8_t { kTrue, kFalse, kEquals, kPrefix, kGlob };',
    'enum class TargetRuleVerdict : std::uint8_t { kDenied, kUpper };',
    '',
    'enum class TargetSignal : std::uint8_t {',
    ...model.signals.map((signal) => `  ${enumMember(signal.name)},`),
    '};',
    '',
    `inline constexpr std::size_t kTargetSignalCount = ${model.signals.length};`,
    '',
    '[[nodiscard]] constexpr std::uint32_t TargetPlatformBit(TargetPlatform platform) {',
    '  switch (platform) {',
    ...TARGET_PLATFORMS.map(
      (name) => `  case TargetPlatform::${platformMember(name)}: return ${platformBit(name)}u;`,
    ),
    '  case TargetPlatform::kUnknown: break;',
    '  }',
    '  return 0u;',
    '}',
    '',
    '[[nodiscard]] constexpr std::string_view TargetPlatformName(TargetPlatform platform) {',
    '  switch (platform) {',
    ...TARGET_PLATFORMS.map(
      (name) => `  case TargetPlatform::${platformMember(name)}: return "${name}";`,
    ),
    '  case TargetPlatform::kUnknown: break;',
    '  }',
    '  return "";',
    '}',
    '',
    '// Every fact the native measures. std::nullopt is "not measured": the core then answers',
    '// unresolvable. There is no field for a title or a display name.',
    'struct TargetFacts {',
    '  TargetPlatform platform = TargetPlatform::kUnknown;',
    ...model.signals.map(
      (signal) =>
        `  std::optional<${signal.type === 'boolean' ? 'bool' : 'std::string'}> ${snake(signal.name)};`,
    ),
    '};',
    '',
    'struct TargetSignalSpec {',
    '  TargetSignal signal;',
    '  std::string_view name;',
    '  TargetSignalType type;',
    '  bool deny_only;',
    '  std::uint32_t platforms;',
    '  std::span<const std::string_view> values;',
    '};',
    '',
    'struct TargetCondition {',
    '  TargetSignal signal;',
    '  TargetMatch match;',
    '  bool negate;',
    '  std::span<const std::string_view> values;',
    '};',
    '',
    'struct TargetRoute {',
    '  std::string_view id;',
    '  std::uint32_t platforms;',
    '  std::span<const TargetCondition> when;',
    '};',
    '',
    'struct TargetRule {',
    '  std::string_view class_id;',
    '  TargetRuleVerdict verdict;',
    '  std::uint32_t platforms;',
    '  std::span<const TargetCondition> when;',
    '};',
    '',
    'struct TargetClassSpec {',
    '  std::string_view id;',
    '  TargetRuleVerdict verdict;',
    '};',
    '',
    'struct TargetPlatformRuleset {',
    '  TargetPlatform platform;',
    '  std::uint32_t ruleset_version;',
    '  std::string_view eligible_maximum_mode;',
    '  std::string_view upper_maximum_mode;',
    '  std::string_view content_sha256;',
    '};',
    '',
    'namespace deny_ruleset_data {',
    '',
  ];
  let valueIndex = 0;
  const valuesArray = (values) => {
    if (values.length === 0) return 'std::span<const std::string_view>()';
    const name = `kValues${valueIndex++}`;
    out.push(
      `inline constexpr std::string_view ${name}[] = {${values.map(cppStringLiteral).join(', ')}};`,
    );
    return `std::span<const std::string_view>(deny_ruleset_data::${name})`;
  };
  const signalValues = model.signals.map((signal) => valuesArray(signal.values));
  let conditionIndex = 0;
  const conditionArray = (when) => {
    const spans = when.map((condition) => valuesArray(condition.values));
    const name = `kWhen${conditionIndex++}`;
    out.push(`inline constexpr TargetCondition ${name}[] = {`);
    when.forEach((condition, index) =>
      out.push(
        `    {TargetSignal::${enumMember(condition.signal)}, TargetMatch::${cppMatch[condition.match]}, ${condition.negate}, ${spans[index]}},`,
      ),
    );
    out.push('};');
    return `std::span<const TargetCondition>(deny_ruleset_data::${name})`;
  };
  const routeWhen = model.routes.map((route) => conditionArray(route.when));
  const ruleWhen = model.rules.map((rule) => conditionArray(rule.when));
  out.push('', '} // namespace deny_ruleset_data', '');
  out.push('inline constexpr TargetSignalSpec kTargetSignals[] = {');
  model.signals.forEach((signal, index) =>
    out.push(
      `    {TargetSignal::${enumMember(signal.name)}, "${signal.name}", TargetSignalType::k${pascal(signal.type)}, ${signal.denyOnly}, ${platformMask(signal.platforms)}u, ${signalValues[index]}},`,
    ),
  );
  out.push('};', '');
  out.push('inline constexpr TargetClassSpec kTargetClasses[] = {');
  for (const entry of model.classes)
    out.push(`    {"${entry.id}", TargetRuleVerdict::k${pascal(entry.verdict)}},`);
  out.push('};', '');
  out.push('inline constexpr TargetRoute kTargetRoutes[] = {');
  model.routes.forEach((route, index) =>
    out.push(`    {"${route.id}", ${platformMask(route.platforms)}u, ${routeWhen[index]}},`),
  );
  out.push('};', '');
  out.push('inline constexpr TargetRule kTargetRules[] = {');
  model.rules.forEach((rule, index) =>
    out.push(
      `    {"${rule.class}", TargetRuleVerdict::k${pascal(rule.verdict)}, ${platformMask(rule.platforms)}u, ${ruleWhen[index]}},`,
    ),
  );
  out.push('};', '');
  out.push('inline constexpr TargetPlatformRuleset kTargetPlatformRulesets[] = {');
  for (const [name, entry] of Object.entries(model.platforms))
    out.push(
      `    {TargetPlatform::${platformMember(name)}, ${entry.rulesetVersion}u, "${entry.eligibleMaximumMode}", "${entry.upperMaximumMode}", "${entry.contentSha256}"},`,
    );
  out.push('};', '');
  const accessor = (type, constness) => {
    const valueType = type === 'boolean' ? 'bool' : 'std::string';
    const name = `${constness ? '' : 'Mutable'}Target${type === 'boolean' ? 'Boolean' : 'String'}Fact`;
    out.push(
      `[[nodiscard]] inline ${constness ? 'const ' : ''}std::optional<${valueType}> *${name}(${constness ? 'const ' : ''}TargetFacts &facts, TargetSignal signal) {`,
      '  switch (signal) {',
    );
    for (const signal of model.signals)
      if ((signal.type === 'boolean') === (type === 'boolean'))
        out.push(
          `  case TargetSignal::${enumMember(signal.name)}: return &facts.${snake(signal.name)};`,
        );
    out.push('  default: break;', '  }', '  return nullptr;', '}', '');
  };
  accessor('boolean', true);
  accessor('string', true);
  accessor('boolean', false);
  accessor('string', false);
  out.push('} // namespace sprint_coder::computer_use', '');
  return out.join('\n');
}

const tsLiteral = (value) => JSON.stringify(value).replace(/'/gu, "\\'");

export function renderTsSource(model) {
  const data = {
    schemaVersion: model.schemaVersion,
    platforms: model.platforms,
    signals: model.signals,
    classes: model.classes,
    routes: model.routes,
    rules: model.rules,
  };
  const factField = (signal) => {
    const type =
      signal.type === 'boolean'
        ? 'boolean'
        : signal.type === 'enum'
          ? signal.values.map((value) => `'${value}'`).join(' | ')
          : 'string';
    return `  readonly ${signal.name}: ${type} | null;`;
  };
  return [
    GENERATED_BANNER('apps/desktop/computer-use-native/deny-ruleset.json'),
    '// The tables the target eligibility core (computer-use-target-eligibility.ts) reads.',
    '',
    `export const TARGET_PLATFORMS = ${tsLiteral(TARGET_PLATFORMS)} as const;`,
    'export type TargetPlatformName = (typeof TARGET_PLATFORMS)[number];',
    '',
    '/** Every fact the native measures; null is "not measured". No title or display name. */',
    'export type TargetFacts = {',
    '  readonly platform: TargetPlatformName;',
    ...model.signals.map(factField),
    '};',
    '',
    `export const DENY_RULESET = ${tsLiteral(data)} as const;`,
    '',
  ].join('\n');
}

/** Turns the golden file (a base plus per-case overrides) into complete fact sets. */
export function materializeGoldenCases(
  model,
  text = readFileSync(DENY_RULESET_PATHS.golden, 'utf8'),
) {
  const golden = JSON.parse(text);
  const names = new Set(['platform', ...model.signals.map((signal) => signal.name)]);
  const checkFacts = (facts, where) => {
    for (const key of Object.keys(facts))
      if (!names.has(key)) throw new Error(`${where} names an unknown fact ${key}`);
  };
  checkFacts(golden.base, 'golden base');
  for (const name of names)
    if (!Object.hasOwn(golden.base, name)) throw new Error(`golden base lacks ${name}`);
  const seen = new Set();
  return golden.cases.map((entry) => {
    if (seen.has(entry.name)) throw new Error(`golden case ${entry.name} repeats`);
    seen.add(entry.name);
    const facts = { ...golden.base, ...(entry.set ?? {}) };
    checkFacts(entry.set ?? {}, entry.name);
    for (const [name, { unit, count }] of Object.entries(entry.repeat ?? {})) {
      if (!names.has(name)) throw new Error(`${entry.name} repeats an unknown fact ${name}`);
      facts[name] = String(unit).repeat(count);
    }
    for (const name of entry.unknown ?? []) {
      if (!names.has(name)) throw new Error(`${entry.name} unknowns an unknown fact ${name}`);
      facts[name] = null;
    }
    const expect = entry.expect;
    if (!['eligible', 'upper', 'denied', 'unresolvable'].includes(expect.kind))
      throw new Error(`${entry.name} expects an unknown kind`);
    if ((expect.kind === 'denied') !== (typeof expect.class === 'string'))
      throw new Error(`${entry.name}: a denied case names its class, and only it does`);
    return { name: entry.name, facts, expect: { kind: expect.kind, class: expect.class ?? null } };
  });
}

/** C++ statements that set `variable` (a TargetFacts) to `facts`. */
export function cppFactsStatements(model, variable, facts) {
  const lines = [];
  const platform = TARGET_PLATFORMS.includes(facts.platform)
    ? platformMember(facts.platform)
    : 'kUnknown';
  lines.push(`${variable}.platform = TargetPlatform::${platform};`);
  for (const signal of model.signals) {
    const value = facts[signal.name];
    const field = `${variable}.${snake(signal.name)}`;
    if (value === null || value === undefined) lines.push(`${field}.reset();`);
    else if (signal.type === 'boolean') lines.push(`${field} = ${value ? 'true' : 'false'};`);
    // Built with an explicit byte length: a fact may hold U+0000, and std::string(const char*) would
    // stop there, so C++ and TS would no longer see the same facts.
    else
      lines.push(
        `${field} = std::string(${cppStringLiteral(value)}, ${Buffer.byteLength(value, 'utf8')});`,
      );
  }
  return lines;
}

export function renderCppGolden(model, cases) {
  const kind = {
    eligible: 'kEligible',
    upper: 'kUpper',
    denied: 'kDenied',
    unresolvable: 'kUnresolvable',
  };
  const out = [
    '#pragma once',
    '',
    GENERATED_BANNER('target-eligibility-golden.json'),
    '// The golden vectors the TS core also runs (computer-use-target-eligibility.test.ts).',
    '',
    '#include "computer_use_target_eligibility.h"',
    '',
    '#include <string>',
    '#include <string_view>',
    '#include <vector>',
    '',
    'namespace sprint_coder::computer_use {',
    '',
    'struct TargetGoldenCase {',
    '  std::string_view name;',
    '  TargetFacts facts;',
    '  TargetVerdictKind kind;',
    '  std::string_view deny_class;',
    '};',
    '',
    'inline std::vector<TargetGoldenCase> TargetGoldenCases() {',
    '  std::vector<TargetGoldenCase> cases;',
    `  cases.reserve(${cases.length});`,
  ];
  for (const entry of cases) {
    out.push('  {', '    TargetFacts facts;');
    for (const line of cppFactsStatements(model, 'facts', entry.facts)) out.push(`    ${line}`);
    out.push(
      `    cases.push_back({${cppStringLiteral(entry.name)}, facts, TargetVerdictKind::${kind[entry.expect.kind]}, ${cppStringLiteral(entry.expect.class ?? '')}});`,
      '  }',
    );
  }
  out.push('  return cases;', '}', '', '} // namespace sprint_coder::computer_use', '');
  return out.join('\n');
}

/** Every committed output, keyed by its absolute path. */
export async function renderDenyRulesetOutputs() {
  const model = loadDenyRuleset();
  const cases = materializeGoldenCases(model);
  const prettier = await import('prettier');
  const tsPath = DENY_RULESET_PATHS.tsModule;
  const options = { ...((await prettier.resolveConfig(tsPath)) ?? {}), filepath: tsPath };
  return {
    [DENY_RULESET_PATHS.cppHeader]: renderCppHeader(model),
    [DENY_RULESET_PATHS.cppGolden]: renderCppGolden(model, cases),
    [tsPath]: await prettier.format(renderTsSource(model), options),
  };
}

async function main(argv) {
  const check = argv.includes('--check');
  const outputs = await renderDenyRulesetOutputs();
  const stale = [];
  for (const [path, content] of Object.entries(outputs)) {
    let current = null;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = null;
    }
    if (current === content) continue;
    if (check) stale.push(relative(root, path));
    else writeFileSync(path, content, 'utf8');
  }
  if (stale.length > 0) {
    console.error(
      `Generated deny-ruleset outputs are stale; run node generate-computer-use-deny-ruleset.mjs:\n  ${stale.join('\n  ')}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  await main(process.argv.slice(2));
