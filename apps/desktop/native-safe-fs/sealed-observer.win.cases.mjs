import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { setTimeout } from 'node:timers';
import { Worker } from 'node:worker_threads';

// Standalone node:test runner, also launched by native-safe-fs.test.ts on Windows.
const addon =
  process.platform === 'win32'
    ? createRequire(import.meta.url)(
        resolve(
          process.env.SPRINT_CODER_NATIVE_SAFE_FS_ADDON ??
            'build/Release/sprint_coder_native_safe_fs.node',
        ),
      )
    : null;

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sealed-observer-')));
  const sessions = [];
  t.after(() => {
    for (const session of sessions) addon.closeReadSession(session);
    rmSync(base, { recursive: true, force: true });
  });
  const root = join(base, 'workspace');
  const locks = join(base, 'locks');
  mkdirSync(root);
  mkdirSync(locks);
  const stat = lstatSync(root, { bigint: true });
  const input = {
    rootId: 'root-1',
    workspacePath: root,
    rootDev: String(stat.dev),
    rootIno: String(stat.ino),
    workspaceKey: randomBytes(32).toString('hex'),
    lockDirectoryPath: locks,
  };
  const open = () => {
    const session = addon.openReadSession(input);
    sessions.push(session);
    return session;
  };
  return { base, root, input, open };
}

const winTest = (name, fn) => test(name, { skip: process.platform !== 'win32' }, fn);
const observe = (session, ...pathSegments) =>
  addon.observeSealedPostImage({ sessionId: session.id, pathSegments });

function mutationObservation(input, sourceSegments) {
  const mutation = addon.openSession({ ...input, fence: '1' });
  try {
    return addon.observeIntent({
      sessionId: mutation.id,
      intentId: 'sealed-observer-case',
      intentDigest: '1'.repeat(64),
      recordDigest: '2'.repeat(64),
      revision: 1,
      sourceSegments,
      destinationSegments: null,
      auxiliarySegments: null,
    }).source;
  } finally {
    addon.closeSession(mutation.id);
  }
}

winTest('matches mutation case-insensitive lookup for both parent and leaf names', (t) => {
  const { root, input, open } = fixture(t);
  mkdirSync(join(root, 'Nested'));
  writeFileSync(join(root, 'Nested', 'Mixed.TXT'), 'mixed-case bytes');
  const expected = mutationObservation(input, ['nested', 'mixed.txt']);
  assert.equal(expected.state, 'present');
  const session = open();
  for (const segments of [
    ['Nested', 'mixed.txt'],
    ['nested', 'Mixed.TXT'],
  ]) {
    const result = observe(session, ...segments);
    assert.equal(result.kind, 'file');
    assert.equal(result.contentHash, expected.contentHash);
    assert.equal(result.identityDigest, expected.identityDigest);
  }
  assert.deepEqual(observe(session, 'nested'), { kind: 'directory' });
});

winTest('preserves explicit case-sensitive directory lookup and distinct file identities', (t) => {
  const { root, input, open } = fixture(t);
  const sensitive = join(root, 'sensitive');
  mkdirSync(sensitive);
  const enable = spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', sensitive, 'enable']);
  if (enable.status !== 0) {
    t.skip('Enabling per-directory case sensitivity requires Windows support and permission');
    return;
  }
  const identity = lstatSync(sensitive, { bigint: true });
  assert.equal(
    addon.directoryCaseSensitive({
      path: sensitive,
      dev: String(identity.dev),
      ino: String(identity.ino),
    }),
    true,
  );
  writeFileSync(join(sensitive, 'Mixed.TXT'), 'upper');
  writeFileSync(join(sensitive, 'mixed.txt'), 'lower');
  assert.notEqual(
    lstatSync(join(sensitive, 'Mixed.TXT'), { bigint: true }).ino,
    lstatSync(join(sensitive, 'mixed.txt'), { bigint: true }).ino,
  );
  const expected = mutationObservation(input, ['sensitive', 'mixed.txt']);
  assert.equal(expected.state, 'present');
  const session = open();
  const lower = observe(session, 'sensitive', 'mixed.txt');
  const upper = observe(session, 'sensitive', 'Mixed.TXT');
  assert.equal(lower.contentHash, expected.contentHash);
  assert.equal(lower.identityDigest, expected.identityDigest);
  assert.equal(upper.contentHash, createHash('sha256').update('upper').digest('hex'));
  assert.notEqual(lower.identityDigest, upper.identityDigest);
  assert.deepEqual(observe(session, 'sensitive', 'MIXED.txt'), { kind: 'absent' });
});

