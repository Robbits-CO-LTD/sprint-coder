// Exercise the compiled helper over a real pipe without opening a picker or sending native input.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const helper =
  process.env.SPRINT_CODER_COMPUTER_USE_PIPE_TEST_HELPER ??
  join(dirname(fileURLToPath(import.meta.url)), 'build/Release/sprint-coder-computer-use-host.exe');
const sessionId = randomBytes(16);

function frame(type, metadata) {
  const body = Buffer.from(JSON.stringify(metadata));
  const bytes = Buffer.alloc(68 + body.length);
  bytes.writeUInt32LE(0x31554353, 0);
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(type, 6);
  randomBytes(16).copy(bytes, 12);
  sessionId.copy(bytes, 28);
  if (type === 9) randomBytes(16).copy(bytes, 44);
  bytes.writeUInt32LE(body.length, 60);
  body.copy(bytes, 68);
  return bytes;
}

async function bounded(promise, label) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(5000, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`${label} timed out`);
      }),
    ]);
  } finally {
    controller.abort();
  }
}

async function withHelper(run) {
  const pipe = `\\\\.\\pipe\\sprint-coder-computer-use-${randomBytes(16).toString('hex')}`;
  const child = spawn(helper, ['--pipe', pipe, '--parent-pid', String(process.pid)], {
    windowsHide: true,
    stdio: 'ignore',
    env: Object.fromEntries(
      ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    ),
  });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  // A launch failure may precede the first await of the exit receipt.
  void exited.catch(() => {});
  let socket;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      assert.equal(child.exitCode, null, 'helper exited before connection');
      try {
        socket = await new Promise((resolve, reject) => {
          const candidate = createConnection(pipe);
          candidate.once('error', (error) => {
            candidate.destroy();
            reject(error);
          });
          candidate.once('connect', () => resolve(candidate));
        });
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await delay(50);
      }
    }
    assert.ok(socket, 'helper pipe was not created');
    const pending = new Map();
    let buffer = Buffer.alloc(0);
    const fail = (error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('helper pipe closed')));
    socket.on('data', (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 68) {
          assert.equal(buffer.readUInt32LE(0), 0x31554353);
          assert.equal(buffer.readUInt16LE(4), 1);
          assert.equal(buffer.readUInt32LE(64), 0, 'probe must not return screen bytes');
          const metadataBytes = buffer.readUInt32LE(60);
          assert.ok(metadataBytes > 0 && metadataBytes <= 65536);
          const size = 68 + metadataBytes;
          if (buffer.length < size) return;
          assert.deepEqual(buffer.subarray(28, 44), sessionId);
          const id = buffer.subarray(12, 28).toString('hex');
          const request = pending.get(id);
          assert.ok(request, 'unexpected response identity');
          pending.delete(id);
          request.resolve({
            type: buffer.readUInt16LE(6),
            metadata: JSON.parse(buffer.subarray(68, size).toString()),
          });
          buffer = buffer.subarray(size);
        }
      } catch (error) {
        fail(error);
      }
    });
    const expect = (bytes) => {
      const id = bytes.subarray(12, 28).toString('hex');
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      void response.catch(() => {});
      return bounded(response, 'response');
    };
    const send = (type, metadata) => {
      const bytes = frame(type, metadata);
      const response = expect(bytes);
      socket.write(bytes);
      return response;
    };
    const handshake = await send(1, { operation: 'handshake', protocolVersion: 1, apiVersion: 2 });
    assert.equal(handshake.type, 2);
    assert.equal(handshake.metadata.apiVersion, 2);
    await run({ socket, send, expect });
    socket.destroy();
    assert.deepEqual(await bounded(exited, 'helper exit'), { code: 0, signal: null });
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await bounded(exited, 'cleanup');
  }
}

test('one handshake, sequential probes, and a refused cancel respond without further writes', async () => {
  await withHelper(async ({ send }) => {
    for (let index = 0; index < 3; index += 1) {
      const response = await send(3, { operation: 'probe' });
      assert.equal(response.type, 4);
      assert.equal(response.metadata.platform, 'win32');
    }
    const cancel = await send(9, { operation: 'cancel', cancelEpoch: 1 });
    assert.equal(cancel.type, 10);
    assert.equal(cancel.metadata.code, 'invalid_cancel');
    assert.equal((await send(3, { operation: 'probe' })).type, 4);
  });
});

test('a partial next request cannot block the preceding response', async () => {
  await withHelper(async ({ socket, send, expect }) => {
    const first = send(3, { operation: 'probe' });
    const next = frame(3, { operation: 'probe' });
    socket.write(next.subarray(0, 7));
    assert.equal((await first).type, 4);
    const second = expect(next);
    socket.write(next.subarray(7));
    assert.equal((await second).type, 4);
  });
});

test('disconnecting during an incomplete request releases the pending read and exits', async () => {
  await withHelper(async ({ socket }) => {
    socket.write(frame(3, { operation: 'probe' }).subarray(0, 7));
    await delay(50);
  });
});
