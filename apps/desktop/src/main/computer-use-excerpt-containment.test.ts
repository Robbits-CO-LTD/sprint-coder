import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// #785 T15-9 (N12, N19): the excerpt of a copied or pasted value is live-only. It is made by Main for
// the Renderer's card and rail, and these are the only source files that may name it. Anything else
// that handled a session status or an approval -- the persistence layer, the logger, the IPC layer
// that replays statuses, the output projection written into a conversation -- must stay unaware of
// it, so a field added there later cannot start carrying the value without this test saying so.

const sourceRoot = join(__dirname, '..');
/** The names a copied value's excerpt travels under (the other uses of the word are other features). */
const EXCERPT_NAMES =
  /computerUseArtifactExcerpt|computerUseApprovalTransfer|computerUseCopiedValue|\.copied\b|\bcopied:|transfer\.excerpt|showCopied/u;
const allowed = new Set([
  'main/computer-use-artifact.ts',
  'main/computer-use-controller.ts',
  'renderer/components/ComputerUsePanel.tsx',
  'renderer/hooks/useComputerUse.tsx',
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/u.test(name) && !/\.test\.tsx?$/u.test(name) ? [path] : [];
  });
}

describe('where an excerpt of a copied value may be named (N12, N19, N23)', () => {
  it('is named only by the code that makes it and the code that shows it', () => {
    const naming = sourceFiles(sourceRoot)
      .filter((path) => EXCERPT_NAMES.test(readFileSync(path, 'utf8')))
      .map((path) => relative(sourceRoot, path).replace(/\\/gu, '/'))
      .sort();
    // Exactly these: nothing else names it, and each of these really does.
    expect(naming).toEqual([...allowed].sort());
  });

  it('is not part of what a conversation is given, what is persisted, or what is logged', () => {
    for (const name of ['main/persistence.ts', 'main/secure-logger.ts', 'main/ipc.ts']) {
      expect(readFileSync(join(sourceRoot, name), 'utf8'), name).not.toMatch(EXCERPT_NAMES);
    }
    const controller = readFileSync(join(sourceRoot, 'main/computer-use-controller.ts'), 'utf8');
    // computerStartToolOutput names its fields one by one; the excerpt is not among them.
    const projection = /export function computerStartToolOutput[\s\S]*?\n\}\n/u.exec(
      controller,
    )![0];
    expect(projection).not.toMatch(/excerpt|copied|transfer/iu);
  });

  it('is not kept by the Renderer beyond its own memory', () => {
    for (const name of [
      'renderer/hooks/useComputerUse.tsx',
      'renderer/components/ComputerUsePanel.tsx',
    ]) {
      const source = readFileSync(join(sourceRoot, name), 'utf8');
      expect(source, name).not.toMatch(/localStorage|sessionStorage|indexedDB|persist\(/u);
    }
  });
});
