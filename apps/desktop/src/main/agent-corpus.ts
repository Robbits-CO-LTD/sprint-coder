import { digestCanonical } from './context-compiler';
import { estimateTokens } from './context-ledger';
import {
  createDeterministicMockSampler,
  deterministicMockToolExecutor,
  runIntelligenceLoop,
} from './intelligence-loop';

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
    const result = await runIntelligenceLoop({
      taskId: `corpus:${corpusCase.id}`,
      turnId: `turn:${corpusCase.id}`,
      fragments: [],
      model: 'mock-v1',
      effort: 'low',
      policyEpoch: 0,
      workspaceRevision: 'corpus-fixture-v1',
      contractRevision: null,
      sample: createDeterministicMockSampler(
        corpusCase.input,
        corpusCase.expectedText,
        corpusCase.mode,
      ),
      executeTool: deterministicMockToolExecutor,
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
