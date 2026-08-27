import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createToolDefinition,
  createToolId,
  parseToolId,
  toolValueMatchesSchema,
  verifyToolCatalogSnapshot,
  type ToolDefinitionInput,
} from './index';

const ECHO_INPUT = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
} as const;
const ECHO_OUTPUT = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
} as const;

function definition(
  override: Partial<ToolDefinitionInput> = {},
): ReturnType<typeof createToolDefinition> {
  return createToolDefinition({
    toolId: createToolId({ provider: 'builtin', namespace: 'test', name: 'echo', version: '1' }),
    providerName: 'test_echo',
    kind: 'search',
    schemaVersion: 1,
    inputSchema: ECHO_INPUT,
    outputSchema: ECHO_OUTPUT,
    sideEffect: 'none',
    risk: 'low',
    requiredCapabilities: [],
    executionTarget: 'main',
    implementationKind: 'built-in',
    priority: 10,
    workspaceBinding: { kind: 'none' },
    providerCompatibility: ['mock', 'codex'],
    ...override,
  });
}

describe('Tool Registry domain', () => {
  it('uses a stable four-part ToolId and rejects delimiter/path spoofing', () => {
    const toolId = createToolId({
      provider: 'builtin',
      namespace: 'workspace',
      name: 'read-file',
      version: '2.1.0',
    });
    expect(toolId).toBe('builtin:workspace:read-file@2.1.0');
    expect(parseToolId(toolId)).toEqual({
      provider: 'builtin',
      namespace: 'workspace',
      name: 'read-file',
      version: '2.1.0',
    });
    for (const invalid of ['../builtin:workspace:read@1', 'builtin::read@1', 'a:b:c@', 'A:b:c@1'])
      expect(() => parseToolId(invalid)).toThrow('Invalid ToolId');
  });

  it('deep-freezes definitions and derives schema digests instead of trusting callers', () => {
    const mutableSchema = structuredClone(ECHO_INPUT) as unknown as {
      type: string;
      properties: { text: { type: string } };
      required: string[];
      additionalProperties: boolean;
    };
    const tool = definition({ inputSchema: mutableSchema });
    mutableSchema.properties.text.type = 'number';

    expect(Object.isFrozen(tool)).toBe(true);
    expect(Object.isFrozen(tool.inputSchema)).toBe(true);
    expect(tool.inputSchema).toEqual(ECHO_INPUT);
    expect(tool.inputSchemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(tool.outputSchemaDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects every closed metadata enum at runtime even when TypeScript is bypassed', () => {
    for (const override of [
      { kind: 'root' },
      { sideEffect: 'root' },
      { risk: 'root' },
      { executionTarget: 'root' },
      { implementationKind: 'root' },
    ])
      expect(() => definition(override as Partial<ToolDefinitionInput>)).toThrow();
  });

  it('keeps ToolKind as classification and resolves provider names by priority and context', () => {
    const registry = new ToolRegistry();
    const generic = definition({
      toolId: createToolId({
        provider: 'builtin',
        namespace: 'generic',
        name: 'search',
        version: '1',
      }),
      providerName: 'search',
      kind: 'search',
      priority: 10,
    });
    const workspace = definition({
      toolId: createToolId({
        provider: 'builtin',
        namespace: 'workspace',
        name: 'search',
        version: '3',
      }),
      providerName: 'search',
      kind: 'search',
      priority: 20,
      workspaceBinding: { kind: 'exact', workspaceId: 'workspace-1' },
      providerCompatibility: ['codex'],
    });
    registry.register(generic);
    registry.register(workspace);

    expect(
      registry.createSnapshot({ providerId: 'mock', workspaceId: null }).entries[0]?.toolId,
    ).toBe(generic.toolId);
    expect(
      registry.createSnapshot({ providerId: 'codex', workspaceId: 'workspace-1' }).entries[0]
        ?.toolId,
    ).toBe(workspace.toolId);
    expect(
      registry.createSnapshot({ providerId: 'codex', workspaceId: 'workspace-2' }).entries[0]
        ?.toolId,
    ).toBe(generic.toolId);
    expect(registry.getByKind('search').map(({ toolId }) => toolId)).toEqual([
      generic.toolId,
      workspace.toolId,
    ]);
  });

  it('creates stable immutable Turn snapshots and applies registry changes only to later snapshots', () => {
    const registry = new ToolRegistry();
    const first = definition();
    registry.register(first);
    const turnOne = registry.createSnapshot({ providerId: 'mock', workspaceId: null });
    registry.register(
      definition({
        toolId: createToolId({
          provider: 'builtin',
          namespace: 'test',
          name: 'other',
          version: '1',
        }),
        providerName: 'test_other',
      }),
    );
    const turnTwo = registry.createSnapshot({ providerId: 'mock', workspaceId: null });

    expect(Object.isFrozen(turnOne)).toBe(true);
    expect(Object.isFrozen(turnOne.entries)).toBe(true);
    expect(Object.isFrozen(turnOne.entries[0])).toBe(true);
    expect(turnOne.entries.map(({ providerName }) => providerName)).toEqual(['test_echo']);
    expect(turnTwo.entries.map(({ providerName }) => providerName)).toEqual([
      'test_echo',
      'test_other',
    ]);
    expect(turnOne.revision).not.toBe(turnTwo.revision);
    expect(turnOne.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('cryptographically verifies ToolId versions, schemas, and complete snapshots', () => {
    const registry = new ToolRegistry();
    registry.register(definition());
    const snapshot = registry.createSnapshot({ providerId: 'mock', workspaceId: null });
    expect(verifyToolCatalogSnapshot(snapshot)).toBe(true);
    for (const changed of [
      {
        ...snapshot,
        digest: `${snapshot.digest[0] === '0' ? '1' : '0'}${snapshot.digest.slice(1)}`,
      },
      {
        ...snapshot,
        entries: [{ ...snapshot.entries[0]!, version: '2' }],
      },
      {
        ...snapshot,
        entries: [{ ...snapshot.entries[0]!, inputSchemaDigest: '0'.repeat(64) }],
      },
      {
        ...snapshot,
        entries: [{ ...snapshot.entries[0]!, schemaDigest: '0'.repeat(64) }],
      },
    ])
      expect(verifyToolCatalogSnapshot(changed)).toBe(false);
  });

  it('accepts only finite plain JSON values as tool input', () => {
    const schema = { type: 'object' } as const;
    expect(toolValueMatchesSchema(schema, {})).toBe(true);
    expect(toolValueMatchesSchema(schema, new Date())).toBe(false);
    expect(toolValueMatchesSchema(schema, new Map())).toBe(false);
    expect(toolValueMatchesSchema(schema, { value: Number.NaN })).toBe(false);
  });

  it('validates and enforces item bounds only for array schemas', () => {
    const schema = {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: { type: 'string' },
    } as const;
    expect(() => definition({ inputSchema: schema })).not.toThrow();
    expect(toolValueMatchesSchema(schema, [])).toBe(false);
    expect(toolValueMatchesSchema(schema, ['x'])).toBe(true);
    expect(toolValueMatchesSchema(schema, ['x', 'y', 'z'])).toBe(false);
    for (const inputSchema of [
      { type: 'array', minItems: -1, items: { type: 'string' } },
      { type: 'array', minItems: 1.5, items: { type: 'string' } },
      { type: 'array', maxItems: -1, items: { type: 'string' } },
      { type: 'array', minItems: 2, maxItems: 1, items: { type: 'string' } },
      { type: 'string', minItems: 1 },
      { type: 'string', maxItems: 1 },
    ])
      expect(() => definition({ inputSchema })).toThrow();
  });

  it('accepts bounded string metadata without treating it as the execution authority', () => {
    const schema = {
      type: 'string',
      pattern: '^[a-z][a-z0-9.-]*$',
      minLength: 1,
      maxLength: 128,
    } as const;
    expect(() => definition({ inputSchema: schema })).not.toThrow();
    expect(toolValueMatchesSchema(schema, 'valid-id')).toBe(true);
    expect(toolValueMatchesSchema(schema, '-server-validates-this')).toBe(true);
    for (const inputSchema of [
      { type: 'number', minLength: 1 },
      { type: 'string', minLength: -1 },
      { type: 'string', minLength: 2, maxLength: 1 },
      { type: 'string', pattern: '[' },
      { type: 'string', format: 'email' },
    ])
      expect(() => definition({ inputSchema })).toThrow();
  });

  it('validates discriminated contracts with conditional and numeric schema keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['leaf', 'manager'] },
        levels: { type: 'integer', minimum: 1, maximum: 4 },
      },
      required: ['kind'],
      additionalProperties: false,
      allOf: [
        {
          if: { properties: { kind: { const: 'manager' } } },
          then: { required: ['levels'] },
        },
        {
          if: { properties: { kind: { const: 'leaf' } } },
          then: { not: { required: ['levels'] } },
        },
      ],
    } as const;
    expect(() => definition({ inputSchema: schema })).not.toThrow();
    expect(toolValueMatchesSchema(schema, { kind: 'leaf' })).toBe(true);
    expect(toolValueMatchesSchema(schema, { kind: 'leaf', levels: 1 })).toBe(false);
    expect(toolValueMatchesSchema(schema, { kind: 'manager', levels: 1 })).toBe(true);
    expect(toolValueMatchesSchema(schema, { kind: 'manager' })).toBe(false);
    expect(toolValueMatchesSchema(schema, { kind: 'manager', levels: 0 })).toBe(false);
  });

  it('enforces numeric bounds even when a schema omits an explicit type', () => {
    const schema = {
      type: 'object',
      properties: { levels: { minimum: 1, maximum: 4 } },
      required: ['levels'],
    } as const;
    expect(() => definition({ inputSchema: schema })).not.toThrow();
    expect(toolValueMatchesSchema(schema, { levels: 2 })).toBe(true);
    expect(toolValueMatchesSchema(schema, { levels: 0 })).toBe(false);
    expect(toolValueMatchesSchema(schema, { levels: '2' })).toBe(false);
  });

  it('rejects duplicate ToolIds and ambiguous equal-priority provider names', () => {
    const duplicateRegistry = new ToolRegistry();
    const tool = definition();
    duplicateRegistry.register(tool);
    expect(() => duplicateRegistry.register(tool)).toThrow('Duplicate ToolId');

    const ambiguousRegistry = new ToolRegistry();
    ambiguousRegistry.register(tool);
    ambiguousRegistry.register(
      definition({
        toolId: createToolId({
          provider: 'builtin',
          namespace: 'other',
          name: 'echo',
          version: '1',
        }),
      }),
    );
    expect(() =>
      ambiguousRegistry.createSnapshot({ providerId: 'mock', workspaceId: null }),
    ).toThrow('Ambiguous provider tool name');
  });

  it('produces the same digest regardless of registration order and changes it for schema changes', () => {
    const first = definition();
    const second = definition({
      toolId: createToolId({ provider: 'builtin', namespace: 'test', name: 'other', version: '1' }),
      providerName: 'test_other',
    });
    const left = new ToolRegistry();
    left.register(first);
    left.register(second);
    const right = new ToolRegistry();
    right.register(second);
    right.register(first);
    expect(left.createSnapshot({ providerId: 'mock', workspaceId: null }).digest).toBe(
      right.createSnapshot({ providerId: 'mock', workspaceId: null }).digest,
    );

    const changed = new ToolRegistry();
    changed.register(
      definition({
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'number' } },
          required: ['text'],
          additionalProperties: false,
        },
      }),
    );
    changed.register(second);
    expect(changed.createSnapshot({ providerId: 'mock', workspaceId: null }).digest).not.toBe(
      left.createSnapshot({ providerId: 'mock', workspaceId: null }).digest,
    );
  });
});
