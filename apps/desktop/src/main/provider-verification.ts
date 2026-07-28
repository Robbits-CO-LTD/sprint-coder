import type { ProviderConnection } from '@sprint-coder/contracts';
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

export class ProviderVerificationRequiredError extends Error {}
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
    const refreshed = await this.verify(connection, signal);
    if (refreshed.verification.status !== 'verified')
      throw new ProviderVerificationRequiredError(
        refreshed.verification.message ?? 'Provider connection verification failed',
      );
    return refreshed;
  }

  async verify(
    connection: ProviderConnection,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProviderConnection> {
    if (connection.runtimeKind === 'builtin_cli') return connection;
    const runtime = this.registry.resolve(connection);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new ProviderVerificationTimeoutError(
            'Provider connection verification did not complete before the preflight timeout',
          ),
        );
      }, this.preflightTimeoutMs);
    });
    try {
      const result = await Promise.race([runtime.verify(connection, controller.signal), timeout]);
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
      return this.repository.updateProviderConnectionVerification(connection.id, verification);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}
