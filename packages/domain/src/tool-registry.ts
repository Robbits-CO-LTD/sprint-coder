import { createHash } from 'node:crypto';
import { capabilities, type Capability } from './permission';

export const toolKinds = [
  'fileRead',
  'fileWrite',
  'search',
  'shell',
  'network',
  'backgroundTask',
  'agentControl',
] as const;
const toolSideEffects = ['none', 'read', 'write', 'process', 'network', 'control'] as const;
const toolRisks = ['low', 'medium', 'high'] as const;
const toolExecutionTargets = ['main', 'utility', 'command-runner', 'mcp-gateway'] as const;
const toolImplementationKinds = ['built-in', 'command-runner', 'mcp-gateway'] as const;
export type ToolKind = (typeof toolKinds)[number];
export type ToolSideEffect = (typeof toolSideEffects)[number];
export type ToolRisk = (typeof toolRisks)[number];
export type ToolExecutionTarget = (typeof toolExecutionTargets)[number];
export type ToolImplementationKind = (typeof toolImplementationKinds)[number];
export type WorkspaceBinding =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'any' }>
  | Readonly<{ kind: 'exact'; workspaceId: string }>;
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

declare const toolIdBrand: unique symbol;
export type ToolId = string & { readonly [toolIdBrand]: true };
export type ToolIdParts = {
  provider: string;
  namespace: string;
  name: string;
  version: string;
};

export type ToolDefinitionInput = {
  toolId: ToolId;
  providerName: string;
  kind: ToolKind;
  schemaVersion: number;
  inputSchema: JsonValue;
  outputSchema: JsonValue;
  sideEffect: ToolSideEffect;
  risk: ToolRisk;
  requiredCapabilities: readonly Capability[];
  executionTarget: ToolExecutionTarget;
  implementationKind: ToolImplementationKind;
  priority: number;
  workspaceBinding: WorkspaceBinding;
  providerCompatibility: readonly string[];
  description?: string;
  parallelism?: 'parallel' | 'serial';
  maxOutputBytes?: number;
  supportsCancellation?: boolean;
  supportsBackground?: boolean;
};

export type ToolDefinition = Readonly<
  Omit<
    ToolDefinitionInput,
    'description' | 'parallelism' | 'maxOutputBytes' | 'supportsCancellation' | 'supportsBackground'
  > & {
    version: string;
    description: string;
    parallelism: 'parallel' | 'serial';
    maxOutputBytes: number;
    supportsCancellation: boolean;
    supportsBackground: boolean;
    inputSchemaDigest: string;
    outputSchemaDigest: string;
    schemaDigest: string;
  }
>;

export type ToolCatalogEntry = Readonly<{
  providerName: string;
  toolId: ToolId;
  version: string;
  kind: ToolKind;
  schemaVersion: number;
  inputSchema: JsonValue;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  schemaDigest: string;
  sideEffect: ToolSideEffect;
  risk: ToolRisk;
  requiredCapabilities: readonly Capability[];
  executionTarget: ToolExecutionTarget;
  implementationKind: ToolImplementationKind;
  description: string;
  parallelism: 'parallel' | 'serial';
  maxOutputBytes: number;
  supportsCancellation: boolean;
  supportsBackground: boolean;
}>;

export type ToolCatalogSnapshot = Readonly<{
  revision: number;
  providerId: string;
  workspaceId: string | null;
  entries: readonly ToolCatalogEntry[];
  digest: string;
}>;

export type ToolExecutionContext = Readonly<{
  taskId: string;
  turnId: string;
  workspaceId: string | null;
  policyEpoch: number;
}>;

export type ToolExecutionControl = Readonly<{
  callId: string;
  signal?: AbortSignal;
  authorizationDecision?: string;
}>;

export type ToolImplementation = Readonly<{
  toolId: ToolId;
  implementationKind: ToolImplementationKind;
  prepare?: (
    input: unknown,
    context: ToolExecutionContext,
    control: Readonly<{ callId: string }>,
  ) => Promise<unknown> | unknown;
  authorizationDenied?: (input: unknown, context: ToolExecutionContext) => Promise<void> | void;
  execute: (
    input: unknown,
    context: ToolExecutionContext,
    control: ToolExecutionControl,
  ) => Promise<unknown> | unknown;
  dispose?: () => void | Promise<void>;
}>;

