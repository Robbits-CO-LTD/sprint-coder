import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { spawnOwnedCliProcess, stopOwnedCliProcess } from './owned-cli-process';
import { terminateRuntimeProcessTree } from './process-tree';
import { RUNTIME_MODEL_PROBE_TIMEOUT_MS } from './probe-budget';

export function modelRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Metadata only: never sends a user message or starts a thread/turn. */
export async function probeCliModels(
  kind: 'claude' | 'codex',
  executable: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = RUNTIME_MODEL_PROBE_TIMEOUT_MS,
): Promise<unknown[]> {
  const args =
    kind === 'codex'
      ? ['app-server']
      : [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--tools',
          '',
          '--permission-mode',
          'dontAsk',
          '--strict-mcp-config',
          '--safe-mode',
          '--no-session-persistence',
        ];
  const child = spawnOwnedCliProcess(
    executable,
    args,
    {
      cwd: tmpdir(),
      env: environment,
      detached: process.platform !== 'win32',
      windowsHide: true,
    },
    () => undefined,
  );
  let result: unknown[] | null;
  try {
    result = await new Promise<unknown[] | null>((resolve) => {
      let settled = false;
      let bytes = 0;
      let buffered = '';
      let requestId = 1;
      const models: unknown[] = [];
      const cursors = new Set<string>();
      const decoder = new StringDecoder('utf8');
      const finish = (value: unknown[] | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const send = (message: unknown): void => {
        if (settled) return;
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`);
        } catch {
          finish(null);
        }
      };
      const read = (value: unknown): void => {
        const message = modelRecord(value);
        if (kind === 'claude') {
          const response = modelRecord(message['response']);
          if (message['type'] !== 'control_response' || response['request_id'] !== 'models') return;
          const data = modelRecord(response['response'])['models'];
          finish(response['subtype'] === 'success' && Array.isArray(data) ? data : null);
          return;
        }
        if (message['id'] !== requestId) return;
        if ('error' in message || !('result' in message)) {
          finish(null);
          return;
        }
        if (requestId === 1) {
          send({ method: 'initialized' });
        } else {
          const page = modelRecord(message['result']);
          if (!Array.isArray(page['data'])) {
            finish(null);
            return;
          }
          models.push(...page['data']);
          const cursor = page['nextCursor'];
          if (cursor === null || cursor === undefined) {
            finish(models);
            return;
          }
          if (
            typeof cursor !== 'string' ||
            cursor.length > 8192 ||
            cursors.has(cursor) ||
            cursors.size >= 32 ||
            models.length > 1024
          ) {
            finish(null);
            return;
          }
          cursors.add(cursor);
          requestId++;
          send({
            id: requestId,
            method: 'model/list',
            params: { cursor, limit: 100, includeHidden: false },
          });
          return;
        }
        requestId++;
        send({ id: requestId, method: 'model/list', params: { limit: 100, includeHidden: false } });
      };
      child.once('error', () => finish(null));
      child.once('exit', () => finish(null));
      child.stdin.on('error', () => finish(null));
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) finish(null);
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          finish(null);
          return;
        }
        buffered += decoder.write(chunk);
        let end: number;
        while (!settled && (end = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (line.trim() === '') continue;
          try {
            read(JSON.parse(line) as unknown);
          } catch {
            finish(null);
          }
        }
      });
      send(
        kind === 'claude'
          ? {
              type: 'control_request',
              request_id: 'models',
              request: { subtype: 'initialize', hooks: {} },
            }
          : {
              id: requestId,
              method: 'initialize',
              params: { clientInfo: { name: 'sprint-coder-models', version: '1' } },
            },
      );
    });
  } finally {
    const stopped = await (stopOwnedCliProcess(child) ??
      terminateRuntimeProcessTree(child, environment));
    if (!stopped) result = null;
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  }
  return result ?? [];
}
