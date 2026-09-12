import { watch } from 'node:fs';
import { isAbsolute, relative, basename } from 'node:path';
import type {
  EffectiveWorkspaceSet,
  GraphDocument,
  GraphSourceCheckInput,
  GraphSourceStatus,
} from '@sprint-coder/contracts';
import { previewGraphSource } from './graph-source-preview';

type Binding = { workspace: EffectiveWorkspaceSet; policyEpoch: number };
type WatchRoot = (
  path: string,
  changed: (path: string | null) => void,
  failed: () => void,
) => () => void;
type Session = {
  input: GraphSourceCheckInput;
  document: GraphDocument;
  status: GraphSourceStatus;
  bindingKey: string | null;
  stops: (() => void)[];
  invalidation: number;
  timer?: NodeJS.Timeout | undefined;
  running?: Promise<GraphSourceStatus> | undefined;
};
const watchRoot: WatchRoot = (path, changed, failed) => {
  const watcher = watch(path, { recursive: true, persistent: false }, (_event, filename) =>
    changed(filename?.toString() ?? null),
  );
  watcher.on('error', failed);
  return () => watcher.close();
};

/** A visible graph owns one transient monitor. Notifications are hints; guarded reads decide status.
 * Only IDs and comparison outcomes leave this service, never freshly read source text. */
export class GraphSourceMonitor {
  private active: Session | null = null;
  private closed = false;
  constructor(
    private readonly deps: {
      document: (input: GraphSourceCheckInput) => GraphDocument;
      binding: (taskId: string) => Binding;
      publish: (status: GraphSourceStatus) => void;
      watch?: WatchRoot;
      inspect?: typeof previewGraphSource;
    },
  ) {}

  check(input: GraphSourceCheckInput): Promise<GraphSourceStatus> {
    if (this.closed) return Promise.reject(new Error('Graph monitor closed'));
    const document = this.deps.document(input);
    let session = this.active;
    if (!session || session.input.instanceId !== input.instanceId) {
      this.stop();
      session = {
        input,
        document,
        bindingKey: null,
        stops: [],
        invalidation: 0,
        status: {
          ...input,
          sequence: 1,
          phase: 'checking',
          checkedAt: null,
          monitoring: false,
          sources: [],
        },
      };
      this.active = session;
    }
    return this.run(session);
  }

  invalidate(taskId?: string): void {
    const session = this.active;
    if (!session || (taskId !== undefined && session.input.taskId !== taskId)) return;
    session.invalidation++;
    this.emit(session, { phase: 'checking', checkedAt: null, sources: [] });
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      session.timer = undefined;
      void this.run(session);
    }, 150);
  }

  release(taskId: string, instanceId: string): void {
    if (this.active?.input.taskId === taskId && this.active.input.instanceId === instanceId)
      this.stop();
  }
  dispose(): void {
    this.closed = true;
    this.stop();
  }
  private stop(): void {
    const session = this.active;
    this.active = null;
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    for (const stop of session.stops) stop();
  }
  private emit(session: Session, update: Partial<GraphSourceStatus>): void {
    if (this.active !== session) return;
    session.status = { ...session.status, ...update, sequence: session.status.sequence + 1 };
    this.deps.publish(session.status);
  }
  private configure(session: Session, binding: Binding): void {
    const key = `${binding.workspace.digest}:${binding.policyEpoch}`;
    if (session.bindingKey === key) return;
    for (const stop of session.stops) stop();
    session.stops = [];
    session.bindingKey = key;
    const rootIdFor = (rootId: string) =>
      rootId === 'legacy-primary' ? binding.workspace.primaryRootId : rootId;
    session.status.monitoring = session.document.sources.every((source) =>
      binding.workspace.roots.some((root) => root.rootId === rootIdFor(source.rootId)),
    );
    for (const root of binding.workspace.roots) {
      const paths = session.document.sources
        .filter((source) => rootIdFor(source.rootId) === root.rootId)
        .map((source) => source.path.toLowerCase());
      if (!paths.length) continue;
      try {
        session.stops.push(
          (this.deps.watch ?? watchRoot)(
            root.path,
            (filename) => {
              const path =
                filename === null
                  ? null
                  : (isAbsolute(filename) ? relative(root.path, filename) : filename)
                      .replaceAll('\\', '/')
                      .toLowerCase();
              if (
                path === null ||
                path === basename(root.path).toLowerCase() ||
                paths.some((source) => source === path || source.startsWith(`${path}/`))
              )
                this.invalidate(session.input.taskId);
            },
            () => {
              if (this.active !== session) return;
              session.status.monitoring = false;
              this.invalidate(session.input.taskId);
            },
          ),
        );
      } catch {
        session.status.monitoring = false;
      }
    }
  }
  private run(session: Session): Promise<GraphSourceStatus> {
    if (session.running) return session.running;
    if (this.active !== session) return Promise.resolve(session.status);
    const invalidation = session.invalidation;
    const pending = (async () => {
      this.emit(session, { phase: 'checking', checkedAt: null, sources: [] });
      try {
        this.deps.document(session.input);
        const binding = this.deps.binding(session.input.taskId);
        this.configure(session, binding);
        const sources: GraphSourceStatus['sources'] = [];
        for (const source of session.document.sources) {
          if (this.active !== session || session.invalidation !== invalidation)
            return session.status;
          const rootId =
            source.rootId === 'legacy-primary' ? binding.workspace.primaryRootId : source.rootId;
          const path = binding.workspace.roots.find((root) => root.rootId === rootId)?.path ?? null;
          const result = await (this.deps.inspect ?? previewGraphSource)(
            source,
            path,
            binding.policyEpoch,
          );
          sources.push({ sourceId: source.id, status: result.status });
        }
        if (this.active !== session || session.invalidation !== invalidation) return session.status;
        this.deps.document(session.input);
        const current = this.deps.binding(session.input.taskId);
        if (
          current.workspace.digest !== binding.workspace.digest ||
          current.policyEpoch !== binding.policyEpoch
        ) {
          this.invalidate(session.input.taskId);
          return session.status;
        }
        this.emit(session, { phase: 'checked', checkedAt: new Date().toISOString(), sources });
      } catch {
        this.emit(session, {
          phase: 'checked',
          checkedAt: new Date().toISOString(),
          sources: session.document.sources.map((source) => ({
            sourceId: source.id,
            status: 'unavailable',
          })),
        });
      }
      return session.status;
    })();
    session.running = pending;
    void pending.finally(() => {
      session.running = undefined;
      if (this.active === session && invalidation !== session.invalidation && !session.timer)
        this.invalidate(session.input.taskId);
    });
    return pending;
  }
}
