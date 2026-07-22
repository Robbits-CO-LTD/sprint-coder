import { digestCanonical } from './context-compiler';
import { estimateTokens } from './context-ledger';
import { createDeterministicMockSampler, runIntelligenceLoop } from './intelligence-loop';
import { createDefaultToolBroker, startMockTurnCatalog } from './default-tools';

export type BaselineCorpusCase = {
  id: string;
  mode: 'answer-only' | 'mock-tool';
  input: string;
  expectedText: string;
  expectedToolCalls: number;
};

export type BaselineCorpusCaseResult = {
  caseId: string;
  success: boolean;
  falseCompletion: boolean;
  toolCalls: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  wallTimeMs: number;
};

export type BaselineCorpusRun = {
  seed: string;
  configurationDigest: string;
  cases: BaselineCorpusCaseResult[];
};

export const BASELINE_CORPUS: readonly BaselineCorpusCase[] = Object.freeze([
  Object.freeze({
    id: 'answer-only-001',
    mode: 'answer-only' as const,
    input: 'Reply without using a tool.',
    expectedText: 'answer-only complete',
    expectedToolCalls: 0,
  }),
  Object.freeze({
    id: 'mock-tool-001',
    mode: 'mock-tool' as const,
    input: 'Echo this through the mock tool.',
    expectedText: 'mock-tool complete',
    expectedToolCalls: 1,
  }),
]);

export async function runBaselineCorpus(
  cases: readonly BaselineCorpusCase[] = BASELINE_CORPUS,
  seed = 'intelligence-baseline-v1',
): Promise<BaselineCorpusRun> {
  const results: BaselineCorpusCaseResult[] = [];
  for (const corpusCase of cases) {
    const startedAt = performance.now();
    const taskId = `corpus:${corpusCase.id}`;
    const turnId = `turn:${corpusCase.id}`;
    const toolBroker = createDefaultToolBroker(() => 0);
    const toolCatalogSnapshot = startMockTurnCatalog(toolBroker, {
      taskId,
      turnId,
      workspaceId: null,
      policyEpoch: 0,
    });
    const result = await runIntelligenceLoop({
      taskId,
      turnId,
      fragments: [],
      model: 'mock-v1',
      effort: 'low',
      policyEpoch: 0,
      workspaceRevision: 'corpus-fixture-v1',
      contractRevision: null,
      toolCatalogSnapshot,
      sample: createDeterministicMockSampler(
        corpusCase.input,
        corpusCase.expectedText,
        corpusCase.mode,
      ),
      executeTool: async (call) => {
        const output = await toolBroker.dispatch({
          taskId,
          turnId,
          callId: call.callId,
          providerName: call.toolName,
          input: call.arguments,
        });
        if (typeof output !== 'string') throw new Error('Corpus tool returned non-string output');
        return output;
      },
    });
    const success =
      result.text === corpusCase.expectedText &&
      result.toolCallCount === corpusCase.expectedToolCalls;
    results.push({
      caseId: corpusCase.id,
      success,
      falseCompletion: result.text.length > 0 && !success,
      toolCalls: result.toolCallCount,
      steps: result.stepCount,
      inputTokens: estimateTokens(corpusCase.input),
      outputTokens: estimateTokens(result.text),
      wallTimeMs: performance.now() - startedAt,
    });
  }
  return {
    seed,
    configurationDigest: digestCanonical({ seed, cases, model: 'mock-v1', policyEpoch: 0 }),
    cases: results,
  };
}
