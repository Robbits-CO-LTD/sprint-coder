import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The fixture's UI Automation tree in the interlock journeys of the harness
// (computer_use_protocol_fuzz.cc, "BEGIN fixture tree") is copied by hand, so it could drift from the
// real fixture and the journeys would then prove nothing about it. This test reads the real sources
// (fixture_contract.h for the class and the title, win32_acceptance_fixture.cc for every control the
// fixture creates) and requires the harness block to agree: the same class and titles, and the
// controls (UI Automation type, class and Name) equal to what the sources create.
//
// The Name rule is the one UI Automation applies to Win32 controls, read from a running fixture
// (#500 S5-c-2 PR-5 review): a STATIC and a BUTTON are named by their own text; an EDIT and a COMBOBOX
// are named by the text of the STATIC created just before them (their own text is a Value, not a Name).

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

type Part = Readonly<{ type: string; klass: string; name: string }>;

// What the fixture creates, in the order of its source, as UI Automation names it.
function expectedControls(): Part[] {
  const result: Part[] = [];
  let lastStatic = '';
  const events = [
    ...fixture.matchAll(
      /CreateWindowExW\(0, L"STATIC",\s*((?:L"(?:[^"\\]|\\.)*"\s*)+),|AddControl\(\s*\w+,\s*[\w_|]+,\s*L"([^"]*)",\s*((?:L"(?:[^"\\]|\\.)*"\s*)+|\w+)\s*,([^;]*);/gu,
    ),
  ];
  for (const event of events) {
    if (event[1] !== undefined) {
      lastStatic = wideLiteral(event[1]);
      result.push({ type: 'Text', klass: 'Static', name: lastStatic });
      continue;
    }
    const klass = event[2]!.toUpperCase();
    const label = operand(event[3]!);
    const style = event[4]!;
    if (klass === 'STATIC') {
      lastStatic = label;
      result.push({ type: 'Text', klass: 'Static', name: label });
    } else if (klass === 'EDIT') {
      result.push({ type: 'Edit', klass: 'Edit', name: lastStatic });
    } else if (klass === 'COMBOBOX') {
      result.push({ type: 'ComboBox', klass: 'ComboBox', name: lastStatic });
    } else if (klass === 'BUTTON') {
      result.push({
        type: style.includes('BS_AUTOCHECKBOX') ? 'CheckBox' : 'Button',
        klass: 'Button',
        name: label,
      });
    } else {
      throw new Error(`unknown control class ${klass}`);
    }
  }
  return result;
}

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
function vector(name: string): Part[] {
  const match = new RegExp(
    `const std::vector<Control> ${name} = \\{([\\s\\S]*?)\\n  \\};`,
    'u',
  ).exec(block);
  expect(match, name).not.toBeNull();
  return [
    ...match![1]!.matchAll(
      /\{\s*"([^"]*)",\s*"([^"]*)",\s*(?:u8)?"((?:[^"\\]|\\.)*)"(?:_u8)?,\s*(?:true|false)\s*\}/gu,
    ),
  ].map((entry) => ({ type: entry[1]!, klass: entry[2]!, name: unescape(entry[3]!) }));
}
const key = (part: Part): string => `${part.type} | ${part.klass} | ${part.name}`;

const picker = /options\.lpstrTitle = ((?:L"(?:[^"\\]|\\.)*"\s*)+);/u.exec(fixture);
const comboItems = [
  ...fixture.matchAll(/CB_ADDSTRING, 0, reinterpret_cast<LPARAM>\((L"[^"]*")\)/gu),
].map((match) => wideLiteral(match[1]!));

describe('the harness fixture tree against the real fixture (#500 S5-c-2 PR-5 review)', () => {
  it('reads the sources', () => {
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    expect(expectedControls().length).toBeGreaterThan(15);
    expect(picker).not.toBeNull();
    expect(comboItems).toEqual(['Alpha', 'Beta', 'Gamma']);
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

  it('has exactly the controls the fixture creates: UI Automation type, class and Name', () => {
    const tree = [...vector('controls'), ...vector('dialog_controls')].map(key).sort();
    const created = expectedControls().map(key).sort();
    expect(tree).toEqual(created);
  });

  it('names an Edit and a ComboBox by the label before them, never by their own text', () => {
    const tree = [...vector('controls'), ...vector('dialog_controls')];
    // The dummy password and the initial text are the Value of their Edit, never a Name.
    for (const text of [constants.get('kDummyPassword'), constants.get('kInitialText')])
      expect(
        tree.some((part) => part.name === text),
        text,
      ).toBe(false);
    // The password Edit carries the password label, and is flagged as the password Edit.
    expect(
      tree.some((part) => part.type === 'Edit' && part.name.startsWith('Password field')),
    ).toBe(true);
    expect(/"Edit", "Edit", u8"Password field[^}]*true\s*\}/u.test(block)).toBe(true);
  });

  it('lists the entries of the combo as the fixture adds them, and a status text the fixture sets', () => {
    expect(
      vector('combo_parts')
        .filter((part) => part.type === 'ListItem')
        .map((part) => part.name),
    ).toEqual(comboItems);
    const literals = new Set(
      [...fixture.matchAll(/L"((?:[^"\\]|\\.)*)"/gu)].map((match) => unescape(match[1]!)),
    );
    for (const part of vector('status_texts'))
      expect(literals.has(part.name), part.name).toBe(true);
  });
});
