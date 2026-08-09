// Source for the ephemeral MCP stdio server the Codex/Claude adapter hands the real Leader when
// Real CLI Team turns route through team-mcp-bridge.ts by default; SPRINT_CODER_LEADER_MCP=0 is
// the rollback switch. This is exported as a plain
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
export const TEAM_MCP_TOOL_NAMES = [
  'project_memory_remember',
  'skill_draft_create',
  'team_list_models',
  'team_record_model_research',
  'team_hire_worker',
  'team_assign_task',
  'team_steer_execution',
  'team_cancel_execution',
  'team_get_status',
  'team_wait_events',
  'team_send_to_worker',
  'team_send_message',
  'team_read_messages',
  'team_wait_reports',
  'team_stop_worker',
] as const;

export const TEAM_MCP_SERVER_SOURCE = `'use strict';
const net = require('net');

const SOCKET_PATH = process.env.TEAM_BRIDGE_SOCKET;
const TOKEN = process.env.TEAM_BRIDGE_TOKEN;

const TOOLS = [
  {
    name: 'project_memory_remember',
    description:
      'Queue one durable, self-contained Project memory candidate. It is committed only after this Turn completes successfully.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'skill_draft_create',
    description:
      'Create a validated, managed Skill Draft for user review. This never installs the Skill. Include SKILL.md and optional official package files; Team Skills must include team/blueprint.json.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['chat', 'team'] },
        skillId: {
          type: 'string',
          pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
          maxLength: 128,
        },
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 256,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', minLength: 1, maxLength: 500 },
              content: { type: 'string', maxLength: 1048576 },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['kind', 'skillId', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_list_models',
    description:
      'Search available Provider Connections and models before hiring. Capability values include their source; unknown must not be treated as false or inferred from names.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        connectionIds: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        providerIds: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        capabilities: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['toolCalling', 'structuredOutput', 'multimodalInput', 'reasoning'],
          },
          maxItems: 4,
        },
        cursor: { type: ['string', 'null'], pattern: '^cursor:[0-9]+$' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'team_record_model_research',
    description:
      'When model Web research is enabled, record source URLs and a factual summary for one exact catalog model after using live Web search and before hiring.',
    inputSchema: {
      type: 'object',
      properties: {
        modelSelection: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            requestedProvider: { type: 'string' },
            requestedModel: { type: 'string' },
          },
          required: ['connectionId', 'requestedProvider', 'requestedModel'],
          additionalProperties: false,
        },
        summary: { type: 'string', minLength: 1, maxLength: 2000 },
        sources: {
          type: 'array',
          items: { type: 'string', format: 'uri' },
          minItems: 1,
          maxItems: 8,
        },
      },
      required: ['modelSelection', 'summary', 'sources'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_hire_worker',
    description:
      'Hire one direct report. Use agentKind=worker without managerPolicy for a leaf. Use agentKind=manager with a relative maxDelegationLevels policy for a Manager.',
    inputSchema: {
      type: 'object',
      properties: {
        agentKind: {
          type: 'string',
          enum: ['worker', 'manager'],
          description:
            'worker creates a non-delegating leaf and forbids managerPolicy; manager requires managerPolicy.',
        },
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
        modelSelectionReason: {
          type: 'string',
          description: 'Why this source-backed available model fits this Worker. Do not infer capability from names.',
        },
        blueprintRoleKey: {
          type: 'string',
          description:
            'Required when a Team Skill Blueprint is active. Must exactly match one role key from the pinned Blueprint.',
        },
        managerPolicy: {
          type: 'object',
          description:
            'Required only for agentKind=manager. maxDelegationLevels is the number of additional levels the new Manager may create below itself.',
          properties: {
            maxDirectChildren: { type: 'integer', minimum: 1 },
            maxDelegationLevels: {
              type: 'integer',
              minimum: 1,
              maximum: 4,
              description:
                'Relative levels below the new Manager. Use 1 when the Manager only needs direct leaf children.',
            },
            allowManagerChildren: { type: 'boolean' },
          },
          required: ['maxDelegationLevels', 'allowManagerChildren'],
          additionalProperties: false,
        },
      },
      required: ['agentKind', 'role', 'objective', 'modelSelection', 'modelSelectionReason'],
      allOf: [
        {
          if: { properties: { agentKind: { const: 'manager' } } },
          then: { required: ['managerPolicy'] },
        },
        {
          if: { properties: { agentKind: { const: 'worker' } } },
          then: { not: { required: ['managerPolicy'] } },
        },
      ],
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
        access: { type: 'string', enum: ['read-only', 'workspace-write'] },
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
    description: 'Get the current authority-scoped Team snapshot. Manager and Worker callers cannot inspect sibling branches.',
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
    name: 'team_send_message',
    description:
      'Send an audited direct message to another Agent in the same Team. Worker-to-Worker delivery is controlled by Team Policy.',
    inputSchema: {
      type: 'object',
      properties: {
        targetAgentId: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['targetAgentId', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_read_messages',
    description:
      'Read messages addressed to this authenticated Agent after an optional sequence cursor.',
    inputSchema: {
      type: 'object',
      properties: { afterSeq: { type: 'integer', minimum: 0 } },
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
let availableTools = [];
const pending = new Map();
let sockBuffer = '';
let nextBridgeRequestId = 1;
const NORMAL_BRIDGE_TIMEOUT_MS =
  process.env.NODE_ENV === 'test' && process.env.TEAM_BRIDGE_TEST_NORMAL_TIMEOUT_MS
    ? Number(process.env.TEAM_BRIDGE_TEST_NORMAL_TIMEOUT_MS)
    : 15000;
const LONG_BRIDGE_TIMEOUT_MS =
  process.env.NODE_ENV === 'test' && process.env.TEAM_BRIDGE_TEST_LONG_TIMEOUT_MS
    ? Number(process.env.TEAM_BRIDGE_TEST_LONG_TIMEOUT_MS)
    : 70000;

function bridgeRequestId() {
  const id = String(process.pid) + '-' + String(nextBridgeRequestId);
  nextBridgeRequestId += 1;
  return id;
}

function handleSocketData(chunk) {
  sockBuffer += chunk.toString('utf8');
  let idx;
  while ((idx = sockBuffer.indexOf('\\n')) >= 0) {
    const line = sockBuffer.slice(0, idx);
    sockBuffer = sockBuffer.slice(idx + 1);
    if (!line.trim()) continue;
    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      rejectPending(error);
      continue;
    }
    const waiter =
      response && typeof response.requestId === 'string'
        ? pending.get(response.requestId)
        : undefined;
    if (!waiter) continue;
    pending.delete(response.requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(response);
  }
}

function rejectPending(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}

function writeBridgeRequest(sock, tool, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const requestId = bridgeRequestId();
    const timer = setTimeout(() => {
      if (!pending.delete(requestId)) return;
      reject(new Error('team bridge request timed out: ' + tool));
    }, timeoutMs);
    timer.unref();
    pending.set(requestId, { resolve, reject, timer });
    sock.write(
      JSON.stringify({ requestId: requestId, token: TOKEN, tool: tool, args: args }) + '\\n',
    );
  });
}

function connectSocket() {
  if (socketReady) return socketReady;
  socketReady = new Promise((resolve, reject) => {
    const s = net.createConnection(SOCKET_PATH);
    s.on('data', handleSocketData);
    s.once('connect', () => {
      writeBridgeRequest(s, '__authenticate__', {}, NORMAL_BRIDGE_TIMEOUT_MS).then(
        (response) => {
          if (!response || response.ok !== true) {
            reject(new Error('team bridge authentication failed'));
            return;
          }
          const capabilities = response.result && response.result.capabilities;
          availableTools = TOOLS.filter((tool) =>
            tool.name === 'project_memory_remember'
              ? capabilities && capabilities.projectMemory === true
              : tool.name === 'skill_draft_create'
                ? capabilities && capabilities.skillDrafts === true
                : capabilities && capabilities.teamTools === true,
          );
          resolve(s);
        },
        reject,
      );
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
      writeBridgeRequest(
        sock,
        tool,
        args,
        tool === 'team_wait_reports' || tool === 'team_wait_events'
          ? LONG_BRIDGE_TIMEOUT_MS
          : NORMAL_BRIDGE_TIMEOUT_MS,
      ),
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
    if (!SOCKET_PATH || !TOKEN) {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
      return;
    }
    connectSocket().then(
      () => send({ jsonrpc: '2.0', id: message.id, result: { tools: availableTools } }),
      () => send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }),
    );
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
