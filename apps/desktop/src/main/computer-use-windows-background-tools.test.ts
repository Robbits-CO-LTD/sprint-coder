import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildTools, fixtureDirectory } from '../../scripts/build-background-input-tools';

const run = promisify(execFile);
type RecordLine = Record<string, unknown>;
function parseLine(line: string): RecordLine {
  const parsed: unknown = JSON.parse(line);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('kind' in parsed) ||
    typeof parsed.kind !== 'string'
  )
    throw new Error('Invalid evidence');
  return Object.fromEntries(Object.entries(parsed));
}

class Tool {
  readonly child: ChildProcessWithoutNullStreams;
  readonly records: RecordLine[] = [];
  readonly exited: Promise<number | null>;
  private error: Error | undefined;
  constructor(binary: string) {
    this.child = spawn(binary, [], { windowsHide: true, stdio: 'pipe' });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        this.records.push(parseLine(line));
      } catch (error) {
        this.error = error instanceof Error ? error : new Error(String(error));
      }
    });
    this.child.stderr.on('data', (data: Buffer) => {
      this.error = new Error(data.toString());
    });
    this.exited = new Promise((resolve) => {
      this.child.once('error', (error) => {
        this.error = error;
        resolve(null);
      });
      this.child.once('close', resolve);
    });
  }
  command(command: string) {
    this.child.stdin.write(command + '\n');
  }
  async wait(predicate: (record: RecordLine) => boolean, from = 0) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (this.error) throw this.error;
      const record = this.records.slice(from).find(predicate);
      if (record) return record;
      if (this.child.exitCode !== null) throw new Error('Tool exited before evidence');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for evidence');
  }
  async close(command: string) {
    if (this.child.exitCode === null && !this.child.killed) this.command(command);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Tool shutdown timeout')), 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.child.exitCode === null && !this.child.killed) this.child.kill();
      await this.exited;
    }
  }
}

