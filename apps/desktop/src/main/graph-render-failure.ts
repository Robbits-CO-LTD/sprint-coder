import type { GraphWorkerDiagnosticCode } from '@sprint-coder/contracts';

/** Only validated categories cross the Provider error boundary, never worker text. */
export class GraphRenderFailure extends Error {
  constructor(
    readonly mode: 'render' | 'check',
    readonly diagnosticCodes: readonly GraphWorkerDiagnosticCode[] = [],
    readonly reason: 'worker_failure' | 'timeout' | 'canceled' = 'worker_failure',
  ) {
    const detail = reason === 'worker_failure' ? diagnosticCodes.join(', ') : reason;
    super(`Archify ${mode} failed${detail ? ` [${detail}]` : ''}`);
  }
}
