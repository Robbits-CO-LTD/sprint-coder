import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { TEAM_MCP_SERVER_SOURCE, TEAM_MCP_TOOL_NAMES } from './team-mcp-server-source';

// Exercises the exact script string the Claude adapter writes to disk and hands to the real
// Claude CLI as an MCP stdio server (see claude-adapter.ts). The JSON-RPC handshake shape asserted
// here (newline-delimited `initialize` -> `notifications/initialized` -> `tools/list` ->
// `tools/call`) was independently verified against the installed Claude CLI (v2.1.218) with a
// throwaway probe server; this test locks that same shape in as a regression guard without
// spawning the real CLI.

type Harness = {
  child: ChildProcessWithoutNullStreams;
  rl: Interface;
  fakeBridge: Server;
  directory: string;
  send(message: Record<string, unknown>): void;
  nextMessage(): Promise<Record<string, unknown>>;
  bridgeReceived: { token: unknown; tool: unknown; args: unknown }[];
  bridgeRespond(response: unknown): void;
};

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.child.kill();
    harness.rl.close();
    await new Promise<void>((resolve) => harness.fakeBridge.close(() => resolve()));
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

async function startHarness(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-team-mcp-test-'));
  const scriptPath = join(directory, 'team-mcp-server.cjs');
  writeFileSync(scriptPath, TEAM_MCP_SERVER_SOURCE, { mode: 0o600 });
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\sc-team-mcp-test-${randomBytes(6).toString('hex')}`
      : join(directory, 'bridge.sock');
  const token = 'test-bridge-token-0123456789';

  const bridgeReceived: { token: unknown; tool: unknown; args: unknown }[] = [];
  const bridgeResponders: ((response: unknown) => void)[] = [];
  const fakeBridge = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() === '') continue;
        const request = JSON.parse(line) as { token: unknown; tool: unknown; args: unknown };
        if (request.tool === '__authenticate__') {
          socket.write(`${JSON.stringify({ ok: true, result: { authenticated: true } })}\n`);
          continue;
        }
        bridgeReceived.push(request);
        bridgeResponders.push((response) => socket.write(`${JSON.stringify(response)}\n`));
      }
    });
  });
  await new Promise<void>((resolve) => fakeBridge.listen(socketPath, resolve));

  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, TEAM_BRIDGE_SOCKET: socketPath, TEAM_BRIDGE_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const rl = createInterface({ input: child.stdout });
  const inbox: Record<string, unknown>[] = [];
  const waiters: ((value: Record<string, unknown>) => void)[] = [];
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    const message = JSON.parse(line) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(message);
    else inbox.push(message);
  });

  const harness: Harness = {
    child,
    rl,
    fakeBridge,
    directory,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    nextMessage: () =>
      inbox.length > 0
        ? Promise.resolve(inbox.shift() as Record<string, unknown>)
        : new Promise((resolve) => waiters.push(resolve)),
    bridgeReceived,
    bridgeRespond: (response) => {
      const responder = bridgeResponders.shift();
      if (responder === undefined) throw new Error('no pending bridge request to respond to');
      responder(response);
    },
  };
  harnesses.push(harness);
  return harness;
}

describe('team-mcp-server-source (MCP stdio handshake)', () => {
  it('responds to initialize, ignores notifications/initialized, and lists the Team tools', async () => {
    const harness = await startHarness();
    harness.send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2099-01-01' },
    });
    const initReply = await harness.nextMessage();
    expect(initReply['id']).toBe(0);
    const result = initReply['result'] as {
      protocolVersion: string;
      capabilities: { tools: unknown };
    };
    // Echoes the client's requested protocol version back, matching what a real handshake needs.
    expect(result.protocolVersion).toBe('2099-01-01');
    expect(result.capabilities.tools).toEqual({});

    harness.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    harness.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const listReply = await harness.nextMessage();
    const tools = (
      listReply['result'] as {
        tools: { name: string; inputSchema: Record<string, unknown> }[];
      }
    ).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TEAM_MCP_TOOL_NAMES].sort());
    for (const tool of tools) expect(tool).toHaveProperty('inputSchema');
    const hireSchema = tools.find(({ name }) => name === 'team_hire_worker')?.inputSchema;
    const hireProperties = hireSchema?.['properties'] as Record<string, unknown>;
    expect(hireProperties['agentKind']).toMatchObject({
      type: 'string',
      enum: ['worker', 'manager'],
    });
    expect(hireProperties['managerPolicy']).toMatchObject({
      type: 'object',
      description: expect.stringContaining('number of additional levels'),
      required: ['maxDelegationLevels', 'allowManagerChildren'],
      additionalProperties: false,
    });
    expect(
      (hireProperties['managerPolicy'] as { properties: Record<string, unknown> }).properties,
    ).toHaveProperty('maxDelegationLevels');
    expect(
      (hireProperties['managerPolicy'] as { properties: Record<string, unknown> }).properties,
    ).not.toHaveProperty('maxDelegationDepth');
    expect(hireSchema?.['allOf']).toHaveLength(2);
    expect(hireSchema?.['required']).toEqual(
      expect.arrayContaining([
        'agentKind',
        'role',
        'objective',
        'modelSelection',
        'modelSelectionReason',
      ]),
    );
  });

  it('forwards tools/call to the bridge socket with the configured token and relays a success result', async () => {
    const harness = await startHarness();
    harness.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'team_hire_worker',
        arguments: { agentKind: 'worker', role: '調査', objective: '調べる' },
      },
    });
    await vi_waitFor(() => harness.bridgeReceived.length === 1);
    expect(harness.bridgeReceived[0]).toMatchObject({
      token: 'test-bridge-token-0123456789',
      tool: 'team_hire_worker',
      args: { agentKind: 'worker', role: '調査', objective: '調べる' },
    });
    harness.bridgeRespond({
      ok: true,
      result: { ok: true, workerId: 'w1', role: '調査', state: 'ready' },
    });

    const reply = await harness.nextMessage();
    expect(reply['id']).toBe(2);
    const content = (reply['result'] as { content: { type: string; text: string }[] }).content;
    expect(JSON.parse(content[0]?.text ?? '{}')).toMatchObject({ workerId: 'w1' });
    expect(reply['result']).not.toHaveProperty('isError', true);
  });

  it('marks the MCP result isError:true when the bridge reports a failure', async () => {
    const harness = await startHarness();
    harness.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'team_stop_worker', arguments: { workerId: 'missing' } },
    });
    await vi_waitFor(() => harness.bridgeReceived.length === 1);
    harness.bridgeRespond({ ok: false, error: 'Team not found' });

    const reply = await harness.nextMessage();
    const result = reply['result'] as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Team not found');
  });

  it('replies with a JSON-RPC error for an unrecognized method instead of hanging', async () => {
    const harness = await startHarness();
    harness.send({ jsonrpc: '2.0', id: 4, method: 'not/a/real/method' });
    const reply = await harness.nextMessage();
    expect(reply['id']).toBe(4);
    expect(reply).toHaveProperty('error');
  });
});

async function vi_waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
