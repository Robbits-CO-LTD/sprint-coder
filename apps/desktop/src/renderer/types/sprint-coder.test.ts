import { describe, expectTypeOf, it } from 'vitest';
import type * as Contracts from '@sprint-coder/contracts';
import type {
  Capability,
  SprintCoderApi,
  TeamDetail,
  TurnEvent,
  TurnSnapshot,
  TurnStage,
} from './sprint-coder';

// These assertions are checked by desktop's tsc, including when skipLibCheck skips the .d.ts.
describe('Renderer contract boundary', () => {
  it('accepts the canonical Team patch input and result without casts', () => {
    expectTypeOf<TeamDetail>().toEqualTypeOf<Contracts.TeamDetail>();
    expectTypeOf<TeamDetail>().toEqualTypeOf<
      Parameters<typeof Contracts.applyTeamDetailPatch>[0]
    >();
    expectTypeOf<TeamDetail>().toEqualTypeOf<ReturnType<typeof Contracts.applyTeamDetailPatch>>();
  });

  it('preserves the IPC event, snapshot, and API contracts', () => {
    expectTypeOf<TurnEvent>().toEqualTypeOf<Contracts.TurnEvent>();
    expectTypeOf<TurnSnapshot>().toEqualTypeOf<Contracts.TurnSnapshot>();
    expectTypeOf<SprintCoderApi>().toEqualTypeOf<Contracts.SprintCoderApi>();
    expectTypeOf<Capability>().toEqualTypeOf<Contracts.ApprovalSummary['capability']>();
  });

  it('keeps the synthetic approval-wait stage in display state only', () => {
    expectTypeOf<TurnStage>().toEqualTypeOf<
      NonNullable<Contracts.TurnSnapshot['activeTurn']>['stage']
    >();
    expectTypeOf<
      Extract<TurnEvent, { type: 'stage.changed' }>['stage']
    >().toEqualTypeOf<Contracts.TurnStage>();
  });

  it('accepts every cancellation option validated by Preload and Main', () => {
    expectTypeOf<Parameters<SprintCoderApi['turns']['cancel']>[0]>().toEqualTypeOf<
      ReturnType<typeof Contracts.turnCancelInputSchema.parse>
    >();
  });
});
