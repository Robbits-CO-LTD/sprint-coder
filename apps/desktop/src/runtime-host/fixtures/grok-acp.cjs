'use strict';
// Synthetic ACP peer; never invokes a provider or touches a user Workspace.
const readline = require('node:readline');
const modelArg = process.argv.indexOf('--model');
// Without `--model` the adapter runs in auto mode; tests pass their scenario as the model id.
const mode = modelArg >= 0 ? process.argv[modelArg + 1] : 'auto';
const sessionId = 'grok-fixture-session';
// Like the real CLI, a new session starts on the default model whatever `--model` said.
let currentModel = 'grok-fixture';
const promptMeta = () =>
  mode === 'grok-no-prompt-meta'
    ? {}
    : { _meta: { modelId: mode === 'prompt-model-mismatch' ? 'grok-other' : currentModel } };
let tools = [];
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const update = (update, id = sessionId) =>
  send({ method: 'session/update', params: { sessionId: id, update } });
const mcpInventoryUpdate = () =>
  update({
    sessionUpdate: 'available_commands_update',
    _meta: {
      tools: [
        'search_tool',
        'use_tool',
        'team__search_tool',
        'team__use_tool',
        ...(mode === 'mcp-rogue-native' ? ['bash'] : []),
        ...(mode === 'mcp-rogue-alias' ? ['team__unregistered'] : []),
        ...(mode === 'mcp-rogue-server' ? ['rogue__use_tool'] : []),
      ],
    },
  });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  const reply = (result) => send({ id: request.id, result });
  if (request.method === 'initialize') {
    reply({
      protocolVersion: 1,
      authMethods: mode === 'no-auth' ? [] : [{ id: 'cached_token' }],
      _meta: {
        grokShell: true,
        modelState: { availableModels: [{ modelId: 'grok-fixture', name: 'Grok fixture' }] },
      },
    });
  } else if (request.method === 'authenticate') reply({});
  else if (request.method === 'session/new') {
    if (request.params._meta.agentProfile.tools.join(',') !== 'search_tool,use_tool')
      process.exit(5);
    tools = request.params.mcpServers.length ? ['search_tool', 'use_tool'] : [];
    update({
      sessionUpdate: 'available_commands_update',
      _meta: {
        tools:
          mode === 'rogue-tools'
            ? ['read_file', 'search_tool', 'use_tool']
            : ['search_tool', 'use_tool'],
      },
    });
    reply({ sessionId, models: { currentModelId: 'grok-fixture' } });
  } else if (request.method === 'session/set_model') {
    if (request.params.sessionId !== sessionId) process.exit(6);
    if (mode === 'auto' || mode === 'set-model-error') {
      send({ id: request.id, error: { code: -32603, message: 'set_model rejected' } });
      return;
    }
    if (mode === 'set-model-malformed') {
      reply({});
      return;
    }
    currentModel = mode === 'set-model-mismatch' ? 'grok-other' : request.params.modelId;
    reply({ _meta: { model: { Ok: currentModel } } });
  } else if (request.method === '_x.ai/mcp/list') {
    if (mode === 'mcp-ready-update') mcpInventoryUpdate();
    reply({
      result: {
        sessionMcpResolved: true,
        servers:
          mode === 'rogue-mcp'
            ? [{ name: 'rogue' }]
            : tools.length
              ? [
                  {
                    name: 'team',
                    session: {
                      enabled: true,
                      status: 'ready',
                      tools: tools.map((name) => ({ name })),
                    },
                  },
                ]
              : [],
      },
    });
  } else if (request.method === 'session/prompt') {
    if (mode === 'string-response') {
      update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Synthetic thought' },
      });
      send({ id: 'internal-reply', result: {} });
    }
    if (mode.startsWith('mcp-') && mode !== 'mcp-ready-update') mcpInventoryUpdate();
    if (mode === 'empty') {
      reply({ stopReason: 'end_turn' });
      return;
    }
    if (mode === 'hang') return;
    if (mode === 'malformed') {
      process.stdout.write('not-json\n');
      return;
    }
    if (mode === 'early-exit') {
      process.exit(0);
    }
    if (mode === 'rpc-error') {
      send({ id: request.id, error: { code: -32000, message: 'FAKE_SECRET_NOT_FOR_UI' } });
      return;
    }
    if (mode === 'rate-limit') {
      send({
        id: request.id,
        error: { code: -32603, message: '429 Rate limit exceeded FAKE_SECRET_NOT_FOR_UI' },
      });
      return;
    }
    update(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'こんにちは' } },
      mode === 'wrong-session' ? 'wrong' : sessionId,
    );
    if (mode === 'tool-wait') {
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', status: 'in_progress' });
      setTimeout(() => {
        update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        reply({ stopReason: 'end_turn', ...promptMeta() });
      }, 100);
      return;
    }
    reply({ stopReason: mode === 'max-tokens' ? 'max_tokens' : 'end_turn', ...promptMeta() });
  } else send({ id: request.id, error: { code: -32601, message: 'unknown' } });
});