winTest('observes raw bytes, absence, directory and mutation-compatible file identity', (t) => {
  const { root, input, open } = fixture(t);
  mkdirSync(join(root, 'nested'));
  const bytes = Buffer.from([0, 0x80, 0xff]);
  writeFileSync(join(root, 'nested', 'file'), bytes);
  const session = open();
  assert.equal(session.rootDev, input.rootDev);
  assert.equal(session.rootIno, input.rootIno);
  assert.equal(session.workspaceKey, input.workspaceKey);
  assert.match(session.id, /^[a-f0-9]{32}$/);
  const result = observe(session, 'nested', 'file');
  assert.equal(result.kind, 'file');
  assert.equal(result.contentHash, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.size, bytes.length);
  assert.match(result.identityDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(observe(session, 'nested', 'missing'), { kind: 'absent' });
  assert.deepEqual(observe(session, 'nested'), { kind: 'directory' });
  addon.closeReadSession(session);
  const mutation = addon.openSession({ ...input, fence: '1' });
  try {
    const effect = addon.observeIntent({
      sessionId: mutation.id,
      intentId: 'sealed-observer-identity',
      intentDigest: '1'.repeat(64),
      recordDigest: '2'.repeat(64),
      revision: 1,
      sourceSegments: ['nested', 'file'],
      destinationSegments: null,
      auxiliarySegments: null,
    });
    assert.equal(effect.source.identityDigest, result.identityDigest);
  } finally {
    addon.closeSession(mutation.id);
  }
});

winTest('rejects junction parents for file, absent and directory observations', (t) => {
  const { base, root, open } = fixture(t);
  const outside = join(base, 'outside');
  mkdirSync(outside);
  mkdirSync(join(outside, 'directory'));
  writeFileSync(join(outside, 'file'), 'sealed bytes');
  symlinkSync(outside, join(root, 'nested'), 'junction');
  const session = open();
  for (const leaf of ['file', 'missing', 'directory'])
    assert.throws(() => observe(session, 'nested', leaf), { code: 'UNSAFE_PATH' });
  assert.deepEqual(observe(session, 'nested'), { kind: 'other' });
});

winTest('rejects a replaced root and junction ancestors before opening a session', (t) => {
  const { base, root, input } = fixture(t);
  renameSync(root, join(base, 'original'));
  mkdirSync(root);
  assert.throws(() => addon.openReadSession(input), { code: 'ROOT_IDENTITY_CHANGED' });
  symlinkSync(base, join(base, 'alias'), 'junction');
  const original = lstatSync(join(base, 'original'), { bigint: true });
  assert.throws(
    () =>
      addon.openReadSession({
        ...input,
        workspacePath: join(base, 'alias', 'original'),
        rootIno: String(original.ino),
      }),
    { code: 'UNSAFE_PATH' },
  );
});

winTest('pins the root namespace until the last shared reader closes', (t) => {
  const { base, root, open } = fixture(t);
  const first = open();
  const second = open();
  assert.throws(() => renameSync(root, join(base, 'moved')));
  addon.closeReadSession(first);
  assert.throws(() => renameSync(root, join(base, 'moved')));
  addon.closeReadSession(second);
  renameSync(root, join(base, 'moved'));
  assert.throws(() => observe(second, 'missing'), { code: 'STALE_SESSION' });
  addon.closeReadSession(second);
});

winTest('excludes mutations in both directions without changing the durable fence', (t) => {
  const { input, open } = fixture(t);
  const mutation = addon.openSession({ ...input, fence: '1' });
  try {
    assert.throws(open, { code: 'LOCK_BUSY' });
  } finally {
    addon.closeSession(mutation.id);
  }
  const before = readFileSync(join(input.lockDirectoryPath, `${input.workspaceKey}.lock`));
  const session = open();
  assert.throws(() => addon.openSession({ ...input, fence: '2' }), { code: 'LOCK_BUSY' });
  addon.closeReadSession(session);
  assert.deepEqual(
    readFileSync(join(input.lockDirectoryPath, `${input.workspaceKey}.lock`)),
    before,
  );
  const next = addon.openSession({ ...input, fence: '2' });
  addon.closeSession(next.id);
});

winTest('refuses shared-link files, active writers and invalid segments', (t) => {
  const { root, open } = fixture(t);
  writeFileSync(join(root, 'file'), 'sealed bytes');
  linkSync(join(root, 'file'), join(root, 'link'));
  const session = open();
  assert.deepEqual(observe(session, 'file'), { kind: 'other' });
  writeFileSync(join(root, 'busy'), 'before');
  const writer = openSync(join(root, 'busy'), 'r+');
  try {
    assert.throws(() => observe(session, 'busy'), { code: 'UNSAFE_PATH' });
  } finally {
    closeSync(writer);
  }
  for (const segments of [[], ['..', 'file'], ['file:stream'], ['nested/file'], ['file.']])
    assert.throws(() => observe(session, ...segments), { code: 'INVALID_INPUT' });
});

winTest(
  'handles empty and maximum-size post-images but refuses oversized files and missing parents',
  (t) => {
    const { root, open } = fixture(t);
    const session = open();
    for (const size of [0, 1024 * 1024]) {
      const bytes = Buffer.alloc(size, 0x80);
      writeFileSync(join(root, 'file'), bytes);
      assert.equal(
        observe(session, 'file').contentHash,
        createHash('sha256').update(bytes).digest('hex'),
      );
    }
    writeFileSync(join(root, 'file'), Buffer.alloc(1024 * 1024 + 1));
    assert.throws(() => observe(session, 'file'), { code: 'UNSAFE_PATH' });
    assert.throws(() => observe(session, 'missing-parent', 'leaf'), { code: 'UNSAFE_PATH' });
  },
);

winTest('refuses hard-linked and reparse workspace lock files', (t) => {
  const { base, input, open } = fixture(t);
  const target = join(base, 'protected');
  writeFileSync(target, 'unchanged');
  const lock = join(input.lockDirectoryPath, `${input.workspaceKey}.lock`);
  linkSync(target, lock);
  assert.throws(open, { code: 'UNSAFE_LOCK' });
  unlinkSync(lock);
  symlinkSync(base, lock, 'junction');
  assert.throws(open, { code: 'UNSAFE_LOCK' });
  assert.equal(readFileSync(target, 'utf8'), 'unchanged');
});

winTest(
  'never accepts outside absence or directory during concurrent junction swaps',
  async (t) => {
    const { base, root, open } = fixture(t);
    const nested = join(root, 'nested');
    const parked = join(root, 'parked');
    const outside = join(base, 'outside');
    mkdirSync(nested);
    mkdirSync(outside);
    writeFileSync(join(nested, 'missing-outside'), 'honest');
    writeFileSync(join(nested, 'directory-outside'), 'honest');
    mkdirSync(join(outside, 'directory-outside'));
    // Prove this fixture permits the attack before the observer pins the namespace.
    renameSync(nested, parked);
    symlinkSync(outside, nested, 'junction');
    assert.equal(lstatSync(join(nested, 'directory-outside')).isDirectory(), true);
    unlinkSync(nested);
    renameSync(parked, nested);
    const session = open();
    const control = new Int32Array(new SharedArrayBuffer(16));
    const worker = new Worker(
      `
    const { workerData } = require('node:worker_threads');
    const { renameSync, symlinkSync, unlinkSync } = require('node:fs');
    const { nested, parked, outside, buffer } = workerData;
    const control = new Int32Array(buffer);
    Atomics.store(control, 0, 1);
    while (!Atomics.load(control, 1)) {
      Atomics.add(control, 3, 1);
      try { renameSync(nested, parked); } catch { continue; }
      try {
        symlinkSync(outside, nested, 'junction');
        Atomics.add(control, 2, 1);
        Atomics.wait(control, 1, 0, 1);
        unlinkSync(nested);
      } finally { renameSync(parked, nested); }
    }
  `,
      { eval: true, workerData: { nested, parked, outside, buffer: control.buffer } },
    );
    const done = new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)),
      );
    });
    try {
      while (!Atomics.load(control, 0)) await new Promise((resolve) => setTimeout(resolve, 5));
      // Either deny the rename itself or refuse a link encountered during the relative walk.
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        for (const leaf of ['missing-outside', 'directory-outside']) {
          try {
            const result = observe(session, 'nested', leaf);
            assert.equal(result.kind, 'file');
            assert.equal(result.contentHash, createHash('sha256').update('honest').digest('hex'));
          } catch (error) {
            assert.equal(error.code, 'UNSAFE_PATH');
          }
        }
      }
    } finally {
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1);
      await done;
    }
    assert.ok(Atomics.load(control, 3) > 0, 'the adversary must attempt the directory swap');
    t.diagnostic(
      `swap attempts: ${Atomics.load(control, 3)}, installed junctions: ${Atomics.load(control, 2)}`,
    );
    assert.equal(observe(session, 'nested', 'missing-outside').kind, 'file');
  },
);
