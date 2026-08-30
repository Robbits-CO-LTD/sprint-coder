import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerUseUserActivationGate } from './computer-use-user-activation';

function fixture(now: () => number) {
  const contents = Object.assign(new EventEmitter(), {
    id: 7,
    mainFrame: { processId: 11, routingId: 13 },
  });
  const gate = new ComputerUseUserActivationGate(contents as never, 17, now);
  const event = { sender: contents, senderFrame: contents.mainFrame } as never;
  return { contents, gate, event };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ComputerUseUserActivationGate', () => {
  it('issues one sender/frame/window-bound permit and rejects replay', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { gate, event } = fixture(() => 100);
    gate.recordForTest('mouse');
    expect(gate.consume(event, 'application')).toBeNull();
    gate.recordForTest('mouse');
    expect(gate.bindIntent(event, 'application')).toBe(true);
    expect(gate.consume(event, 'application')).toMatchObject({
      serial: 2,
      senderId: 7,
      frameProcessId: 11,
      frameRoutingId: 13,
      windowId: 17,
      pickerKind: 'application',
    });
    expect(gate.consume(event, 'application')).toBeNull();
    gate.dispose();
  });

  it('consumes expired and wrong-sender records without returning them', () => {
    vi.stubEnv('NODE_ENV', 'test');
    let now = 100;
    const { gate, event } = fixture(() => now);
    gate.recordForTest('keyboard');
    expect(gate.bindIntent(event, 'start')).toBe(true);
    now = 2_101;
    expect(gate.consume(event, 'start')).toBeNull();
    gate.recordForTest('mouse');
    expect(gate.bindIntent(event, 'application')).toBe(true);
    expect(gate.consume({ sender: {}, senderFrame: {} } as never, 'application')).toBeNull();
    expect(gate.consume(event, 'application')).toBeNull();
    gate.dispose();
  });

  it('invalidates the record on navigation before an IPC can consume it', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { contents, gate, event } = fixture(() => 100);
    gate.recordForTest('mouse');
    expect(gate.bindIntent(event, 'application')).toBe(true);
    contents.emit('did-start-navigation');
    expect(gate.consume(event, 'application')).toBeNull();
    gate.dispose();
  });

  it('advances the generation for a newer gesture so deferred latches cannot be replayed', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { gate, event } = fixture(() => 100);
    gate.recordForTest('mouse');
    expect(gate.bindIntent(event, 'start')).toBe(true);
    const firstGeneration = gate.generation();
    gate.recordForTest('mouse');
    expect(gate.generation()).toBeGreaterThan(firstGeneration);
    expect(gate.consume(event, 'start')).toBeNull();
    gate.dispose();
  });

  it('refuses a different operation and cannot rebind an activation', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { gate, event } = fixture(() => 100);
    gate.recordForTest('mouse');
    expect(gate.bindIntent(event, 'start')).toBe(true);
    expect(gate.bindIntent(event, 'application')).toBe(false);
    expect(gate.consume(event, 'application')).toBeNull();
    gate.dispose();
  });

  it('binds approval input independently from start and picker intents', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { gate, event } = fixture(() => 100);
    gate.recordForTest('mouse');
    expect(gate.bindIntent(event, 'approval', 'deny-bound')).toBe(true);
    expect(gate.consume(event, 'start')).toBeNull();
    gate.recordForTest('mouse');
    expect(gate.bindIntent(event, 'approval', 'allow-once-bound')).toBe(true);
    expect(gate.consume(event, 'approval')).toMatchObject({
      pickerKind: 'approval',
      intent: 'allow-once-bound',
    });
    gate.dispose();
  });
});