describe('P7a portable tool contracts', () => {
  it('parses evidence and rejects non-record input', () => {
    expect(parseLine('{"kind":"sample","cursorX":-20}')).toEqual({ kind: 'sample', cursorX: -20 });
    for (const input of ['null', '[]', '{}', '{"kind":1}'])
      expect(() => parseLine(input)).toThrow();
  });
  it('keeps the observer passive and records health as well as OS events', () => {
    const source = readFileSync(join(fixtureDirectory, 'observer.cc'), 'utf8');
    expect(source).not.toMatch(
      /\b(?:SetForegroundWindow|SetFocus|SetCursorPos|SendInput|SetCapture|ShowWindow|BringWindowToTop|SetActiveWindow)\s*\(/u,
    );
    for (const name of [
      'EVENT_SYSTEM_FOREGROUND',
      'EVENT_OBJECT_FOCUS',
      'EVENT_SYSTEM_CAPTURESTART',
      'WS_EX_TOPMOST',
      'WS_POPUP',
      'GetCursorPos',
      'GetGUIThreadInfo',
      'maxGapMs',
    ])
      expect(source).toContain(name);
  });
  it('keeps fixtures outside product builds and supports each delay and replacement mode', () => {
    const source = readFileSync(join(fixtureDirectory, 'fixture.cc'), 'utf8');
    for (const pattern of [
      'Invoke',
      'Value',
      'SelectionItem',
      'Toggle',
      'ExpandCollapse',
      'Scroll',
    ])
      expect(source).toContain(`UIA_${pattern}PatternId`);
    for (const command of [
      'delay-before',
      'delay-inside',
      'delay-after',
      'release',
      'replace',
      'reuse',
    ])
      expect(source).toContain(`"${command}"`);
    const gyp = readFileSync(join(fixtureDirectory, '../../binding.gyp'), 'utf8');
    expect(gyp).not.toContain('background-input');
    expect(source).not.toContain('SPRINT_CODER_TEST_');
  });
});

// Explicit opt-in: these tests compile native programs and create their own visible windows.
describe.skipIf(
  process.platform !== 'win32' || process.env.SPRINT_CODER_P7A_NATIVE_SELF_TEST !== '1',
)('P7a native tool self-tests (not BG acceptance)', () => {
  it('exposes six real UIA patterns, counts effects, and reuses stable identities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sc-p7a-provider-'));
    let fixture: Tool | undefined;
    try {
      const binaries = await buildTools(root);
      fixture = new Tool(binaries.fixture);
      await fixture.wait((r) => r.kind === 'ready');
      const controls = fixture.records.filter((r) => r.kind === 'control');
      expect(controls).toHaveLength(6);
      const probe = async (index: number, apply = false) => {
        const result = await run(
          binaries.fixture,
          ['--probe', String(controls[index]?.hwnd), String(index), apply ? 'apply' : 'read'],
          { encoding: 'utf8', windowsHide: true, timeout: 15000 },
        );
        const record = parseLine(result.stdout.trim());
        expect(record.hresult).toBe(0);
        return record;
      };
      for (let index = 0; index < 6; index++) await probe(index, true);
      const before = await probe(2);
      fixture.command('replace');
      await fixture.wait((r) => r.kind === 'replacement');
      const replaced = await probe(2);
      expect(replaced.runtimeId).toEqual(before.runtimeId);
      expect(replaced.name).not.toBe(before.name);
      fixture.command('reuse');
      await fixture.wait((r) => r.kind === 'replacement' && r.virtualized === 1);
      const reused = await probe(2);
      await probe(5, true);
      const scrolled = await probe(2);
      expect(scrolled.runtimeId).toEqual(reused.runtimeId);
      expect(scrolled.name).not.toBe(reused.name);
      const at = fixture.records.length;
      fixture.command('snapshot');
      await fixture.wait((r) => r.kind === 'control' && r.index === 5, at);
      for (const record of fixture.records.slice(at).filter((r) => r.kind === 'control')) {
        expect(record.attempts).toBe(record.index === 5 ? 2 : 1);
        expect(record.effects).toBe(record.attempts);
      }
      for (const [phase, command] of [
        [1, 'delay-before'],
        [2, 'delay-inside'],
        [3, 'delay-after'],
      ] as const) {
        const start = fixture.records.length;
        fixture.command(command);
        await fixture.wait((r) => r.kind === 'armed' && r.phase === phase, start);
        const pending = probe(0, true);
        try {
          await fixture.wait((r) => r.kind === 'blocked' && r.phase === phase, start);
        } finally {
          fixture.command('release');
          await pending;
        }
        await fixture.wait((r) => r.kind === 'released' && r.phase === phase, start);
      }
    } finally {
      if (fixture) await fixture.close('quit');
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 300000);

  it('observes foreground, capture and popup stimuli from owned fixture windows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sc-p7a-observer-'));
    const tools: { tool: Tool; stop: string }[] = [];
    try {
      const binaries = await buildTools(root);
      const fixture = new Tool(binaries.fixture);
      tools.push({ tool: fixture, stop: 'quit' });
      const ready = await fixture.wait((r) => r.kind === 'ready');
      const observer = new Tool(binaries.observer);
      tools.push({ tool: observer, stop: 'stop' });
      await observer.wait((r) => r.kind === 'ready');
      fixture.command('foreground');
      const stimulus = await fixture.wait((r) => r.kind === 'stimulus');
      // Foreground lock is an environmental failure, never a silent PASS.
      expect(stimulus.foregroundAccepted).toBe(1);
      expect(
        fixture.records.some((r) => r.kind === 'apiAttempt' && r.api === 0 && r.attempts === 1),
      ).toBe(true);
      await observer.wait((r) => r.kind === 'winEvent' && r.event === 3 && r.hwnd === ready.hwnd);
      fixture.command('capture');
      await observer.wait((r) => r.kind === 'winEvent' && r.event === 8 && r.hwnd === ready.hwnd);
      fixture.command('release-capture');
      fixture.command('popup');
      const popup = await fixture.wait((r) => r.kind === 'stimulusPopup');
      expect(popup.hwnd).not.toBe(0);
      await observer.wait(
        (r) => r.kind === 'newWindow' && r.hwnd === popup.hwnd && r.topmost === 1,
      );
      observer.command('mark');
      await observer.wait((r) => r.kind === 'mark');
      await observer.close('stop');
      const finished = observer.records.find((r) => r.kind === 'finished');
      expect(finished?.samples).toBeGreaterThan(0);
      expect(
        observer.records.some((r) => r.kind === 'sample' && r.cursorOk === 1 && r.guiOk === 1),
      ).toBe(true);
    } finally {
      await Promise.all(tools.reverse().map(({ tool, stop }) => tool.close(stop)));
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 300000);
});