/** Reserved extension point. MCP sources are intentionally not connected before Public Beta. */
export interface McpToolRegistrySource {
  listDefinitions(): Promise<readonly ToolDefinition[]>;
}

const TOOL_ID_COMPONENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOOL_VERSION = /^[0-9][a-zA-Z0-9._-]{0,31}$/;
const PROVIDER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function createToolId(parts: ToolIdParts): ToolId {
  validateToolIdParts(parts);
  return `${parts.provider}:${parts.namespace}:${parts.name}@${parts.version}` as ToolId;
}

export function parseToolId(value: string): ToolIdParts {
  const match = /^([^:]+):([^:]+):([^@]+)@([^@]+)$/.exec(value);
  if (match === null) throw new Error('Invalid ToolId: expected provider:namespace:name@version');
  const parts = {
    provider: match[1]!,
    namespace: match[2]!,
    name: match[3]!,
    version: match[4]!,
  };
  validateToolIdParts(parts);
  if (createToolId(parts) !== value) throw new Error('Invalid ToolId: non-canonical form');
  return parts;
}

export function createToolDefinition(input: ToolDefinitionInput): ToolDefinition {
  const id = parseToolId(input.toolId);
  if (!PROVIDER_NAME.test(input.providerName)) throw new Error('Invalid provider tool name');
  if (!toolKinds.includes(input.kind)) throw new Error('Invalid ToolKind');
  if (!toolSideEffects.includes(input.sideEffect)) throw new Error('Invalid tool side effect');
  if (!toolRisks.includes(input.risk)) throw new Error('Invalid tool risk');
  if (!toolExecutionTargets.includes(input.executionTarget))
    throw new Error('Invalid tool execution target');
  if (!toolImplementationKinds.includes(input.implementationKind))
    throw new Error('Invalid tool implementation kind');
  if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1)
    throw new Error('Invalid tool schema version');
  if (!Number.isInteger(input.priority)) throw new Error('Invalid tool priority');
  if (
    input.description !== undefined &&
    (input.description.trim().length === 0 || input.description.length > 2_000)
  )
    throw new Error('Invalid tool description');
  if (input.parallelism !== undefined && !['parallel', 'serial'].includes(input.parallelism))
    throw new Error('Invalid tool parallelism');
  if (
    input.maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1)
  )
    throw new Error('Invalid tool output limit');
  if (
    input.providerCompatibility.length === 0 ||
    new Set(input.providerCompatibility).size !== input.providerCompatibility.length ||
    input.providerCompatibility.some(
      (provider) => provider !== '*' && !TOOL_ID_COMPONENT.test(provider),
    )
  )
    throw new Error('Invalid provider compatibility');
  if (
    new Set(input.requiredCapabilities).size !== input.requiredCapabilities.length ||
    input.requiredCapabilities.some((capability) => !capabilities.includes(capability))
  )
    throw new Error('Invalid required capabilities');
  validateAuthorityMetadata(input);
  validateWorkspaceBinding(input.workspaceBinding);
  assertSerializableJson(input.inputSchema, 'input schema');
  assertSerializableJson(input.outputSchema, 'output schema');
  validateSupportedSchema(input.inputSchema, 'input schema');
  validateSupportedSchema(input.outputSchema, 'output schema');
  validateImplementationMetadata(input);

  const inputSchema = cloneJson(input.inputSchema);
  const outputSchema = cloneJson(input.outputSchema);
  const inputSchemaDigest = digestToolCatalogValue(inputSchema);
  const outputSchemaDigest = digestToolCatalogValue(outputSchema);
  const description = input.description?.trim() || input.providerName;
  const parallelism =
    input.parallelism ??
    (input.sideEffect === 'none' || input.sideEffect === 'read' ? 'parallel' : 'serial');
  const maxOutputBytes = input.maxOutputBytes ?? 1024 * 1024;
  const supportsCancellation = input.supportsCancellation ?? input.kind === 'shell';
  const supportsBackground = input.supportsBackground ?? input.kind === 'backgroundTask';
  return deepFreeze({
    ...input,
    description,
    parallelism,
    maxOutputBytes,
    supportsCancellation,
    supportsBackground,
    version: id.version,
    inputSchema,
    outputSchema,
    requiredCapabilities: [...input.requiredCapabilities],
    providerCompatibility: [...input.providerCompatibility],
    workspaceBinding: { ...input.workspaceBinding },
    inputSchemaDigest,
    outputSchemaDigest,
    schemaDigest: digestToolCatalogValue({
      schemaVersion: input.schemaVersion,
      inputSchemaDigest,
      outputSchemaDigest,
    }),
  });
}

