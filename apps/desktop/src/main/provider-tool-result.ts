import { redactSecrets } from './secret-redactor';
import { assessProviderDisclosure } from './provider-disclosure-classifier';
import { ToolAuthorizationDeniedError } from './tool-broker';
import { WorkspaceToolRejection } from './provider-workspace-tools';
import { WorkspacePatchRejection } from './workspace-patch-tool';
import { CommandRunnerError } from './command-runner';
import { ManagedStdinRejection } from './managed-command-stdin';
import { SkillSettingsError } from './skill-settings-service';
import { clipPublicMessage } from './zod-issue-message';
import { secureLogger } from './secure-logger';

export function formatProviderToolResult(
  providerId: string,
  toolName: string,
  result: unknown,
  knownWorkspaceRoots: readonly string[] = [],
): string {
  if (isOllamaCommand(providerId, toolName)) {
    const redacted = redactCommandOutput(result, knownWorkspaceRoots);
    const output = redactSecrets(JSON.stringify({ ok: true, result: redacted }));
    if (assessProviderDisclosure(output).classification === 'safe') return output;
    return redactSecrets(
      JSON.stringify({
        ok: true,
        result: redactCommandOutput(redacted, knownWorkspaceRoots, true),
      }),
    );
  }
  if (providerId === 'ollama' && toolName === 'read_file' && isFileReadResult(result)) {
    const { content, ...metadata } = result;
    // Gemma's native tool strings preserve escapes. Give it file text rather than a JSON
    // rendering it might copy literally into an edit; keep the Tool role and revision metadata.
    return redactSecrets(
      JSON.stringify({ ok: true, result: { ...metadata, contentFormat: 'verbatim_text_below' } }) +
        '\n\nUntrusted file content (verbatim except secret redaction):\n' +
        content,
    );
  }
  return redactSecrets(JSON.stringify({ ok: true, result }));
}

export function redactProviderCommandFailure(
  providerId: string,
  toolName: string,
  content: string,
  knownWorkspaceRoots: readonly string[] = [],
): string {
  if (!isOllamaCommand(providerId, toolName)) return content;
  let envelope: unknown;
  try {
    envelope = JSON.parse(content);
  } catch {
    return content;
  }
  if (
    !isRecord(envelope) ||
    !isRecord(envelope.error) ||
    typeof envelope.error.message !== 'string'
  )
    return content;
  const message = redactCommandText(envelope.error.message, knownWorkspaceRoots);
  const output = redactSecrets(
    JSON.stringify({ ...envelope, error: { ...envelope.error, message } }),
  );
  if (assessProviderDisclosure(output).classification === 'safe') return output;
  return redactSecrets(
    JSON.stringify({
      ...envelope,
      error: { ...envelope.error, message: '[REDACTED_COMMAND_OUTPUT]' },
      outputRedacted: true,
    }),
  );
}

/**
 * The Leader's conversion from a Workspace managed-tool failure to a tool error the model can act
 * on and go on from. Shared with the Managed Local Worker (issue #574), so a Worker's read denial,
 * rejected patch, or other Workspace tool failure is told to its model in the same words the Leader
 * uses, instead of ending the Worker's whole execution.
 */
export function providerWorkspaceToolFailure(error: unknown): string {
  if (error instanceof ToolAuthorizationDeniedError)
    return providerToolErrorContent('PERMISSION_DENIED', error.authorization.reason);
  if (error instanceof WorkspaceToolRejection)
    return providerToolErrorContent(error.code, error.message);
  if (error instanceof WorkspacePatchRejection)
    return providerToolErrorContent('PATCH_REJECTED', error.message);
  if (error instanceof CommandRunnerError)
    return providerToolErrorContent(error.code, error.message);
  // The stdin cap has to reach the model verbatim: the message tells it how to split the write so
  // it can retry instead of seeing an opaque failure (Issue #473).
  if (error instanceof ManagedStdinRejection)
    return providerToolErrorContent(error.code, error.message);
  if (error instanceof SkillSettingsError)
    return providerToolErrorContent(error.code, clipPublicMessage(error.message));
  secureLogger.error('Provider workspace tool execution failed', { error });
  return providerToolErrorContent('TOOL_EXECUTION_FAILED', 'Workspace tool execution failed');
}

export function providerToolErrorContent(code: string, message: string): string {
  return redactSecrets(JSON.stringify({ ok: false, error: { code, message } }));
}

function isOllamaCommand(providerId: string, toolName: string): boolean {
  return providerId === 'ollama' && ['exec_command', 'poll_command'].includes(toolName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactCommandText(text: string, knownWorkspaceRoots: readonly string[]): string {
  // Main supplies the sealed roots. Remove only a root followed by a real separator;
  // filenames and any sensitive suffix still pass through the disclosure classifier.
  const roots = knownWorkspaceRoots
    .filter((root) => typeof root === 'string')
    .flatMap((root, index) =>
      [...new Set(/^[a-z]:[\\/]/iu.test(root) ? [root, root.replaceAll('\\', '/')] : [root])].map(
        (variant) => ({
          root: variant.replace(/[\\/]+$/u, ''),
          label: '<workspace-' + (index + 1) + '>',
        }),
      ),
    )
    .filter(({ root }) => root.length > 1 && !/^[a-z]:$/iu.test(root))
    .sort((a, b) => b.root.length - a.root.length);
  for (const { root, label } of roots)
    for (const separator of ['/', '\\'])
      text = text.split(root + separator).join(label + separator);
  return assessProviderDisclosure(text).redactedContent;
}

function redactCommandOutput(
  result: unknown,
  knownWorkspaceRoots: readonly string[],
  maskAll = false,
): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
  let changed = false;
  const redact = (text: string): string => {
    const redacted =
      maskAll && text.length > 0
        ? '[REDACTED_COMMAND_OUTPUT]'
        : redactCommandText(text, knownWorkspaceRoots);
    changed ||= redacted !== text;
    return redacted;
  };
  const output: Record<string, unknown> = { ...result };
  for (const key of ['stdout', 'stderr', 'error'])
    if (typeof output[key] === 'string') output[key] = redact(output[key]);
  if (Array.isArray(output.chunks))
    output.chunks = output.chunks.map((chunk: unknown) => {
      if (
        typeof chunk !== 'object' ||
        chunk === null ||
        !('text' in chunk) ||
        typeof chunk.text !== 'string'
      )
        return chunk;
      return { ...chunk, text: redact(chunk.text) };
    });
  // Keep persisted command evidence intact; only the Provider-facing text is redacted.
  // Byte counts and cursors still describe the original command output.
  return changed ? { ...output, outputRedacted: true } : result;
}

function isFileReadResult(value: unknown): value is Record<string, unknown> & { content: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!('content' in value) || typeof value.content !== 'string') return false;
  if (!('rootId' in value) || typeof value.rootId !== 'string') return false;
  if (!('path' in value) || typeof value.path !== 'string') return false;
  if (!('truncated' in value) || typeof value.truncated !== 'boolean') return false;
  if (!('revision' in value) || typeof value.revision !== 'object' || value.revision === null)
    return false;
  return (
    'version' in value.revision &&
    value.revision.version === 1 &&
    'tokenId' in value.revision &&
    typeof value.revision.tokenId === 'string'
  );
}
