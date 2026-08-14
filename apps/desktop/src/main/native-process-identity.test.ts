import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isNativeProcessDescendant,
  queryNativeProcessIdentity,
  queryNativeSocketPeerIdentity,
  sameNativeProcessIdentity,
  type NativeProcessIdentity,
} from './native-process-identity';

const socketPaths: string[] = [];

afterEach(() => {
  for (const path of socketPaths.splice(0)) {
    try {
      unlinkSync(path);
    } catch {
      // Already removed when the server closed.
    }
  }
});

describe('native process identity', () => {
  it('returns a stable start identity for the current process', () => {
    const first = queryNativeProcessIdentity(process.pid);
    const second = queryNativeProcessIdentity(process.pid);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).toEqual(second);
    expect(first?.pid).toBe(process.pid);
    expect(first?.startIdentity.length).toBeGreaterThan(0);
  });

  it('walks the process tree while rejecting PID reuse and cycles', () => {
    const root: NativeProcessIdentity = { pid: 10, parentPid: 1, startIdentity: 'linux:100' };
    const child: NativeProcessIdentity = { pid: 20, parentPid: 10, startIdentity: 'linux:200' };
    const grandchild: NativeProcessIdentity = {
      pid: 30,
      parentPid: 20,
      startIdentity: 'linux:300',
    };
    const identities = new Map([
      [10, root],
      [20, child],
      [30, grandchild],
    ]);
    const query = (pid: number): NativeProcessIdentity | null => identities.get(pid) ?? null;

    expect(isNativeProcessDescendant(grandchild, root, query)).toBe(true);
    expect(
      isNativeProcessDescendant(grandchild, { ...root, startIdentity: 'linux:101' }, query),
    ).toBe(false);
    expect(sameNativeProcessIdentity(root, { ...root, parentPid: 999 })).toBe(true);

    identities.set(20, { ...child, parentPid: 30 });
    expect(isNativeProcessDescendant(grandchild, root, query)).toBe(false);

    identities.set(20, child);
    identities.set(10, { ...root, startIdentity: 'linux:250' });
    expect(isNativeProcessDescendant(grandchild, identities.get(10)!, query)).toBe(false);
  });

  it('fails closed when parent and child start identities cannot be ordered', () => {
    const root: NativeProcessIdentity = { pid: 10, parentPid: 1, startIdentity: 'unknown' };
    const child: NativeProcessIdentity = { pid: 20, parentPid: 10, startIdentity: 'unknown-child' };

    expect(isNativeProcessDescendant(child, root, () => root)).toBe(false);
  });

  it.runIf(process.platform !== 'win32')(
    'reads the kernel-authenticated peer identity from an accepted Unix socket',
    async () => {
      const path = join(tmpdir(), `sc-peer-${process.pid}-${Date.now()}.sock`);
      socketPaths.push(path);
      const peerPromise = new Promise<ReturnType<typeof queryNativeSocketPeerIdentity>>(
        (resolve, reject) => {
          const server = createServer((socket) => {
            resolve(queryNativeSocketPeerIdentity(socket));
            socket.destroy();
            server.close();
          });
          server.once('error', reject);
          server.listen(path, () => {
            const client = createConnection(path);
            client.once('error', reject);
          });
        },
      );

      const peer = await peerPromise;
      const current = queryNativeProcessIdentity(process.pid);
      expect(peer).not.toBeNull();
      expect(current).not.toBeNull();
      expect(sameNativeProcessIdentity(peer!, current!)).toBe(true);
      expect(peer?.userId).toBe(process.getuid?.());
    },
  );
});
