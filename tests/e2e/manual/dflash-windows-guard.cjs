const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const RELEASE = Object.freeze({
  lane: 'C:\\Users\\yusei\\sc-issue-434-20260915',
  dependencyRoot: 'C:\\Users\\yusei\\sc-windows-validation-20260914\\repo',
  owner: 'issue-434-20260915',
  version: '0.7.0-beta.3',
  source: '5b20208eb7b4f7697105dca2bf9436da3aeec910',
  zipSha256: '663a29379f9908f1f9d0beea1e7d4eb89df526748d8326e198f19fe97cf3daeb',
  asarSha256: '24a1211a83a8f082880b490a4c87de7d4b8d0ff81d7ac3fa85eddcface813d1b',
  entryCount: 113,
});
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const canonical = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

function regular(file, directory = false) {
  const stat = fs.lstatSync(file);
  assert.ok(!stat.isSymbolicLink(), 'Symlink or junction rejected');
  assert.ok(directory ? stat.isDirectory() : stat.isFile(), 'Wrong file kind');
  if (!directory) assert.equal(stat.nlink, 1, 'Hardlinked file rejected');
  assert.equal(
    canonical(fs.realpathSync(file)),
    canonical(path.resolve(file)),
    'Path alias rejected',
  );
}
function noAliasedParents(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    regular(current, true);
    if (path.dirname(current) === current) break;
  }
}
function filesUnder(root, prefix = '') {
  regular(root, true);
  const result = [];
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    regular(file, stat.isDirectory());
    if (stat.isDirectory()) result.push(...filesUnder(file, `${prefix}${name}/`));
    else result.push(`${prefix}${name}`);
  }
  return result;
}
function marker(file, expected) {
  regular(file);
  assert.ok(fs.statSync(file).size <= 4096, 'Ownership marker too large');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')),
    expected,
    'Ownership marker mismatch',
  );
}

// Only tests supply a temporary policy. Production callers always use the pinned policy.
function assertOwnedLane(laneInput, dependencyInput, policy = RELEASE) {
  assert.equal(typeof laneInput, 'string', 'Explicit owned lane required');
  assert.equal(typeof dependencyInput, 'string', 'Explicit dependency root required');
  assert.equal(canonical(laneInput), canonical(policy.lane), 'Unapproved lane');
  assert.equal(
    canonical(dependencyInput),
    canonical(policy.dependencyRoot),
    'Unapproved dependencies',
  );
  const lane = path.resolve(laneInput);
  const dependencyRoot = path.resolve(dependencyInput);
  noAliasedParents(lane);
  noAliasedParents(dependencyRoot);
  const profile = path.join(lane, 'profile');
  regular(profile, true);
  const binding = {
    schemaVersion: 1,
    owner: policy.owner,
    lane: policy.lane,
    profile,
    version: policy.version,
    source: policy.source,
    zipSha256: policy.zipSha256,
  };
  marker(path.join(lane, '.dflash-acceptance-owner.json'), binding);
  marker(path.join(profile, '.dflash-profile-owner.json'), binding);
  filesUnder(lane);
  regular(path.join(lane, 'beta3.zip'));
  regular(path.join(lane, 'app'), true);
  regular(path.join(lane, 'app', 'Sprint Coder.exe'));
  return { lane, profile, dependencyRoot };
}

