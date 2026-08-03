export type TaskTitleRuntimeKind = 'codex' | 'claude';

/**
 * Owns Runtime Hosts used only by background title generation. A host is created lazily per CLI
 * kind, so cancelling or restarting it can never terminate a foreground conversation Turn.
 */
export class TaskTitleRuntimePool<T extends { dispose(): void }> {
  private codex: T | null = null;
  private claude: T | null = null;

  constructor(private readonly create: (kind: TaskTitleRuntimeKind) => T) {}

  get(kind: TaskTitleRuntimeKind): T {
    const existing = kind === 'claude' ? this.claude : this.codex;
    if (existing !== null) return existing;
    const runtime = this.create(kind);
    if (kind === 'claude') this.claude = runtime;
    else this.codex = runtime;
    return runtime;
  }

  dispose(): void {
    this.codex?.dispose();
    this.claude?.dispose();
    this.codex = null;
    this.claude = null;
  }
}
