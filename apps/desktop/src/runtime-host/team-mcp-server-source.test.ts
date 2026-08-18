import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { TEAM_MCP_SERVER_SOURCE, TEAM_MCP_TOOL_NAMES } from './team-mcp-server-source';
import { TEAM_HIRE_WORKER_TOOL } from '../main/team-tools';

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
  bridgeReceived: { requestId: unknown; token: unknown; tool: unknown; args: unknown }[];
  bridgeRespond(response: unknown, pendingIndex?: number): void;
  disconnectBridge(): void;
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

async function startHarness(
  options: {
    normalTimeoutMs?: number;
    longTimeoutMs?: number;
    capabilities?: {
      projectMemory: boolean;
      skillDrafts: boolean;
      skillImports: boolean;
      teamTools: boolean;
    };
    managedTools?: readonly { name: string; description: string; inputSchema: object }[];
  } = {},
): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-team-mcp-test-'));
  const scriptPath = join(directory, 'team-mcp-server.cjs');
  writeFileSync(scriptPath, TEAM_MCP_SERVER_SOURCE, { mode: 0o600 });
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\sc-team-mcp-test-${randomBytes(6).toString('hex')}`
      : join(directory, 'bridge.sock');
  const token = 'test-bridge-token-0123456789';

  const bridgeReceived: { requestId: unknown; token: unknown; tool: unknown; args: unknown }[] = [];
  const bridgeResponders: { requestId: unknown; respond(response: unknown): void }[] = [];
  const bridgeSockets = new Set<Socket>();
  const fakeBridge = createServer((socket) => {
    bridgeSockets.add(socket);
    socket.once('close', () => bridgeSockets.delete(socket));
    // Teardown kills the child before closing this fixture server. Linux can report the expected
    // peer reset asynchronously after the test has completed; consume only that socket-level
    // teardown event so Vitest does not misclassify a fully passing suite as an unhandled error.
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET') throw error;
    });
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() === '') continue;
        const request = JSON.parse(line) as {
          requestId: unknown;
          token: unknown;
          tool: unknown;
          args: unknown;
        };
        if (request.tool === '__authenticate__') {
          socket.write(
            `${JSON.stringify({
              requestId: request.requestId,
              ok: true,
              result: {
                authenticated: true,
                managedTools: options.managedTools ?? [],
                capabilities: options.capabilities ?? {
                  projectMemory: true,
                  skillDrafts: true,
                  skillImports: true,
                  teamTools: true,
                },
              },
            })}\n`,
          );
          continue;
        }
        bridgeReceived.push(request);
        bridgeResponders.push({
          requestId: request.requestId,
          respond: (response) =>
            socket.write(
              `${JSON.stringify({ ...(response as object), requestId: request.requestId })}\n`,
            ),
        });
      }
    });
  });
  await new Promise<void>((resolve) => fakeBridge.listen(socketPath, resolve));

  const child = spawn(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TEAM_BRIDGE_SOCKET: socketPath,
      TEAM_BRIDGE_TOKEN: token,
      ...(options.normalTimeoutMs === undefined
        ? {}
        : { TEAM_BRIDGE_TEST_NORMAL_TIMEOUT_MS: String(options.normalTimeoutMs) }),
      ...(options.longTimeoutMs === undefined
        ? {}
        : { TEAM_BRIDGE_TEST_LONG_TIMEOUT_MS: String(options.longTimeoutMs) }),
    },
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
    bridgeRespond: (response, pendingIndex = 0) => {
      const [responder] = bridgeResponders.splice(pendingIndex, 1);
      if (responder === undefined) throw new Error('no pending bridge request to respond to');
      responder.respond(response);
    },
    disconnectBridge: () => {
      for (const socket of bridgeSockets) socket.destroy();
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
    expect(JSON.stringify(hireSchema)).not.toMatch(/"(?:allOf|if|then|not)"/);
    expect(hireSchema?.['required']).toEqual(
      expect.arrayContaining([
        'agentKind',
        'role',
        'objective',
        'modelSelection',
        'modelSelectionReason',
      ]),
    );
    const providerSchema = TEAM_HIRE_WORKER_TOOL.inputSchema as Record<string, unknown>;
    const providerProperties = providerSchema['properties'] as Record<string, unknown>;
    expect({
      agentKind: stripDescriptions(hireProperties['agentKind']),
      managerPolicy: stripDescriptions(hireProperties['managerPolicy']),
      additionalProperties: hireSchema?.['additionalProperties'],
    }).toEqual({
      agentKind: stripDescriptions(providerProperties['agentKind']),
      managerPolicy: stripDescriptions(providerProperties['managerPolicy']),
      additionalProperties: providerSchema['additionalProperties'],
    });
    expect(hireSchema?.['required']).toEqual(
      expect.arrayContaining(providerSchema['required'] as string[]),
    );
    const missionSchema = tools.find(({ name }) => name === 'team_assign_mission')?.inputSchema;
    expect(missionSchema).toMatchObject({
      required: ['objective', 'doneCriteria', 'steps'],
      additionalProperties: false,
      properties: {
        objective: { minLength: 1, maxLength: 20_000 },
        doneCriteria: { minItems: 1, maxItems: 64 },
      },
    });
    const missionSteps = (missionSchema?.['properties'] as Record<string, unknown>)['steps'];
    expect(missionSteps).toMatchObject({ minItems: 2, maxItems: 12 });
    expect((missionSteps as { items: { required: string[] } }).items.required).toEqual([
      'workerId',
      'objective',
      'doneCriteria',
      'access',
    ]);
    expect(missionSteps).toMatchObject({
      items: {
        additionalProperties: false,
        properties: {
          workerId: { minLength: 1, maxLength: 128 },
          objective: { minLength: 1, maxLength: 10_000 },
          doneCriteria: { minItems: 1, maxItems: 20 },
          access: { enum: ['read-only', 'workspace-write'] },
        },
      },
    });
    expect(tools.find(({ name }) => name === 'team_resume_mission')?.inputSchema).toMatchObject({
      required: ['missionId'],
      additionalProperties: false,
    });
  });

  it('deduplicates a static capability when the same tool comes from the managed catalog', async () => {
    const harness = await startHarness({
      managedTools: [
        {
          name: 'project_memory_remember',
          description: 'managed memory',
          inputSchema: { type: 'object' },
        },
      ],
    });
    harness.send({ jsonrpc: '2.0', id: 31, method: 'tools/list' });
    const reply = await harness.nextMessage();
    const tools = (reply['result'] as { tools: { name: string; description: string }[] }).tools;
    expect(tools.filter(({ name }) => name === 'project_memory_remember')).toEqual([
      expect.objectContaining({ description: 'managed memory' }),
    ]);
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
      requestId: expect.any(String),
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

  it('relays a managed Workspace image as MCP image content', async () => {
    const harness = await startHarness();
    harness.send({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'view_image', arguments: { path: 'diagram.png' } },
    });
    await vi_waitFor(() => harness.bridgeReceived.length === 1);
    harness.bridgeRespond({
      ok: true,
      result: {
        path: 'diagram.png',
        mimeType: 'image/png',
        byteLength: 3,
        sha256: 'a'.repeat(64),
        dataUrl: 'data:image/png;base64,QUFB',
      },
    });
    const reply = await harness.nextMessage();
    expect((reply['result'] as { content: unknown[] }).content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          path: 'diagram.png',
          mimeType: 'image/png',
          byteLength: 3,
          sha256: 'a'.repeat(64),
        }),
      },
      { type: 'image', mimeType: 'image/png', data: 'QUFB' },
    ]);
  });

  it('lists only Project memory for a non-Team Project turn', async () => {
    const harness = await startHarness({
      capabilities: {
        projectMemory: true,
        skillDrafts: false,
        skillImports: false,
        teamTools: false,
      },
    });
    harness.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
    const listReply = await harness.nextMessage();
    const tools = (listReply['result'] as { tools: { name: string }[] }).tools;

    expect(tools.map(({ name }) => name)).toEqual(['project_memory_remember']);
    expect(tools.some(({ name }) => name.startsWith('team_'))).toBe(false);
  });

  it('matches reversed bridge responses to their request IDs', async () => {
    const harness = await startHarness();
    harness.send({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'team_read_messages', arguments: { afterSeq: 1 } },
    });
    harness.send({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'team_get_status', arguments: {} },
    });
    await vi_waitFor(() => harness.bridgeReceived.length === 2);
    expect(harness.bridgeReceived[0]?.requestId).not.toBe(harness.bridgeReceived[1]?.requestId);

    harness.bridgeRespond({ ok: true, result: { marker: 'second' } }, 1);
    harness.bridgeRespond({ ok: true, result: { marker: 'first' } }, 0);

    const replies = [await harness.nextMessage(), await harness.nextMessage()];
    const byId = new Map(replies.map((reply) => [reply['id'], reply]));
    const firstContent = (byId.get(20)?.['result'] as { content: { text: string }[] }).content;
    const secondContent = (byId.get(21)?.['result'] as { content: { text: string }[] }).content;
    expect(JSON.parse(firstContent[0]!.text)).toEqual({ marker: 'first' });
    expect(JSON.parse(secondContent[0]!.text)).toEqual({ marker: 'second' });
  });

  it('uses a longer timeout for wait and Mission tools than for ordinary requests', async () => {
    const harness = await startHarness({ normalTimeoutMs: 30, longTimeoutMs: 120 });
    harness.send({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'team_get_status', arguments: {} },
    });
    harness.send({
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'team_wait_reports', arguments: {} },
    });
    harness.send({
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: { name: 'team_assign_mission', arguments: {} },
    });
    harness.send({
      jsonrpc: '2.0',
      id: 25,
      method: 'tools/call',
      params: { name: 'team_resume_mission', arguments: { missionId: 'mission-1' } },
    });
    await vi_waitFor(() => harness.bridgeReceived.length === 4);

    expect((await harness.nextMessage())['id']).toBe(22);
    expect(
      new Set([
        (await harness.nextMessage())['id'],
        (await harness.nextMessage())['id'],
        (await harness.nextMessage())['id'],
      ]),
    ).toEqual(new Set([23, 24, 25]));
  });

  it('releases every pending request when the bridge disconnects', async () => {
    const harness = await startHarness();
    for (const id of [26, 27])
      harness.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'team_get_status', arguments: {} },
      });
    await vi_waitFor(() => harness.bridgeReceived.length === 2);
    harness.disconnectBridge();

    const replies = [await harness.nextMessage(), await harness.nextMessage()];
    expect(new Set(replies.map((reply) => reply['id']))).toEqual(new Set([26, 27]));
    for (const reply of replies) expect(reply['result']).toMatchObject({ isError: true });
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

function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description')
      .map(([key, nested]) => [key, stripDescriptions(nested)]),
  );
}

async function vi_waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