function compareInspectorBytes(original, inspected, requireInspector = false) {
  assert.equal(inspected.length, original.length, 'Executable length changed');
  const sentinel = original.indexOf(SENTINEL);
  assert.ok(
    sentinel >= 0 && sentinel === original.lastIndexOf(SENTINEL),
    'Expected one fuse sentinel',
  );
  const wire = sentinel + SENTINEL.length;
  assert.equal(original[wire], 1, 'Unexpected fuse wire version');
  assert.equal(original[wire + 1], 9, 'Unexpected fuse count');
  const allowedOffset = wire + 2 + 3;
  assert.equal(original[allowedOffset], 48, 'Release inspector fuse is not disabled');
  const changes = [];
  const chunkSize = 1024 * 1024;
  let comparedChunks = 0;
  let changedChunks = 0;
  for (let start = 0; start < original.length; start += chunkSize) {
    comparedChunks++;
    const end = Math.min(start + chunkSize, original.length);
    if (original.subarray(start, end).equals(inspected.subarray(start, end))) continue;
    changedChunks++;
    // Enumerate bytes only in unequal chunks; Buffer.equals handles all equal chunks natively.
    for (let offset = start; offset < end; offset++) {
      if (original[offset] === inspected[offset]) continue;
      assert.ok(
        offset === allowedOffset && original[offset] === 48 && inspected[offset] === 49,
        'Difference outside the allowed inspector fuse byte',
      );
      changes.push({ offset, original: original[offset], inspected: inspected[offset] });
    }
  }
  assert.equal(changes.length, requireInspector ? 1 : inspected[allowedOffset] === 49 ? 1 : 0);
  return {
    allowedFuseIndex: 3,
    allowedOffset,
    changedByteCount: changes.length,
    forbiddenChangedByteCount: 0,
    comparedChunks,
    changedChunks,
    changes,
  };
}
async function digest(stream) {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}
async function executableBuffer(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    assert.ok(size <= 512 * 1024 * 1024, 'Executable exceeds bound');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function archivePath(root, name) {
  assert.ok(
    !name.includes('\\') && name.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Unsafe archive path',
  );
  const file = path.resolve(root, name);
  assert.ok(file.startsWith(`${path.resolve(root)}${path.sep}`), 'Archive path escape');
  return file;
}
async function verifyDistribution(
  laneInput,
  dependencyInput,
  requireInspector = false,
  policy = RELEASE,
) {
  const { lane, dependencyRoot } = assertOwnedLane(laneInput, dependencyInput, policy);
  const zip = path.join(lane, 'beta3.zip');
  assert.equal(await digest(fs.createReadStream(zip)), policy.zipSha256, 'Release ZIP mismatch');
  const appRoot = path.join(lane, 'app');
  const actualFiles = filesUnder(appRoot).sort();
  const yauzl = createRequire(path.join(dependencyRoot, 'package.json'))('yauzl');
  const entries = [];
  let byteComparison;
  let originalExecutableSha256;
  let inspectedExecutableSha256;
  await new Promise((resolve, reject) => {
    yauzl.open(zip, { lazyEntries: true }, (error, archive) => {
      if (error) return reject(error);
      archive.on('error', reject);
      archive.on('end', resolve);
      archive.on('entry', (entry) => {
        (async () => {
          if (entry.fileName.endsWith('/')) {
            archive.readEntry();
            return;
          }
          assert.ok(!entries.includes(entry.fileName), 'Duplicate archive entry');
          const file = archivePath(appRoot, entry.fileName);
          regular(file);
          assert.equal(
            fs.statSync(file).size,
            entry.uncompressedSize,
            'Distribution file size mismatch',
          );
          const stream = await new Promise((done, fail) =>
            archive.openReadStream(entry, (err, value) => (err ? fail(err) : done(value))),
          );
          if (entry.fileName === 'Sprint Coder.exe') {
            const original = await executableBuffer(stream);
            const inspected = fs.readFileSync(file);
            byteComparison = compareInspectorBytes(original, inspected, requireInspector);
            originalExecutableSha256 = createHash('sha256').update(original).digest('hex');
            inspectedExecutableSha256 = createHash('sha256').update(inspected).digest('hex');
          } else {
            const expected = await digest(stream);
            assert.equal(
              await digest(fs.createReadStream(file)),
              expected,
              'Distribution file digest mismatch',
            );
            if (entry.fileName === 'resources/app.asar')
              assert.equal(expected, policy.asarSha256, 'App version/source binding mismatch');
          }
          entries.push(entry.fileName);
          archive.readEntry();
        })().catch((err) => {
          archive.close();
          reject(err);
        });
      });
      archive.readEntry();
    });
  });
  assert.equal(entries.length, policy.entryCount, 'Unexpected distribution file count');
  assert.deepEqual(actualFiles, entries.sort(), 'Extra or missing distribution files');
  assert.ok(byteComparison, 'Release executable missing');
  const asar = createRequire(path.join(dependencyRoot, 'package.json'))('@electron/asar');
  const packageJson = JSON.parse(
    asar.extractFile(path.join(appRoot, 'resources', 'app.asar'), 'package.json').toString('utf8'),
  );
  assert.equal(packageJson.version, policy.version, 'Packaged app version mismatch');
  return {
    version: policy.version,
    source: policy.source,
    archiveSha256: policy.zipSha256,
    asarSha256: policy.asarSha256,
    archiveFiles: entries.length,
    unchangedAppRuntimeNativeFiles: true,
    originalExecutableSha256,
    inspectedExecutableSha256,
    byteComparison,
  };
}
module.exports = { RELEASE, SENTINEL, assertOwnedLane, compareInspectorBytes, verifyDistribution };

if (require.main === module) {
  Promise.resolve()
    .then(() =>
      process.argv.includes('--ownership-only')
        ? { ownership: 'verified', ...assertOwnedLane(process.argv[2], process.argv[3]) }
        : verifyDistribution(
            process.argv[2],
            process.argv[3],
            process.argv.includes('--require-inspector'),
          ),
    )
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('DFlash ownership/distribution preflight rejected\n');
      process.exitCode = 1;
    });
}
