import type { ProviderConnection, TurnFailureReason } from '@sprint-coder/contracts';
import type { ProviderRegistry } from './provider-runtime';

export const DEFAULT_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;
export const PREFLIGHT_VERIFICATION_TIMEOUT_MS = 3_000;

export interface ProviderVerificationRepository {
  getProviderConnection(connectionId: string): ProviderConnection;
  updateProviderConnectionVerification(
    connectionId: string,
    verification: ProviderConnection['verification'],
  ): ProviderConnection;
}

export class ProviderVerificationRequiredError extends Error {
  constructor(
    message: string,
    readonly failureReason: Extract<
      TurnFailureReason,
      'api_credentials' | 'api_network' | 'api_timeout'
    >,
  ) {
    super(message);
  }
}
export class ProviderVerificationTimeoutError extends Error {}

export class ProviderVerificationService {
  constructor(
    private readonly repository: ProviderVerificationRepository,
    private readonly registry: ProviderRegistry,
    private readonly now: () => Date = () => new Date(),
    private readonly verificationTtlMs = DEFAULT_VERIFICATION_TTL_MS,
    private readonly preflightTimeoutMs = PREFLIGHT_VERIFICATION_TIMEOUT_MS,
  ) {}

  getConnection(connectionId: string): ProviderConnection {
    const connection = this.repository.getProviderConnection(connectionId);
    if (
      connection.verification.status === 'verified' &&
      connection.verification.expiresAt !== null &&
      Date.parse(connection.verification.expiresAt) <= this.now().getTime()
    )
      return this.repository.updateProviderConnectionVerification(connection.id, {
        ...connection.verification,
        status: 'verification_expired',
      });
    return connection;
  }

  async requireVerifiedForExecution(
    connectionId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProviderConnection> {
    const connection = this.getConnection(connectionId);
    if (connection.verification.status === 'not_required') return connection;
    if (connection.verification.status === 'verified') return connection;
    const { connection: refreshed, timedOut } = await this.runVerification(connection, signal);
    if (refreshed.verification.status !== 'verified')
      throw new ProviderVerificationRequiredError(
        refreshed.verification.message ?? 'Provider connection verification failed',
        refreshed.verification.status === 'invalid_credentials'
          ? 'api_credentials'
          : timedOut
            ? 'api_timeout'
            : 'api_network',
      );
    return refreshed;
  }

  async verify(
    connection: ProviderConnection,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProviderConnection> {
    return (await this.runVerification(connection, signal)).connection;
  }

  private async runVerification(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<{ connection: ProviderConnection; timedOut: boolean }> {
    if (connection.runtimeKind === 'builtin_cli') return { connection, timedOut: false };
    const runtime = this.registry.resolve(connection);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new ProviderVerificationTimeoutError(
            'Provider connection verification did not complete before the preflight timeout',
          ),
        );
        controller.abort();
      }, this.preflightTimeoutMs);
    });
    try {
      controller.signal.throwIfAborted();
      const result = await Promise.race([runtime.verify(connection, controller.signal), timeout]);
      controller.signal.throwIfAborted();
      const verifiedAt = this.now();
      const verification: ProviderConnection['verification'] =
        result.status === 'verified'
          ? {
              status: 'verified',
              verifiedAt: verifiedAt.toISOString(),
              expiresAt: new Date(verifiedAt.getTime() + this.verificationTtlMs).toISOString(),
              message: result.message,
            }
          : {
              status: result.status,
              verifiedAt: verifiedAt.toISOString(),
              expiresAt: null,
              message: result.message,
            };
      return {
        connection: this.repository.updateProviderConnectionVerification(
          connection.id,
          verification,
        ),
        timedOut: false,
      };
    } catch (error) {
      if (!(error instanceof ProviderVerificationTimeoutError)) throw error;
      return {
        connection: this.repository.updateProviderConnectionVerification(connection.id, {
          status: 'unavailable',
          verifiedAt: this.now().toISOString(),
          expiresAt: null,
          message: 'Provider connection verification timed out',
        }),
        timedOut: true,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}
