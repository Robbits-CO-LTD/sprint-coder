import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(__dirname, '../..');
const workflowFiles = [
  '.github/workflows/ci.yml',
  '.github/actions/install-deps/action.yml',
  '.github/actions/install-electron/action.yml',
  '.github/actions/prepare-sandbox/action.yml',
  '.github/actions/prepare-desktop-control/action.yml',
  '.github/workflows/release-beta.yml',
  '.github/workflows/node-libuv-watch.yml',
] as const;

const workflows = Object.fromEntries(
  workflowFiles.map((file) => [file, readFileSync(resolve(repositoryRoot, file), 'utf8')]),
) as Record<(typeof workflowFiles)[number], string>;

const reviewedActionCommits: Record<string, string> = {
  'actions/checkout': '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
  'actions/cache': '2c8a9bd7457de244a408f35966fab2fb45fda9c8',
  'actions/upload-artifact': 'bbbca2ddaa5d8feaa63e36b76fdaad77386f024f',
  'actions/download-artifact': '70fc10c6e5e1ce46ad2ea6f2b72d43f7d47b13c3',
  'ilammy/msvc-dev-cmd': '0b201ec74fa43914dc39ae48a89fd1d8cb592756',
};

function jobBlock(workflow: string, job: string): string {
  const header = `\n  ${job}:`;
  const start = workflow.indexOf(header);
  expect(start, `job ${job} must exist`).toBeGreaterThanOrEqual(0);
  const nextJob = /\n {2}[A-Za-z0-9_-]+:/gu.exec(workflow.slice(start + header.length));
  const next = nextJob ? start + header.length + nextJob.index : -1;
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

function allJobBlocks(workflow: string): string[] {
  const starts = [...workflow.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gmu)].map(
    (match) => match.index!,
  );
  return starts.map((start, index) => workflow.slice(start, starts[index + 1]));
}

describe('workflow security boundaries', () => {
  it('pins every third-party action to its reviewed immutable commit', () => {
    for (const [file, workflow] of Object.entries(workflows)) {
      const refs = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)@([^\s#]+)/gmu)];
      expect(refs.length, `${file} must contain action refs`).toBeGreaterThan(0);
      for (const match of refs) {
        const action = match[1]!;
        const ref = match[2]!;
        expect(reviewedActionCommits[action], `${file}: ${action}`).toBe(ref);
        expect(ref).toMatch(/^[0-9a-f]{40}$/u);
      }
    }
  });

  it('scopes permissions per job', () => {
    for (const [file, workflow] of Object.entries(workflows)) {
      if (file.startsWith('.github/actions/')) continue;
      expect(workflow).toMatch(/^permissions:\s*\{\}\s*$/mu);
      expect(workflow).not.toMatch(/^permissions:\s*\n(?: {2,}.+\n)+/mu);
      for (const block of allJobBlocks(workflow)) {
        if (/^\s+uses:/mu.test(block)) expect(block).toMatch(/^ {4}permissions:/mu);
      }
    }
  });

  it('keeps release signing and publication behind their protected environments', () => {
    const release = workflows['.github/workflows/release-beta.yml'];
    const makeStart = release.indexOf('\n  make:');
    const releaseStart = release.indexOf('\n  release:');
    const make = release.slice(makeStart, releaseStart);
    expect(make.indexOf('Require configured protected macOS signing environment')).toBeLessThan(
      make.indexOf('uses: actions/checkout@'),
    );
    const publication = jobBlock(release, 'release');
    expect(publication).toContain('environment: release-publication');
    expect(publication).toContain('RELEASE_PUBLICATION_ENVIRONMENT_SENTINEL');
    expect(
      publication.indexOf('Require configured protected publication environment'),
    ).toBeLessThan(publication.indexOf('uses: actions/checkout@'));
  });
});