export function toolValueMatchesSchema(schema: JsonValue, value: unknown): boolean {
  if (!isPlainJsonValue(value)) return false;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  const record = schema as Record<string, JsonValue>;
  const enumValues = record['enum'];
  if (
    Array.isArray(enumValues) &&
    !enumValues.some((candidate) => stableStringify(candidate) === stableStringify(value))
  )
    return false;
  if (record['const'] !== undefined && stableStringify(record['const']) !== stableStringify(value))
    return false;
  const allOf = record['allOf'];
  if (Array.isArray(allOf) && !allOf.every((entry) => toolValueMatchesSchema(entry, value)))
    return false;
  const condition = record['if'];
  if (
    condition !== undefined &&
    toolValueMatchesSchema(condition, value) &&
    record['then'] !== undefined &&
    !toolValueMatchesSchema(record['then'], value)
  )
    return false;
  if (record['not'] !== undefined && toolValueMatchesSchema(record['not'], value)) return false;

  const type = record['type'];
  if (type === undefined) {
    if (record['minimum'] !== undefined || record['maximum'] !== undefined) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (typeof record['minimum'] === 'number' && value < record['minimum']) return false;
      if (typeof record['maximum'] === 'number' && value > record['maximum']) return false;
    }
    if (record['properties'] === undefined && record['required'] === undefined) return true;
  } else if (type === 'string') return typeof value === 'string';
  else if (type === 'number' || type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (type === 'integer' && !Number.isInteger(value))
    )
      return false;
    if (typeof record['minimum'] === 'number' && value < record['minimum']) return false;
    if (typeof record['maximum'] === 'number' && value > record['maximum']) return false;
    return true;
  } else if (type === 'boolean') return typeof value === 'boolean';
  else if (type === 'null') return value === null;
  if (type === 'array') {
    if (!Array.isArray(value)) return false;
    const items = record['items'];
    const minItems = record['minItems'];
    const maxItems = record['maxItems'];
    if (typeof minItems === 'number' && value.length < minItems) return false;
    if (typeof maxItems === 'number' && value.length > maxItems) return false;
    return items === undefined || value.every((item) => toolValueMatchesSchema(items, item));
  }
  if (
    type !== undefined &&
    type !== 'object' &&
    (record['properties'] !== undefined || record['required'] !== undefined)
  )
    return false;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  const properties = (record['properties'] ?? {}) as Record<string, JsonValue>;
  const required = (record['required'] ?? []) as readonly JsonValue[];
  if (!required.every((key) => typeof key === 'string' && Object.hasOwn(object, key))) return false;
  if (record['additionalProperties'] === false) {
    const allowed = new Set(Object.keys(properties));
    if (Object.keys(object).some((key) => !allowed.has(key))) return false;
  }
  return Object.entries(properties).every(
    ([key, propertySchema]) =>
      !Object.hasOwn(object, key) || toolValueMatchesSchema(propertySchema, object[key]),
  );
}

export class ToolRegistry {
  private readonly definitions = new Map<ToolId, ToolDefinition>();
  private revision = 0;

  register(definition: ToolDefinition): void {
    const validated = createToolDefinition(definition);
    if (this.definitions.has(validated.toolId))
      throw new Error(`Duplicate ToolId: ${validated.toolId}`);
    this.definitions.set(validated.toolId, validated);
    this.revision += 1;
  }

  get(toolId: ToolId): ToolDefinition | undefined {
    return this.definitions.get(toolId);
  }

  getByKind(kind: ToolKind): readonly ToolDefinition[] {
    return Object.freeze(
      [...this.definitions.values()]
        .filter((definition) => definition.kind === kind)
        .sort((left, right) => left.toolId.localeCompare(right.toolId)),
    );
  }

