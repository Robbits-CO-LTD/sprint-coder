import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { describe, expect, it } from 'vitest';
import { EXTERNAL_ACP_AGENTS } from './external-acp-profile';
import { ExternalAcpRuntime } from './external-acp-runtime';
import { removeTreeWithoutFollowingLinksSync } from '../runtime-host/link-safe-tree-removal';

const enabled = process.env['SPRINT_TEST_EXTERNAL_ACP'];

const cases = [
  { agent: EXTERNAL_ACP_AGENTS[0], modelId: 'opencode/nemotron-3.5-lightning-free' },
  { agent: EXTERNAL_ACP_AGENTS[1], modelId: 'gemini-4-neon' },
] as const;

describe('opt-in live external ACP chat', () => {
  for (const { agent, modelId } of cases) {
    it.skipIf(enabled !== agent.providerId)(
      `${agent.name} streams a response from ${modelId}`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), 'sprint-acp-live-'));
        const profile = process.env['SPRINT_TEST_ANTIGRAVITY_HOME'] ?? join(root, 'agy-home');
        const runtime = new ExternalAcpRuntime(agent, profile);
        const connection: ProviderConnection = {
          id: agent.connectionId,
          providerId: agent.providerId,
          runtimeKind: 'builtin_cli',
          displayName: agent.name,
          enabled: true,
          secretReference: null,
          verification: {
            status: 'not_required',
            verifiedAt: null,
            expiresAt: null,
            message: null,
          },
          rateLimit: {
            mode: 'bypass',
            maxConcurrentRequests: null,
            requestsPerMinute: null,
            tokensPerMinute: null,
            lastObservedRateLimitHeaders: null,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        try {
          const signal = AbortSignal.timeout(65_000);
          const models = await runtime.listModels(connection, signal);
          expect(models.some((model) => model.modelId === modelId)).toBe(true);
          let response = '';
          let completed = false;
          let resolvedModel: string | null = null;
          for await (const event of runtime.execute(
            connection,
            {
              executionId: 'external-acp-live-smoke',
              connectionId: connection.id,
              modelId,
              messages: [
                {
                  role: 'user',
                  content: 'Reply with exactly SPRINT_ACP_CHAT_OK. Do not use any tools.',
                },
              ],
            },
            signal,
          )) {
            if (event.type === 'error')
              throw new Error(event.error.providerCode ?? event.error.category);
            if (event.type === 'output_delta') response += event.text;
            if (event.type === 'completed') completed = true;
            if (event.type === 'resolution') resolvedModel = event.resolution.resolvedModel;
          }
          expect(response.trim() === 'SPRINT_ACP_CHAT_OK').toBe(true);
          expect(completed).toBe(true);
          expect(resolvedModel).toBe(modelId);
        } finally {
          await runtime.dispose();
          removeTreeWithoutFollowingLinksSync(root);
        }
      },
      70_000,
    );
  }
});
