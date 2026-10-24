/** Persisted selections remain readable after the built-in installer/runtime is retired. */
export function isRetiredManagedLocal(
  connectionId: string | null,
  providerId: string | null,
): boolean {
  return connectionId === 'managed-local:runtime' || providerId === 'sprint-managed-local';
}

export class RetiredManagedLocalError extends Error {
  constructor() {
    super('内蔵ローカルAI機能は廃止されました。モデルと接続から別のProviderを選択してください。');
  }
}

export function assertNotRetiredManagedLocal(
  connectionId: string | null,
  providerId: string | null,
): void {
  if (isRetiredManagedLocal(connectionId, providerId)) throw new RetiredManagedLocalError();
}