  createSnapshot(input: {
    providerId: string;
    workspaceId: string | null;
    availableToolIds?: readonly ToolId[];
  }): ToolCatalogSnapshot {
    if (!TOOL_ID_COMPONENT.test(input.providerId)) throw new Error('Invalid provider id');
    const available =
      input.availableToolIds === undefined ? null : new Set<ToolId>(input.availableToolIds);
    const eligible = [...this.definitions.values()].filter(
      (definition) =>
        (available === null || available.has(definition.toolId)) &&
        (definition.providerCompatibility.includes('*') ||
          definition.providerCompatibility.includes(input.providerId)) &&
        (definition.workspaceBinding.kind === 'none' ||
          (definition.workspaceBinding.kind === 'any' && input.workspaceId !== null) ||
          (definition.workspaceBinding.kind === 'exact' &&
            definition.workspaceBinding.workspaceId === input.workspaceId)),
    );
    const byProviderName = new Map<string, ToolDefinition[]>();
    for (const definition of eligible) {
      const candidates = byProviderName.get(definition.providerName) ?? [];
      candidates.push(definition);
      byProviderName.set(definition.providerName, candidates);
    }
    const selected: ToolDefinition[] = [];
    for (const [providerName, candidates] of byProviderName) {
      candidates.sort(
        (left, right) => right.priority - left.priority || left.toolId.localeCompare(right.toolId),
      );
      if (candidates.length > 1 && candidates[0]!.priority === candidates[1]!.priority)
        throw new Error(`Ambiguous provider tool name: ${providerName}`);
      selected.push(candidates[0]!);
    }
    const entries = selected
      .sort((left, right) => left.providerName.localeCompare(right.providerName))
      .map(toCatalogEntry);
    const snapshotFacts = {
      revision: this.revision,
      providerId: input.providerId,
      workspaceId: input.workspaceId,
      entries,
    };
    return deepFreeze({ ...snapshotFacts, digest: digestToolCatalogValue(snapshotFacts) });
  }
}

export function verifyToolCatalogSnapshot(snapshot: ToolCatalogSnapshot): boolean {
  try {
    if (
      !TOOL_ID_COMPONENT.test(snapshot.providerId) ||
      !Number.isInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      (snapshot.workspaceId !== null && snapshot.workspaceId.length === 0)
    )
      return false;
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const entry of snapshot.entries) {
      const parts = parseToolId(entry.toolId);
      if (
        !toolKinds.includes(entry.kind) ||
        !toolSideEffects.includes(entry.sideEffect) ||
        !toolRisks.includes(entry.risk) ||
        !toolExecutionTargets.includes(entry.executionTarget) ||
        !toolImplementationKinds.includes(entry.implementationKind) ||
        !Number.isInteger(entry.schemaVersion) ||
        entry.schemaVersion < 1 ||
        !TOOL_VERSION.test(entry.version) ||
        !DIGEST.test(entry.inputSchemaDigest) ||
        !DIGEST.test(entry.outputSchemaDigest) ||
        !DIGEST.test(entry.schemaDigest) ||
        entry.description.length < 1 ||
        entry.description.length > 2_000 ||
        !['parallel', 'serial'].includes(entry.parallelism) ||
        !Number.isSafeInteger(entry.maxOutputBytes) ||
        entry.maxOutputBytes < 1 ||
        typeof entry.supportsCancellation !== 'boolean' ||
        typeof entry.supportsBackground !== 'boolean' ||
        new Set(entry.requiredCapabilities).size !== entry.requiredCapabilities.length ||
        entry.requiredCapabilities.some((capability) => !capabilities.includes(capability))
      )
        return false;
      validateAuthorityMetadata(entry);
      validateImplementationMetadata(entry);
      if (
        parts.version !== entry.version ||
        !PROVIDER_NAME.test(entry.providerName) ||
        names.has(entry.providerName) ||
        ids.has(entry.toolId) ||
        digestToolCatalogValue(entry.inputSchema) !== entry.inputSchemaDigest ||
        digestToolCatalogValue({
          schemaVersion: entry.schemaVersion,
          inputSchemaDigest: entry.inputSchemaDigest,
          outputSchemaDigest: entry.outputSchemaDigest,
        }) !== entry.schemaDigest
      )
        return false;
      validateSupportedSchema(entry.inputSchema, 'input schema');
      names.add(entry.providerName);
      ids.add(entry.toolId);
    }
    return (
      digestToolCatalogValue({
        revision: snapshot.revision,
        providerId: snapshot.providerId,
        workspaceId: snapshot.workspaceId,
        entries: snapshot.entries,
      }) === snapshot.digest
    );
  } catch {
    return false;
  }
}

