import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProjectContextManifest,
  ProjectContextManifestSummary,
  ProjectInstruction,
  ProjectReference,
} from '../types/sprint-coder';
import { useAppStore } from '../store/appStore';

const INSTRUCTION_LIMIT_BYTES = 16_384;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function ProjectContextInspector({
  taskId,
  requestedTurnId,
  requestKey,
  onDirtyChange,
}: {
  taskId: string;
  requestedTurnId: string | null;
  requestKey: number;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const task = useAppStore((state) => state.tasks.find((item) => item.id === taskId));
  const projectId = task?.projectId ?? null;
  const projects = useAppStore((state) => state.projects);
  const messageVersion = useAppStore((state) => state.messagesByTask[taskId]?.length ?? 0);
  const projectsApi = window.sprintCoder?.projects;
  const [summaries, setSummaries] = useState<ProjectContextManifestSummary[] | null>(null);
  const [selectionRequestKey, setSelectionRequestKey] = useState(requestKey);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(requestedTurnId);
  const [detail, setDetail] = useState<{
    taskId: string;
    turnId: string;
    manifest: ProjectContextManifest | null;
    error: string | null;
  } | null>(null);
  const listToken = useRef(0);
  const detailToken = useRef(0);

  const [instructionState, setInstructionState] = useState<{
    projectId: string;
    value: ProjectInstruction;
  } | null>(null);
  const [draft, setDraft] = useState('');
  const [instructionError, setInstructionError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [saving, setSaving] = useState(false);
  const instructionToken = useRef(0);
  const [references, setReferences] = useState<ProjectReference[]>([]);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [referencesBusy, setReferencesBusy] = useState(false);
  const referenceToken = useRef(0);

  const loadReferences = useCallback(async () => {
    if (projectId === null || projectsApi === undefined) return;
    try {
      setReferences(await projectsApi.references.list({ projectId }));
      setReferenceError(null);
    } catch (error) {
      setReferenceError(
        error instanceof Error ? error.message : '参照ファイルを取得できませんでした。',
      );
    }
  }, [projectId, projectsApi]);

  useEffect(() => {
    if (projectId === null || projectsApi === undefined) return;
    const token = ++referenceToken.current;
    void projectsApi.references
      .list({ projectId })
      .then((next) => {
        if (referenceToken.current === token) setReferences(next);
      })
      .catch((error: unknown) => {
        if (referenceToken.current === token)
          setReferenceError(
            error instanceof Error ? error.message : '参照ファイルを取得できませんでした。',
          );
      });
    return () => {
      referenceToken.current += 1;
    };
  }, [projectId, projectsApi]);

  if (selectionRequestKey !== requestKey) {
    setSelectionRequestKey(requestKey);
    setSelectedTurnId(requestedTurnId);
  }

  useEffect(() => {
    const token = ++listToken.current;
    if (projectsApi === undefined) return;
    void projectsApi
      .listContextManifests({ taskId })
      .then((next) => {
        if (listToken.current === token) setSummaries(next);
      })
      .catch(() => {
        if (listToken.current === token) setSummaries([]);
      });
    return () => {
      listToken.current += 1;
    };
  }, [messageVersion, projectsApi, taskId]);

  const effectiveTurnId = selectedTurnId ?? summaries?.[0]?.turnId ?? null;
  useEffect(() => {
    const token = ++detailToken.current;
    if (effectiveTurnId === null || projectsApi === undefined) return;
    void projectsApi
      .getContextManifest({ taskId, turnId: effectiveTurnId })
      .then((next) => {
        if (
          detailToken.current !== token ||
          next.taskId !== taskId ||
          next.turnId !== effectiveTurnId
        )
          return;
        setDetail({ taskId, turnId: effectiveTurnId, manifest: next, error: null });
      })
      .catch((error: unknown) => {
        if (detailToken.current !== token) return;
        setDetail({
          taskId,
          turnId: effectiveTurnId,
          manifest: null,
          error: error instanceof Error ? error.message : 'Contextを取得できませんでした。',
        });
      });
    return () => {
      detailToken.current += 1;
    };
  }, [effectiveTurnId, projectsApi, taskId]);

  const loadInstruction = useCallback(
    async (replaceDraft: boolean) => {
      if (projectId === null || projectsApi === undefined) return;
      const token = ++instructionToken.current;
      try {
        const next = await projectsApi.get({ projectId });
        if (instructionToken.current !== token) return;
        setInstructionState({ projectId, value: next });
        if (replaceDraft) setDraft(next.instruction);
        setInstructionError(null);
        setConflicted(false);
      } catch (error) {
        if (instructionToken.current !== token) return;
        setInstructionError(
          error instanceof Error ? error.message : 'Instructionを取得できませんでした。',
        );
      }
    },
    [projectId, projectsApi],
  );

  useEffect(() => {
    if (projectId === null || projectsApi === undefined) return;
    const token = ++instructionToken.current;
    void projectsApi
      .get({ projectId })
      .then((next) => {
        if (instructionToken.current !== token) return;
        setInstructionState({ projectId, value: next });
        setDraft(next.instruction);
        setInstructionError(null);
        setConflicted(false);
      })
      .catch((error: unknown) => {
        if (instructionToken.current !== token) return;
        setInstructionError(
          error instanceof Error ? error.message : 'Instructionを取得できませんでした。',
        );
      });
    return () => {
      instructionToken.current += 1;
    };
  }, [projectId, projectsApi]);

  const instruction = instructionState?.projectId === projectId ? instructionState.value : null;
  const activeDetail =
    detail?.taskId === taskId && detail.turnId === effectiveTurnId ? detail : null;
  const manifest = activeDetail?.manifest ?? null;
  const manifestError = activeDetail?.error ?? null;

  const dirty = instruction !== null && draft !== instruction.instruction;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const byteLength = utf8Bytes(draft);
  const projectName = (projectId: string | null | undefined) =>
    projectId === null || projectId === undefined
      ? 'Projectなし'
      : (projects.find((project) => project.id === projectId)?.name ?? '不明なProject');

  async function saveInstruction(): Promise<void> {
    if (projectId === null || instruction === null || projectsApi === undefined) return;
    setSaving(true);
    setInstructionError(null);
    setConflicted(false);
    try {
      const next = await projectsApi.setInstruction({
        projectId,
        expectedRevision: instruction.revision,
        instruction: draft,
      });
      setInstructionState({ projectId, value: next });
      void useAppStore.getState().refreshProjects();
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      const message = error instanceof Error ? error.message : '保存できませんでした。';
      if (code === 'OPERATION_CONFLICT' || message.includes('最新状態を読み直してください'))
        setConflicted(true);
      setInstructionError(message);
    } finally {
      setSaving(false);
    }
  }

  async function refreshAfterReferenceMutation(): Promise<void> {
    await Promise.all([
      loadReferences(),
      loadInstruction(false),
      useAppStore.getState().refreshProjects(),
    ]);
  }

  return (
    <div className="project-context-inspector" data-testid="project-context-inspector">
      {projectId !== null && (
        <section className="project-context-section" aria-labelledby="project-instruction-title">
          <div className="project-context-section-head">
            <h3 id="project-instruction-title">Project Instruction</h3>
            <span>{projectName(projectId)}</span>
          </div>
          {instruction === null ? (
            <p className="insp-disconnected">Instructionを読み込んでいます…</p>
          ) : (
            <>
              <textarea
                data-testid="project-instruction-input"
                value={draft}
                rows={6}
                onChange={(event) => setDraft(event.target.value)}
                aria-describedby="project-instruction-count"
              />
              <div className="project-instruction-actions">
                <span
                  id="project-instruction-count"
                  className={byteLength > INSTRUCTION_LIMIT_BYTES ? 'is-over' : undefined}
                >
                  {byteLength.toLocaleString()} / {INSTRUCTION_LIMIT_BYTES.toLocaleString()} bytes
                </span>
                <button
                  type="button"
                  data-testid="project-instruction-save"
                  disabled={!dirty || saving || byteLength > INSTRUCTION_LIMIT_BYTES}
                  onClick={() => void saveInstruction()}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </>
          )}
          {instructionError !== null && <p className="project-context-error">{instructionError}</p>}
          {conflicted && (
            <div className="project-instruction-conflict" role="alert">
              入力内容は保持されています。最新のInstructionを読み直すと現在の入力を置き換えます。
              <button type="button" onClick={() => void loadInstruction(true)}>
                最新を再読込
              </button>
            </div>
          )}
        </section>
      )}

      {projectId !== null && (
        <section className="project-context-section" aria-labelledby="project-references-title">
          <div className="project-context-section-head">
            <h3 id="project-references-title">Reference files</h3>
            <div>
              <button type="button" disabled={referencesBusy} onClick={() => void loadReferences()}>
                更新
              </button>
              <button
                type="button"
                disabled={referencesBusy || task?.workspacePath == null}
                onClick={() => {
                  if (projectsApi === undefined) return;
                  setReferencesBusy(true);
                  void projectsApi.references
                    .pick({ projectId, sourceTaskId: taskId })
                    .then(() => refreshAfterReferenceMutation())
                    .catch((error: unknown) =>
                      setReferenceError(
                        error instanceof Error ? error.message : '追加できませんでした。',
                      ),
                    )
                    .finally(() => setReferencesBusy(false));
                }}
              >
                ファイルを追加
              </button>
            </div>
          </div>
          {references.length === 0 ? (
            <p className="insp-disconnected">参照ファイルはありません。</p>
          ) : (
            <ul className="project-reference-list">
              {references.map((reference) => (
                <li key={reference.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={reference.enabled}
                      onChange={(event) => {
                        if (projectsApi === undefined) return;
                        void projectsApi.references
                          .update({
                            referenceId: reference.id,
                            expectedRevision: reference.revision,
                            enabled: event.target.checked,
                          })
                          .then(() => refreshAfterReferenceMutation());
                      }}
                    />
                    <span>{reference.relativePath}</span>
                  </label>
                  <span>{referenceStatusLabel(reference.status)}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (projectsApi === undefined) return;
                      void projectsApi.references
                        .remove({
                          referenceId: reference.id,
                          expectedRevision: reference.revision,
                        })
                        .then(() => refreshAfterReferenceMutation());
                    }}
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}
          {referenceError !== null && <p className="project-context-error">{referenceError}</p>}
        </section>
      )}

      <section className="project-context-section" aria-labelledby="context-manifest-title">
        <div className="project-context-section-head">
          <h3 id="context-manifest-title">Turn Context</h3>
          <select
            data-testid="context-turn-selector"
            aria-label="Contextを表示するTurn"
            value={selectedTurnId ?? ''}
            onChange={(event) => setSelectedTurnId(event.target.value || null)}
          >
            <option value="">最新のTurn</option>
            {(summaries ?? []).map((summary, index) => (
              <option key={summary.turnId} value={summary.turnId}>
                {index === 0 ? '最新 · ' : ''}
                {new Date(summary.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </div>
        {manifestError !== null ? (
          <p className="project-context-error" role="alert">
            {manifestError}
          </p>
        ) : manifest === null ? (
          <p className="insp-disconnected">
            {effectiveTurnId === null
              ? 'Context sealのあるTurnはまだありません。'
              : 'Contextを読み込んでいます…'}
          </p>
        ) : (
          <ManifestDetails manifest={manifest} projectName={projectName(manifest.projectId)} />
        )}
      </section>
    </div>
  );
}

function referenceStatusLabel(status: ProjectReference['status']): string {
  return {
    healthy: '✓ 正常',
    changed: '● 変更あり',
    missing: '! 見つかりません',
    unreadable: '! 読み取れません',
    workspace_changed: '! Workspace変更',
    too_large: '! 64 KiB超過',
    non_text: '! テキストではありません',
  }[status];
}

function ManifestDetails({
  manifest,
  projectName,
}: {
  manifest: ProjectContextManifest;
  projectName: string;
}) {
  return (
    <div className="context-manifest" data-testid="context-manifest">
      <dl>
        <div>
          <dt>Project</dt>
          <dd>{projectName}</dd>
        </div>
        <div>
          <dt>Epoch</dt>
          <dd>{manifest.projectContextEpoch ?? '—'}</dd>
        </div>
        <div>
          <dt>Candidate digest</dt>
          <dd>
            <code>{manifest.candidateSnapshotDigest}</code>
          </dd>
        </div>
        <div>
          <dt>Sealed digest</dt>
          <dd>
            <code>{manifest.sealedDigest}</code>
          </dd>
        </div>
      </dl>
      {manifest.items.length === 0 ? (
        <p className="insp-disconnected">このTurnにProject項目はありません。</p>
      ) : (
        <ol className="context-manifest-items">
          {manifest.items.map((item) => (
            <li key={item.itemId} data-included={item.included}>
              <div className="context-manifest-item-head">
                <strong>{item.kind}</strong>
                <span>
                  {item.included ? '採用' : `除外: ${item.exclusionReason ?? '理由なし'}`}
                </span>
              </div>
              <div className="context-manifest-item-meta">
                authority: {item.authority} · localOnly: {item.localOnly ? 'true' : 'false'}
              </div>
              {item.content !== null && <pre>{item.content}</pre>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
