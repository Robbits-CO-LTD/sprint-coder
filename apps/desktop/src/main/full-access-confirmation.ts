export const FULL_ACCESS_CONFIRMATION_TIMEOUT_MS = 120_000;

/** The detail of the native full-access dialog. It names the OS file manager (Finder on macOS). */
export function fullAccessConfirmationDetail(platform: NodeJS.Platform): string {
  const fileManager = platform === 'darwin' ? 'Finder' : 'エクスプローラー';
  return `コマンドと、デスクトップ操作（ほかのアプリの窓を読む・押す・入力する、アプリの起動。ログイン済みのブラウザーやメールのアプリも含む）を、確認なしで実行します。管理deny、秘密情報保護、provider egress、Renderer非特権は解除されません。ただし、これらはファイル・コマンド・ネットワークの道具に効く保護で、デスクトップ操作が開いている窓（端末、${fileManager}、パスワード管理のアプリ、ブラウザーなど）を読んだり入力したりすることは止めません。`;
}

export class FullAccessConfirmation {
  private readonly controllers = new Set<AbortController>();
  private disposed = false;

  async confirm(show: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
    if (this.disposed) return false;
    const controller = new AbortController();
    this.controllers.add(controller);
    let cancel = (): void => undefined;
    const canceled = new Promise<false>((resolve) => {
      cancel = () => resolve(false);
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), FULL_ACCESS_CONFIRMATION_TIMEOUT_MS);
    try {
      // Abort closes the native dialog. Settle independently as well: a delayed native reply
      // must neither hold the Task mailbox nor authorize a change after cancellation.
      const approved = await Promise.race([show(controller.signal), canceled]);
      return !controller.signal.aborted && approved;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancel);
      this.controllers.delete(controller);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
  }
}