function toCatalogEntry(definition: ToolDefinition): ToolCatalogEntry {
  return deepFreeze({
    providerName: definition.providerName,
    toolId: definition.toolId,
    version: definition.version,
    kind: definition.kind,
    schemaVersion: definition.schemaVersion,
    inputSchema: cloneJson(definition.inputSchema),
    inputSchemaDigest: definition.inputSchemaDigest,
    outputSchemaDigest: definition.outputSchemaDigest,
    schemaDigest: definition.schemaDigest,
    sideEffect: definition.sideEffect,
    risk: definition.risk,
    requiredCapabilities: [...definition.requiredCapabilities],
    executionTarget: definition.executionTarget,
    implementationKind: definition.implementationKind,
    description: definition.description,
    parallelism: definition.parallelism,
    maxOutputBytes: definition.maxOutputBytes,
    supportsCancellation: definition.supportsCancellation,
    supportsBackground: definition.supportsBackground,
  });
}

function validateToolIdParts(parts: ToolIdParts): void {
  if (
    !TOOL_ID_COMPONENT.test(parts.provider) ||
    !TOOL_ID_COMPONENT.test(parts.namespace) ||
    !TOOL_ID_COMPONENT.test(parts.name) ||
    !TOOL_VERSION.test(parts.version)
  )
    throw new Error('Invalid ToolId component');
}

function validateWorkspaceBinding(binding: WorkspaceBinding): void {
  if (
    binding.kind !== 'none' &&
    binding.kind !== 'any' &&
    (binding.kind !== 'exact' || binding.workspaceId.length === 0)
  )
    throw new Error('Invalid workspace binding');
}

function validateAuthorityMetadata(
  input: Pick<ToolDefinitionInput, 'sideEffect' | 'requiredCapabilities' | 'kind'>,
): void {
  if (input.sideEffect !== 'none' && input.requiredCapabilities.length === 0)
    throw new Error('Side-effecting tools require a capability');
  const required = new Set(input.requiredCapabilities);
  const matchesKind =
    input.kind === 'fileRead'
      ? input.sideEffect === 'read' &&
        (required.has('workspace.read') || required.has('filesystem.external.read'))
      : input.kind === 'fileWrite'
        ? input.sideEffect === 'write' &&
          (required.has('workspace.write') || required.has('filesystem.external.write'))
        : input.kind === 'shell'
          ? input.sideEffect === 'process' && required.has('shell.execute')
          : input.kind === 'network'
            ? input.sideEffect === 'network' &&
              (required.has('network.fetch') || required.has('provider.egress'))
            : input.kind === 'search'
              ? input.sideEffect === 'none' ||
                (input.sideEffect === 'read' &&
                  (required.has('workspace.read') || required.has('filesystem.external.read')))
              : input.kind === 'backgroundTask' || input.kind === 'agentControl'
                ? input.sideEffect === 'control' && input.requiredCapabilities.length > 0
                : false;
  if (!matchesKind) throw new Error('ToolKind, side effect, and capability are inconsistent');
}

function validateImplementationMetadata(
  input: Pick<ToolDefinitionInput, 'implementationKind' | 'executionTarget'>,
): void {
  if (
    (input.implementationKind === 'command-runner' && input.executionTarget !== 'command-runner') ||
    (input.implementationKind === 'mcp-gateway' && input.executionTarget !== 'mcp-gateway') ||
    (input.implementationKind === 'built-in' &&
      input.executionTarget !== 'main' &&
      input.executionTarget !== 'utility')
  )
    throw new Error('Tool implementation kind does not match execution target');
}

function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function isPlainJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return true;
  if (Array.isArray(value)) return value.every((item) => isPlainJsonValue(item, depth + 1));
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((item) => isPlainJsonValue(item, depth + 1))
  );
}

