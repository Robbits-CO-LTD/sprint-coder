import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The fixture's UI Automation tree in the interlock journeys of the harness
// (computer_use_protocol_fuzz.cc, "BEGIN fixture tree") is copied by hand, so it could drift from the
// real fixture and the journeys would then prove nothing about it. This test reads the real sources
// (fixture_contract.h for the class and the title, win32_acceptance_fixture.cc for every label the
// controls are created with) and requires the harness block to agree: the same class and titles, every
// label of the fixture present in the tree, and nothing in the tree that the fixture does not carry.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const fixtureDirectory = join(nativeDirectory, 'fixtures', 'win32-acceptance');
const harness = readFileSync(join(nativeDirectory, 'computer_use_protocol_fuzz.cc'), 'utf8');
const contract = readFileSync(join(fixtureDirectory, 'fixture_contract.h'), 'utf8');
const fixture = readFileSync(join(fixtureDirectory, 'win32_acceptance_fixture.cc'), 'utf8');

const unescape = (text: string): string =>
  text
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\"/gu, '"')
    .replace(/\\\\/gu, '\\');

// One wide literal, or several next to each other (adjacent literals are one string in C++).
function wideLiteral(text: string): string {
  return [...text.matchAll(/L"((?:[^"\\]|\\.)*)"/gu)].map((match) => unescape(match[1]!)).join('');
}

const constants = new Map<string, string>();
for (const match of fixture.matchAll(
  /constexpr wchar_t (\w+)\[\] = ((?:L"(?:[^"\\]|\\.)*"\s*)+);/gu,
))
  constants.set(match[1]!, wideLiteral(match[2]!));
const operand = (text: string): string =>
  text.trim().startsWith('L"') ? wideLiteral(text) : (constants.get(text.trim()) ?? `?${text}`);

// The block of the harness.
const begin = harness.indexOf('// BEGIN fixture tree');
const end = harness.indexOf('// END fixture tree');
const block = harness.slice(begin, end);
const stringConstant = (name: string): string => {
  const match = new RegExp(
    `const std::string ${name} = (?:u8)?"((?:[^"\\\\]|\\\\.)*)"(?:_u8)?;`,
    'u',
  ).exec(block);
  expect(match, name).not.toBeNull();
  return unescape(match![1]!);
};
const entries = [
  ...block.matchAll(
    /\{\s*"([^"]*)",\s*"([^"]*)",\s*(?:u8)?"((?:[^"\\]|\\.)*)"(?:_u8)?,\s*(true|false)\s*\}/gu,
  ),
].map((match) => ({ type: match[1]!, klass: match[2]!, name: unescape(match[3]!) }));

// What the fixture creates its controls with.
const labels = new Set<string>();
for (const match of fixture.matchAll(
  /AddControl\(\s*\w+,\s*[\w_|]+,\s*L"[^"]*",\s*((?:L"(?:[^"\\]|\\.)*"\s*)+|\w+)\s*,/gu,
)) {
  const label = operand(match[1]!);
  if (label !== '') labels.add(label);
}
for (const match of fixture.matchAll(
  /CreateWindowExW\(0, L"STATIC",\s*((?:L"(?:[^"\\]|\\.)*"\s*)+),/gu,
))
  labels.add(wideLiteral(match[1]!));
for (const match of fixture.matchAll(/CB_ADDSTRING, 0, reinterpret_cast<LPARAM>\((L"[^"]*")\)/gu))
  labels.add(wideLiteral(match[1]!));
const picker = /options\.lpstrTitle = ((?:L"(?:[^"\\]|\\.)*"\s*)+);/u.exec(fixture);

describe('the harness fixture tree against the real fixture (#500 S5-c-2 PR-5 review)', () => {
  it('reads the sources', () => {
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    expect(entries.length).toBeGreaterThan(15);
    expect(labels.size).toBeGreaterThan(14);
    expect(picker).not.toBeNull();
  });

  it('uses the fixture window class and title from fixture_contract.h', () => {
    expect(stringConstant('fixture_class')).toBe(
      /kWindowClass\[\] = L"([^"]+)"/u.exec(contract)![1],
    );
    expect(stringConstant('fixture_title')).toBe(
      /kWindowTitle\[\] = L"([^"]+)"/u.exec(contract)![1],
    );
  });

  it('uses the safe dialog class and title, and the file picker title, of the fixture', () => {
    expect(stringConstant('dialog_class')).toBe(constants.get('kSafeDialogClass'));
    expect(stringConstant('dialog_title')).toBe(constants.get('kSafeDialogTitle'));
    expect(stringConstant('picker_title')).toBe(wideLiteral(picker![1]!));
  });

  it('carries every label the fixture creates a control with, and no other', () => {
    const tree = new Set(entries.map((entry) => entry.name).filter((name) => name !== ''));
    for (const label of labels)
      expect(tree.has(label), `missing in the harness: ${label}`).toBe(true);
    // Everything else in the tree is text the fixture sets on a control while it runs (a status), which
    // is a literal of the fixture's own source.
    const sourceLiterals = new Set(
      [...fixture.matchAll(/L"((?:[^"\\]|\\.)*)"/gu)].map((m) => unescape(m[1]!)),
    );
    for (const name of tree)
      expect(
        labels.has(name) || sourceLiterals.has(name) || wideLiteralJoined(name),
        name,
      ).toBeTruthy();
  });

  it('has the controls the contract lists: edit, buttons, a combo with items, a password edit, the dialog edit', () => {
    const find = (type: string, name: string) =>
      entries.some((entry) => entry.type === type && entry.name === name);
    expect(find('Edit', 'Fixture text: safe to replace')).toBe(true);
    expect(find('Button', 'Run deterministic normal action')).toBe(true);
    expect(find('CheckBox', 'Enable deterministic option')).toBe(true);
    expect(entries.some((entry) => entry.type === 'ComboBox')).toBe(true);
    for (const item of ['Alpha', 'Beta', 'Gamma']) expect(find('ListItem', item)).toBe(true);
    expect(
      entries.some((entry) => entry.type === 'Edit' && entry.name === 'not-a-real-secret'),
    ).toBe(true);
    expect(find('Edit', 'Safe dialog text')).toBe(true);
    expect(find('Button', 'Close safe dialog')).toBe(true);
  });
});

// A name made of adjacent literals of the fixture's source (the long texts) is one string there.
function wideLiteralJoined(name: string): boolean {
  const joined = [...fixture.matchAll(/((?:L"(?:[^"\\]|\\.)*"\s*)+)/gu)].map((m) =>
    wideLiteral(m[1]!),
  );
  return joined.includes(name);
}
