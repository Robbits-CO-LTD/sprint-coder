import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eligibilityDeclaration, parseEligibilityMode } from './build-computer-use-eligibility.mjs';

// ADR v2 D7-3: a built Computer Use native must attest, in a real handshake, exactly what its
// manifest declares and what the requested build mode says. Both are read from the artifact that
// was built (the manifest file, and the handshake of the loaded .node or the Windows helper), never
// from this repository's sources. A mismatch means Main's three-way check would close the
// capability, or worse, that a build says one thing and does another.

const KEYS = ['classifierVersion', 'lexiconVersion', 'mode', 'rulesetVersion', 'ticketRequired'];

const repositoryDirectory = dirname(fileURLToPath(import.meta.url));
const defaultDirectory = join(
  repositoryDirectory,
  'apps',
  'desktop',
  'computer-use-native',
  'build',
  'Release',
);

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function declarationProblems(label, value, expected) {
  if (!isPlainRecord(value)) return [`${label} eligibility is missing or not an object`];
  const problems = [];
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(KEYS))
    problems.push(`${label} eligibility has unexpected keys`);
  for (const key of KEYS)
    if (value[key] !== expected[key])
      problems.push(
        `${label} eligibility.${key} is ${JSON.stringify(value[key])}, expected ${JSON.stringify(expected[key])}`,
      );
  return problems;
}

/**
 * Pure comparison of what a built artifact declares and attests. Returns the problems found (empty
 * when the artifact is what `expectedMode` ('v1' | 'v2') asked for on `platform`).
 */
export function eligibilityProblems({ platform, expectedMode, manifest, attested }) {
  let expected;
  try {
    const mode = parseEligibilityMode([`--eligibility=${expectedMode}`], platform);
    expected = eligibilityDeclaration(mode, platform);
  } catch (error) {
    return [`the requested build mode is not valid for ${platform}: ${error.message}`];
  }
  const problems = [
    ...declarationProblems('manifest', manifest, expected),
    ...declarationProblems('attested', attested, expected),
  ];
  // The two must also agree with each other field by field, whatever the expectation says.
  if (isPlainRecord(manifest) && isPlainRecord(attested))
    for (const key of KEYS)
      if (manifest[key] !== attested[key])
        problems.push(`manifest and attested eligibility.${key} differ`);
  return problems;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readAttestation(platform, directory, artifactFile) {
  const artifact = join(directory, artifactFile);
  if (!existsSync(artifact)) throw new Error(`built artifact is missing: ${artifactFile}`);
  if (platform === 'darwin') {
    const addon = createRequire(import.meta.url)(artifact);
    if (typeof addon.handshake !== 'function') throw new Error('native has no handshake export');
    const handshake = addon.handshake({ protocolVersion: 1, apiVersion: 2, featureFlag: true });
    if (!isPlainRecord(handshake)) throw new Error('native handshake is not an object');
    return handshake['eligibility'];
  }
  const run = spawnSync(artifact, ['--probe-json'], { encoding: 'utf8', timeout: 15_000 });
  if (run.status !== 0) throw new Error('the Windows helper probe did not succeed');
  const probe = JSON.parse(run.stdout);
  if (!isPlainRecord(probe)) throw new Error('the Windows helper probe is not an object');
  return probe['eligibility'];
}

/** Runs the verification and returns the process exit code. */
export function main(argv, platform = process.platform) {
  const option = (name) =>
    argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const expectedMode = option('expect');
  if (expectedMode !== 'v1' && expectedMode !== 'v2') {
    console.error('[verify-eligibility] --expect=v1|v2 is required');
    return 2;
  }
  const require_ = argv.includes('--require');
  if (platform !== 'darwin' && platform !== 'win32') {
    console.log(`[verify-eligibility] SKIP: ${platform} is outside the Computer Use contract`);
    return 0;
  }
  const directory = resolve(option('dir') ?? defaultDirectory);
  const manifestPath = join(directory, 'computer-use-native.manifest.json');
  if (!existsSync(manifestPath)) {
    if (require_) {
      console.error('[verify-eligibility] FAIL: no built manifest (--require)');
      return 1;
    }
    console.log('[verify-eligibility] SKIP: no built artifact in this environment');
    return 0;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!isPlainRecord(manifest)) throw new Error('manifest is not an object');
    if (manifest['platform'] !== platform)
      throw new Error('manifest platform differs from this host');
    const artifactFile =
      platform === 'darwin'
        ? 'sprint_coder_computer_use_native.node'
        : 'sprint-coder-computer-use-host.exe';
    const digest = platform === 'darwin' ? manifest['moduleDigest'] : manifest['binaryDigest'];
    if (digest !== sha256File(join(directory, artifactFile)))
      throw new Error('manifest digest does not match the built artifact');
    const attested = readAttestation(platform, directory, artifactFile);
    const problems = eligibilityProblems({
      platform,
      expectedMode,
      manifest: manifest['eligibility'],
      attested,
    });
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[verify-eligibility] FAIL: ${problem}`);
      return 1;
    }
    const report = option('report');
    if (report !== undefined)
      writeFileSync(
        report,
        `${JSON.stringify({ platform, expectedMode, manifest: manifest['eligibility'], attested }, null, 2)}\n`,
      );
    console.log(
      `[verify-eligibility] OK: ${platform} ${expectedMode} manifest and handshake agree (${manifest['eligibility'].mode}, ticketRequired=${manifest['eligibility'].ticketRequired})`,
    );
    return 0;
  } catch (error) {
    console.error(`[verify-eligibility] FAIL: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
