// Source for the ephemeral MCP stdio server the Codex/Claude adapter hands the real Leader when
// SPRINT_CODER_LEADER_MCP=1 routes a team-intent turn through team-mcp-bridge.ts instead of the
// deterministic mock scenario (see ADR amendment + tasks/todo.md). This is exported as a plain
// string — never as a file checked into the repo tree the CLI could stumble on — and written to
// a fresh temp file by claude-adapter.ts at the start of every such turn, then deleted when the
// turn ends.
//
// Design constraints this file exists to satisfy:
//  - Self-contained CommonJS, zero npm dependencies (spawned via `process.execPath` +
//    `ELECTRON_RUN_AS_NODE=1` — Electron's own Node, not a system Node install).
//  - Hand-rolled JSON-RPC 2.0 over newline-delimited stdin/stdout. Verified directly against the
//    installed Claude and Codex CLIs: `initialize` / `notifications/initialized` / `tools/list` /
//    `tools/call` all round-trip correctly with one JSON object per line.
//  - Forwards every `tools/call` verbatim to team-mcp-bridge.ts over the unix socket named by
//    TEAM_BRIDGE_SOCKET, authenticating with TEAM_BRIDGE_TOKEN. It never talks to
//    TeamCoordinator/persistence directly and holds no taskId of its own — the bridge is the only
//    thing that knows which Task/turn this socket connection belongs to.
export const TEAM_MCP_SERVER_SOURCE = `'use strict';
const net = require('net');

const SOCKET_PATH = process.env.TEAM_BRIDGE_SOCKET;
const TOKEN = process.env.TEAM_BRIDGE_TOKEN;

const TOOLS = [
  {
    name: 'team_hire_worker',
    description:
      'Hire a new team Worker with a role and objective you choose based on the user request. Hire only as many Workers as the task genuinely needs.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Short role label you choose based on the request, e.g. researcher/implementer/reviewer or anything else fitting -- in the same language as the request.' },
        objective: { type: 'string', description: 'What this Worker should accomplish.' },
        contextInheritancePolicy: {
          type: 'string',
          enum: ['none', 'summary', 'selected_items', 'full_fork'],
        },
        writeCapable: { type: 'boolean' },
        modelSelection: {
          type: 'object',
          properties: {
            connectionId: { type: ['string', 'null'] },
            requestedProvider: { type: ['string', 'null'] },
            requestedModel: { type: ['string', 'null'] },
          },
          required: ['connectionId', 'requestedProvider', 'requestedModel'],
          additionalProperties: false,
        },
        managerPolicy: {
          type: 'object',
          properties: {
            maxDirectChildren: { type: 'integer', minimum: 1 },
            maxDelegationDepth: { type: 'integer', minimum: 1, maximum: 4 },
            allowManagerChildren: { type: 'boolean' },
          },
          required: ['maxDelegationDepth', 'allowManagerChildren'],
          additionalProperties: false,
        },
      },
      required: ['role', 'objective'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_assign_task',
    description: 'Assign a formal task with explicit completion criteria. Returns an execution ID immediately; queued is not a failure.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string' },
        objective: { type: 'string' },
        doneCriteria: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
      },
      required: ['workerId', 'objective', 'doneCriteria'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_steer_execution',
    description: 'Replace the instruction of a queued or running execution while preserving its execution ID and attempt history.',
    inputSchema: {
      type: 'object',
      properties: {
        executionId: { type: 'string' },
        instruction: { type: 'string' },
      },
      required: ['executionId', 'instruction'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_cancel_execution',
    description: 'Cancel a queued or running execution by its execution ID.',
    inputSchema: {
      type: 'object',
      properties: { executionId: { type: 'string' } },
      required: ['executionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_get_status',
    description: 'Get the current Team, Worker, message, delivery, and budget snapshot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'team_wait_events',
    description: 'Wait for new terminal Worker reports after an optional sequence cursor.',
    inputSchema: {
      type: 'object',
      properties: { cursor: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
  },
  {
    name: 'team_send_to_worker',
    description: 'Send a concrete task/instruction to an already-hired Worker.',
    inputSchema: {
      type: 'object',
      properties: { workerId: { type: 'string' }, content: { type: 'string' } },
      required: ['workerId', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_wait_reports',
    description:
      'Wait for and collect new reports from dispatched Workers (waits up to 60 seconds for at least one). Call again if you are still waiting on more Workers to report.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'team_stop_worker',
    description: 'Stop a Worker.',
    inputSchema: {
      type: 'object',
      properties: { workerId: { type: 'string' } },
      required: ['workerId'],
      additionalProperties: false,
    },
  },
];

let socket = null;
let socketReady = null;
const pending = [];
let sockBuffer = '';

function handleSocketData(chunk) {
  sockBuffer += chunk.toString('utf8');
  let idx;
  while ((idx = sockBuffer.indexOf('\\n')) >= 0) {
    const line = sockBuffer.slice(0, idx);
    sockBuffer = sockBuffer.slice(idx + 1);
    if (!line.trim()) continue;
    const waiter = pending.shift();
    if (!waiter) continue;
    try {
      waiter.resolve(JSON.parse(line));
    } catch (error) {
      waiter.reject(error);
    }
  }
}

function rejectPending(error) {
  while (pending.length > 0) pending.shift().reject(error);
}

function connectSocket() {
  if (socketReady) return socketReady;
  socketReady = new Promise((resolve, reject) => {
    const s = net.createConnection(SOCKET_PATH);
    s.on('data', handleSocketData);
    s.once('connect', () => {
      pending.push({
        resolve: (response) => {
          if (!response || response.ok !== true) {
            reject(new Error('team bridge authentication failed'));
            return;
          }
          resolve(s);
        },
        reject: reject,
      });
      s.write(JSON.stringify({ token: TOKEN, tool: '__authenticate__', args: {} }) + '\\n');
    });
    s.on('error', (error) => {
      reject(error);
      rejectPending(error);
    });
    s.on('close', () => rejectPending(new Error('team bridge connection closed')));
    socket = s;
  });
  return socketReady;
}

function callBridge(tool, args) {
  return connectSocket().then(
    (sock) =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        sock.write(JSON.stringify({ token: TOKEN, tool: tool, args: args }) + '\\n');
      }),
  );
}

if (SOCKET_PATH && TOKEN) {
  connectSocket().catch(() => {});
}

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let idx;
  while ((idx = stdinBuffer.indexOf('\\n')) >= 0) {
    const line = stdinBuffer.slice(0, idx);
    stdinBuffer = stdinBuffer.slice(idx + 1);
    if (!line.trim()) continue;
    handleLine(line);
  }
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    return;
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: (message.params && message.params.protocolVersion) || '2024-11-05',
        serverInfo: { name: 'sprint-coder-team', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params && message.params.name;
    const args = (message.params && message.params.arguments) || {};
    if (!SOCKET_PATH || !TOKEN) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'team bridge is not configured' }], isError: true },
      });
      return;
    }
    callBridge(name, args)
      .then((response) => {
        if (response && response.ok) {
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: JSON.stringify(response.result) }] },
          });
        } else {
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [
                { type: 'text', text: JSON.stringify({ error: (response && response.error) || 'unknown error' }) },
              ],
              isError: true,
            },
          });
        }
      })
      .catch((error) => {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: String((error && error.message) || error) }], isError: true },
        });
      });
    return;
  }
  if (typeof message.id !== 'undefined') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found: ' + message.method } });
  }
}

process.stdin.resume();
`;
