import type {
  IntelligenceStepState,
  ReasoningEffort,
  StepSnapshot,
  ToolCatalogSnapshot,
} from '@sprint-coder/domain';
import {
  ContextCompiler,
  digestCanonical,
  type ToolTranscriptItem,
  type WorldState,
} from './context-compiler';
import type { ContextFragment, ProjectContextItem } from './context-ledger';
import { join } from 'node:path';
import { getTrustedWindowsSystemDirectory } from './prepared-execution-image';

export type ModelToolCall = {
  callId: string;
  toolName: string;
  arguments: unknown;
};

export type ModelSample =
  { kind: 'final'; text: string } | { kind: 'tool-calls'; calls: readonly ModelToolCall[] };

export type ModelSampler = (input: {
  stepOrdinal: number;
  compiledContextDigest: string;
  transcript: readonly ToolTranscriptItem[];
  toolCatalogSnapshot: ToolCatalogSnapshot;
}) => Promise<ModelSample> | ModelSample;

export type ToolDeniedResult = Readonly<{
  ok: false;
  code:
    'PERMISSION_DENIED' | 'POLICY_DENIED' | 'APPROVAL_EXPIRED' | 'APPROVAL_STALE' | 'TURN_CANCELED';
  content: string;
}>;

export type ToolExecutor = (
  call: ModelToolCall,
) => Promise<string | ToolDeniedResult> | string | ToolDeniedResult;

export type IntelligenceStepRecorder = {
  createIntelligenceStep(input: {
    taskId: string;
    turnId: string;
    model: string;
    effort: ReasoningEffort;
    contextDigest: string;
    toolCatalogDigest: string;
    policyEpoch: number;
    workspaceRevision: string;
    contractRevision: number | null;
  }): Promise<StepSnapshot> | StepSnapshot;
  transitionIntelligenceStep(stepId: string, state: IntelligenceStepState): Promise<void> | void;
};

export type IntelligenceLoopInput = {
  taskId: string;
  turnId: string;
  fragments: readonly ContextFragment[];
  projectItems?: readonly ProjectContextItem[];
  model: string;
  effort: ReasoningEffort;
  policyEpoch: number;
  workspaceRevision: string;
  contractRevision: number | null;
  toolCatalogSnapshot: ToolCatalogSnapshot;
  sample: ModelSampler;
  executeTool: ToolExecutor;
  recorder?: IntelligenceStepRecorder;
  maxSteps?: number;
};

export type IntelligenceLoopResult = {
  text: string;
  stepCount: number;
  toolCallCount: number;
  transcript: ToolTranscriptItem[];
};

export async function runIntelligenceLoop(
  input: IntelligenceLoopInput,
): Promise<IntelligenceLoopResult> {
  const compiler = new ContextCompiler();
  const transcript: ToolTranscriptItem[] = [];
  const maxSteps = input.maxSteps ?? 8;
  let toolCallCount = 0;
  let previousWorldState: WorldState = {};
  const worldState: WorldState = {
    policyEpoch: input.policyEpoch,
    workspaceRevision: input.workspaceRevision,
  };

  for (let ordinal = 1; ordinal <= maxSteps; ordinal += 1) {
    const compiled = compiler.compile({
      fragments: input.fragments,
      ...(input.projectItems === undefined ? {} : { projectItems: input.projectItems }),
      toolTranscript: transcript,
      previousWorldState,
      worldState,
    });
    previousWorldState = worldState;
    const snapshot =
      input.recorder === undefined
        ? undefined
        : await input.recorder.createIntelligenceStep({
            taskId: input.taskId,
            turnId: input.turnId,
            model: input.model,
            effort: input.effort,
            contextDigest: compiled.digest,
            toolCatalogDigest: input.toolCatalogSnapshot.digest,
            policyEpoch: input.policyEpoch,
            workspaceRevision: input.workspaceRevision,
            contractRevision: input.contractRevision,
          });
    const transition = async (state: IntelligenceStepState): Promise<void> => {
      if (snapshot !== undefined)
        await input.recorder?.transitionIntelligenceStep(snapshot.stepId, state);
    };

    try {
      await transition('sampling');
      const sampled = await input.sample({
        stepOrdinal: ordinal,
        compiledContextDigest: compiled.digest,
        transcript,
        toolCatalogSnapshot: input.toolCatalogSnapshot,
      });
      await transition('sampled');
      if (sampled.kind === 'final') {
        await transition('completed');
        return { text: sampled.text, stepCount: ordinal, toolCallCount, transcript };
      }

      await transition('dispatching');
      for (const call of sampled.calls) {
        if (
          !input.toolCatalogSnapshot.entries.some(
            ({ providerName }) => providerName === call.toolName,
          )
        )
          throw new Error(`Tool is not present in the immutable Turn catalog: ${call.toolName}`);
        const outcome = await input.executeTool(call);
        const denied = typeof outcome !== 'string';
        const content = denied ? outcome.content : outcome;
        transcript.push({
          type: 'tool-call',
          callId: call.callId,
          toolName: call.toolName,
          arguments: call.arguments,
        });
        transcript.push({ type: 'tool-result', callId: call.callId, content, isError: denied });
      }
      toolCallCount += sampled.calls.length;
      await transition('toolsCommitted');
      await transition('completed');
    } catch (error) {
      await transition('failed');
      throw error;
    }
  }
  throw new Error(`Intelligence loop exceeded ${maxSteps} steps`);
}

export function createDeterministicMockSampler(
  input: string,
  finalText: string,
  mode: 'answer-only' | 'mock-tool' = 'mock-tool',
): ModelSampler {
  return ({ transcript }) => {
    if (mode === 'answer-only' || transcript.length > 0) return { kind: 'final', text: finalText };
    if (input.includes('承認テスト'))
      return {
        kind: 'tool-calls',
        calls: [
          {
            callId: `approval-${digestCanonical(input).slice(0, 16)}`,
            toolName: 'approval_probe',
            arguments: { origin: 'https://example.test' },
          },
        ],
      };
    if (input.includes('コマンドテスト')) {
      const fixture = commandFixture();
      return {
        kind: 'tool-calls',
        calls: [
          {
            callId: `command-${digestCanonical(input).slice(0, 16)}`,
            toolName: 'run_command',
            arguments: {
              executable: fixture.executable,
              argv: fixture.argv,
              cwd: '.',
              purpose: '変更の整合性を確認するため、コマンドを実行します',
            },
          },
        ],
      };
    }
    return {
      kind: 'tool-calls',
      calls: [
        {
          callId: `mock-${digestCanonical(input).slice(0, 16)}`,
          toolName: 'mock_echo',
          arguments: { text: input },
        },
      ],
    };
  };
}

function commandFixture(): { executable: string; argv: string[] } {
  return process.platform === 'win32'
    ? {
        executable: join(getTrustedWindowsSystemDirectory(), 'cmd.exe'),
        argv: ['/d', '/s', '/c', 'echo command ok'],
      }
    : { executable: '/usr/bin/printf', argv: ['command ok\\n'] };
}

export const deterministicMockToolExecutor: ToolExecutor = (call) => {
  if (call.toolName !== 'mock_echo') throw new Error(`Unknown mock tool: ${call.toolName}`);
  if (
    typeof call.arguments !== 'object' ||
    call.arguments === null ||
    typeof (call.arguments as { text?: unknown }).text !== 'string'
  )
    throw new Error('mock_echo requires a string text argument');
  return (call.arguments as { text: string }).text;
};
