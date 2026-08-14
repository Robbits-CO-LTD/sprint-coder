import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { nativeSafeFsAddonPath } from './native-safe-fs';

export type NativeProcessIdentity = Readonly<{
  pid: number;
  parentPid: number;
  startIdentity: string;
}>;

export type NativeSocketPeerIdentity = NativeProcessIdentity &
  Readonly<{
    userId: number;
    groupId: number;
  }>;

type ProcessIdentityAddon = Readonly<{
  queryProcessIdentity(pid: number): unknown;
  querySocketPeerIdentity?(descriptor: number): unknown;
  queryNamedPipePeerIdentity?(brokerPid: number, pipeHandle: string): unknown;
}>;

let cachedAddon: ProcessIdentityAddon | null | undefined;

function addon(): ProcessIdentityAddon | null {
  if (cachedAddon !== undefined) return cachedAddon;
  try {
    cachedAddon = createRequire(join(__dirname, 'native-process-identity-loader.cjs'))(
      nativeSafeFsAddonPath(),
    ) as ProcessIdentityAddon;
  } catch {
    cachedAddon = null;
  }
  return cachedAddon;
}

function parseProcessIdentity(value: unknown): NativeProcessIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  const identity = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(identity['pid']) ||
    Number(identity['pid']) <= 0 ||
    !Number.isSafeInteger(identity['parentPid']) ||
    Number(identity['parentPid']) < 0 ||
    typeof identity['startIdentity'] !== 'string' ||
    identity['startIdentity'].length === 0 ||
    identity['startIdentity'].length > 128
  )
    return null;
  return Object.freeze({
    pid: Number(identity['pid']),
    parentPid: Number(identity['parentPid']),
    startIdentity: identity['startIdentity'],
  });
}

export function queryNativeProcessIdentity(pid: number): NativeProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const binding = addon();
    return binding === null ? null : parseProcessIdentity(binding.queryProcessIdentity(pid));
  } catch {
    return null;
  }
}

export function queryNativeSocketPeerIdentity(socket: Socket): NativeSocketPeerIdentity | null {
  if (process.platform === 'win32') return null;
  const descriptor = (socket as Socket & { _handle?: Readonly<{ fd?: unknown }> })._handle?.fd;
  if (!Number.isSafeInteger(descriptor) || Number(descriptor) < 0) return null;
  try {
    const binding = addon();
    if (binding?.querySocketPeerIdentity === undefined) return null;
    const value = binding.querySocketPeerIdentity(Number(descriptor));
    const identity = parseProcessIdentity(value);
    if (identity === null || typeof value !== 'object' || value === null) return null;
    const peer = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(peer['userId']) ||
      Number(peer['userId']) < 0 ||
      !Number.isSafeInteger(peer['groupId']) ||
      Number(peer['groupId']) < 0
    )
      return null;
    return Object.freeze({
      ...identity,
      userId: Number(peer['userId']),
      groupId: Number(peer['groupId']),
    });
  } catch {
    return null;
  }
}

export function queryNativeNamedPipePeerIdentity(
  brokerPid: number,
  pipeHandle: string,
): NativeProcessIdentity | null {
  if (
    process.platform !== 'win32' ||
    !Number.isSafeInteger(brokerPid) ||
    brokerPid <= 0 ||
    !/^[1-9][0-9]{0,31}$/.test(pipeHandle)
  )
    return null;
  try {
    const binding = addon();
    if (binding?.queryNamedPipePeerIdentity === undefined) return null;
    return parseProcessIdentity(binding.queryNamedPipePeerIdentity(brokerPid, pipeHandle));
  } catch {
    return null;
  }
}

export function sameNativeProcessIdentity(
  left: NativeProcessIdentity,
  right: NativeProcessIdentity,
): boolean {
  return left.pid === right.pid && left.startIdentity === right.startIdentity;
}

export function isNativeProcessDescendant(
  peer: NativeProcessIdentity,
  expectedRoot: NativeProcessIdentity,
  query: (pid: number) => NativeProcessIdentity | null = queryNativeProcessIdentity,
): boolean {
  let current: NativeProcessIdentity | null = peer;
  const visited = new Set<number>();
  for (let depth = 0; current !== null && depth < 64; depth += 1) {
    if (sameNativeProcessIdentity(current, expectedRoot)) return true;
    if (visited.has(current.pid) || current.parentPid <= 0 || current.parentPid === current.pid)
      return false;
    visited.add(current.pid);
    current = query(current.parentPid);
  }
  return false;
}