function assertSerializableJson(value: unknown, label: string): asserts value is JsonValue {
  const seen = new Set<object>();
  const visit = (candidate: unknown): boolean => {
    if (
      candidate === null ||
      typeof candidate === 'string' ||
      typeof candidate === 'boolean' ||
      (typeof candidate === 'number' && Number.isFinite(candidate))
    )
      return true;
    if (typeof candidate !== 'object') return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.every(visit);
    const prototype = Object.getPrototypeOf(candidate);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.keys(candidate).every((key) => visit((candidate as Record<string, unknown>)[key]))
    );
  };
  if (!visit(value)) throw new Error(`Invalid ${label}`);
}

function validateSupportedSchema(schema: JsonValue, label: string): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema))
    throw new Error(`Invalid ${label}: schema must be an object`);
  const record = schema as Record<string, JsonValue>;
  const allowedKeys = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'minItems',
    'maxItems',
    'enum',
    'const',
    'minimum',
    'maximum',
    'allOf',
    'if',
    'then',
    'not',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key)))
    throw new Error(`Invalid ${label}: unsupported schema keyword`);
  if (
    record['type'] !== undefined &&
    !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(
      String(record['type']),
    )
  )
    throw new Error(`Invalid ${label}: unsupported schema type`);
  if (record['enum'] !== undefined && (!Array.isArray(record['enum']) || record['enum'].length < 1))
    throw new Error(`Invalid ${label}: malformed enum`);
  for (const keyword of ['minimum', 'maximum'] as const)
    if (
      record[keyword] !== undefined &&
      (typeof record[keyword] !== 'number' || !Number.isFinite(record[keyword]))
    )
      throw new Error(`Invalid ${label}: malformed numeric bound`);
  if (
    record['minimum'] !== undefined &&
    record['maximum'] !== undefined &&
    Number(record['minimum']) > Number(record['maximum'])
  )
    throw new Error(`Invalid ${label}: minimum exceeds maximum`);
  if (
    record['type'] === 'object' ||
    record['properties'] !== undefined ||
    record['required'] !== undefined
  ) {
    const properties = record['properties'] ?? {};
    const required = record['required'] ?? [];
    if (
      typeof properties !== 'object' ||
      properties === null ||
      Array.isArray(properties) ||
      !Array.isArray(required) ||
      required.some((key) => typeof key !== 'string') ||
      (record['additionalProperties'] !== undefined &&
        typeof record['additionalProperties'] !== 'boolean')
    )
      throw new Error(`Invalid ${label}: malformed object schema`);
    for (const nested of Object.values(properties)) validateSupportedSchema(nested, label);
    if (
      record['properties'] !== undefined &&
      (required as readonly string[]).some((key) => !Object.hasOwn(properties, key))
    )
      throw new Error(`Invalid ${label}: required property has no schema`);
  }
  if (record['type'] === 'array') {
    const minItems = record['minItems'];
    const maxItems = record['maxItems'];
    if (record['items'] === undefined)
      throw new Error(`Invalid ${label}: array items are required`);
    if (
      [minItems, maxItems].some(
        (bound) =>
          bound !== undefined &&
          (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 0),
      ) ||
      (typeof minItems === 'number' && typeof maxItems === 'number' && minItems > maxItems)
    )
      throw new Error(`Invalid ${label}: malformed array schema`);
    validateSupportedSchema(record['items'], label);
  } else if (record['minItems'] !== undefined || record['maxItems'] !== undefined) {
    throw new Error(`Invalid ${label}: item bounds require an array schema`);
  }
  if (record['allOf'] !== undefined) {
    if (!Array.isArray(record['allOf']) || record['allOf'].length < 1)
      throw new Error(`Invalid ${label}: malformed allOf`);
    for (const nested of record['allOf']) validateSupportedSchema(nested, label);
  }
  for (const keyword of ['if', 'then', 'not'] as const)
    if (record[keyword] !== undefined) validateSupportedSchema(record[keyword], label);
  if (record['then'] !== undefined && record['if'] === undefined)
    throw new Error(`Invalid ${label}: then requires if`);
}

export function digestToolCatalogValue(value: JsonValue): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key]!)}`)
    .join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
