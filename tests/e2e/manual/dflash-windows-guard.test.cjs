const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  RELEASE,
  SENTINEL,
  assertOwnedLane,
  compareInspectorBytes,
  verifyDistribution,
} = require('./dflash-windows-guard.cjs');

function executable() {
  const value = Buffer.alloc(2 * 1024 * 1024 + 64, 0x5a);
  const start = 1024 * 1024 - 16;
  SENTINEL.copy(value, start);
  const wire = start + SENTINEL.length;
  value[wire] = 1;
  value[wire + 1] = 9;
  value.fill(48, wire + 2, wire + 11);
  return { value, offset: wire + 5, wire };
}
function fixture(t) {
  const lane = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dflash-guard-'));
  t.after(() => fs.rmSync(lane, { recursive: true, force: true }));
  const dependencyRoot = path.join(lane, 'deps');
  const profile = path.join(lane, 'profile');
  for (const dir of [dependencyRoot, profile, path.join(lane, 'app')]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(lane, 'beta3.zip'), 'not the pinned ZIP');
  fs.writeFileSync(path.join(lane, 'app', 'Sprint Coder.exe'), 'fixture');
  const policy = { ...RELEASE, lane, dependencyRoot };
  const binding = {
    schemaVersion: 1,
    owner: policy.owner,
    lane,
    profile,
    version: policy.version,
    source: policy.source,
    zipSha256: policy.zipSha256,
  };
  const ownerFile = path.join(lane, '.dflash-acceptance-owner.json');
  const profileFile = path.join(profile, '.dflash-profile-owner.json');
  fs.writeFileSync(ownerFile, JSON.stringify(binding));
  fs.writeFileSync(profileFile, JSON.stringify(binding));
  return { lane, dependencyRoot, profile, policy, binding, ownerFile, profileFile };
}
test('only the disabled-to-enabled inspector fuse byte is allowed, with chunk comparison', () => {
  const { value, offset } = executable();
  assert.equal(compareInspectorBytes(value, value).changedByteCount, 0);
  assert.throws(() => compareInspectorBytes(value, value, true));
  const inspected = Buffer.from(value);
  inspected[offset] = 49;
  assert.deepEqual(compareInspectorBytes(value, inspected, true), {
    allowedFuseIndex: 3,
    allowedOffset: offset,
    changedByteCount: 1,
    forbiddenChangedByteCount: 0,
    comparedChunks: 3,
    changedChunks: 1,
    changes: [{ offset, original: 48, inspected: 49 }],
  });
});
test('reject extra changes in the same chunk, another chunk, and appended bytes', () => {
  const { value, offset } = executable();
  for (const extra of [offset + 1, 0, value.length - 1]) {
    const inspected = Buffer.from(value);
    inspected[offset] = 49;
    inspected[extra] ^= 1;
    assert.throws(() => compareInspectorBytes(value, inspected, true), /outside/);
  }
  assert.throws(
    () => compareInspectorBytes(value, Buffer.concat([value, Buffer.from([0])])),
    /length/,
  );
});
test('reject ambiguous or malformed fuse wires and invalid target states', () => {
  const { value, offset, wire } = executable();
  const duplicate = Buffer.from(value);
  SENTINEL.copy(duplicate, 0);
  assert.throws(() => compareInspectorBytes(duplicate, duplicate), /one fuse sentinel/);
  for (const at of [wire, wire + 1]) {
    const malformed = Buffer.from(value);
    malformed[at] = 0;
    assert.throws(() => compareInspectorBytes(malformed, malformed));
  }
  const invalid = Buffer.from(value);
  invalid[offset] = 114;
  assert.throws(() => compareInspectorBytes(value, invalid), /outside/);
});
test('require matching lane and profile ownership, version and source before use', (t) => {
  const f = fixture(t);
  assert.equal(assertOwnedLane(f.lane, f.dependencyRoot, f.policy).profile, f.profile);
  for (const changes of [
    { profile: f.lane },
    { version: '0.2.3' },
    { source: '0'.repeat(40) },
    { owner: 'another-issue' },
    { zipSha256: '0'.repeat(64) },
  ]) {
    fs.writeFileSync(f.profileFile, JSON.stringify({ ...f.binding, ...changes }));
    assert.throws(() => assertOwnedLane(f.lane, f.dependencyRoot, f.policy), /marker mismatch/);
  }
  fs.writeFileSync(f.profileFile, JSON.stringify(f.binding));
  fs.unlinkSync(f.ownerFile);
  assert.throws(() => assertOwnedLane(f.lane, f.dependencyRoot, f.policy));
});
test('reject broad or alternate lane/dependency paths even with markers', (t) => {
  const f = fixture(t);
  assert.throws(
    () => assertOwnedLane(path.dirname(f.lane), f.dependencyRoot, f.policy),
    /Unapproved lane/,
  );
  assert.throws(() => assertOwnedLane(f.lane, f.profile, f.policy), /Unapproved dependencies/);
  assert.throws(
    () => assertOwnedLane(`${f.lane}${path.sep}.`, f.dependencyRoot, f.policy),
    /Unapproved lane/,
  );
});
test('reject profile symlinks and hardlinked SQLite/evidence files', (t) => {
  const f = fixture(t);
  const actual = path.join(f.lane, 'other-profile');
  fs.renameSync(f.profile, actual);
  fs.symlinkSync(actual, f.profile, 'junction');
  assert.throws(() => assertOwnedLane(f.lane, f.dependencyRoot, f.policy), /Symlink/);
  fs.unlinkSync(f.profile);
  fs.renameSync(actual, f.profile);
  const db = path.join(f.profile, 'sprint-coder.sqlite3');
  fs.writeFileSync(db, 'test-only');
  fs.linkSync(db, path.join(f.lane, 'another-db'));
  assert.throws(() => assertOwnedLane(f.lane, f.dependencyRoot, f.policy), /Hardlinked/);
});
test('wrong ZIP is rejected before dependencies, flip, or application launch', async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.lane, 'app', 'Sprint Coder.exe'));
  await assert.rejects(
    verifyDistribution(f.lane, f.dependencyRoot, false, f.policy),
    /Release ZIP mismatch/,
  );
  assert.deepEqual(fs.readFileSync(path.join(f.lane, 'app', 'Sprint Coder.exe')), before);
});
test('both runner entrypoints reject an arbitrary lane without any writes', (t) => {
  const f = fixture(t);
  const before = fs.readdirSync(f.lane).sort();
  for (const runner of ['dflash-windows-download.cjs', 'dflash-windows-acceptance.cjs']) {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, runner), f.lane, f.dependencyRoot],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unapproved lane/);
    assert.deepEqual(fs.readdirSync(f.lane).sort(), before);
  }
});
