import { useEffect, useRef, useState } from 'react';
import type { Project, ProjectDefaultAccess } from '@sprint-coder/contracts';
import { Trash } from './icons';

const ACCESS_LABEL: Record<ProjectDefaultAccess, string> = {
  ask: '確認する',
  auto: '安全時は自動',
};

const ACCESS_DESC: Record<ProjectDefaultAccess, string> = {
  ask: '権限が必要な操作は毎回確認します',
  auto: '安全と証明できた操作だけ自動許可します',
};

/**
 * The Project list: every folder root that has been used as a Workspace, and the access preset a
 * new Task in that folder starts at.
 *
 * Modelled on Codex's `[projects."/abs/path"]` config table — the list is not curated by hand, it is
 * whatever folders have actually been worked in, and the one setting per row is how far the user
 * trusts work done there.
 *
 * `full` is intentionally absent from the options. It is reachable only per-Task, behind the
 * confirmation dialog in main's `permissionsSet` handler; a folder default that could grant it would
 * be a way to widen every future Task without that dialog ever appearing.
 */
export function ProjectSettingsSection({ active }: { active: boolean }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [pendingForget, setPendingForget] = useState<string | null>(null);
  const [wasActive, setWasActive] = useState(active);
  const generation = useRef(0);
  /** In-flight guard as a ref, not state: the effect has to check it *and* set it, and setting
   * state synchronously inside an effect is what react-hooks/set-state-in-effect forbids. Nothing
   * renders off it — "loading" is simply `projects === null` — so it owes no re-render. */
  const inFlight = useRef(false);
  /** Read during render, not in an effect: it is a plain property read on `window`, and having it
   * here lets the unavailable case be a rendered branch rather than a state write. */
  const api = projectApi();

  // Closing the dialog drops the confirmation, so reopening never lands on a half-armed delete.
  // Done as a render-time adjustment rather than an effect (react-hooks/set-state-in-effect), the
  // same way TaskHeader keeps its rename draft in sync.
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setPendingForget(null);
  }

  // Written inline rather than as a function the effect calls, so every state write lands after the
  // awaited IPC round-trip instead of during the commit.
  useEffect(() => {
    if (!active || projects !== null || inFlight.current || api === null) return;
    const request = ++generation.current;
    inFlight.current = true;
    void api
      .list()
      .then((list) => {
        if (request === generation.current) setProjects(list);
      })
      .catch(() => {
        if (request === generation.current)
          setError('Project一覧を取得できませんでした。設定を開き直してください。');
      })
      .finally(() => {
        if (request === generation.current) inFlight.current = false;
      });
  }, [active, api, projects]);

  async function setAccess(project: Project, defaultAccess: ProjectDefaultAccess): Promise<void> {
    if (api === null) return;
    setError(null);
    try {
      const updated = await api.setDefaultAccess(project.id, defaultAccess);
      setProjects((current) =>
        (current ?? []).map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      setStatus(`${updated.name} の既定アクセスを「${ACCESS_LABEL[defaultAccess]}」にしました。`);
    } catch {
      setError('既定アクセスを変更できませんでした。');
    }
  }

  async function forget(project: Project): Promise<void> {
    if (api === null) return;
    setError(null);
    setPendingForget(null);
    try {
      await api.forget(project.id);
      setProjects((current) => (current ?? []).filter((entry) => entry.id !== project.id));
      setStatus(`${project.name} を一覧から削除しました。Taskとフォルダはそのままです。`);
    } catch {
      setError('Projectを削除できませんでした。');
    }
  }

  return (
    <div className="settings-group" data-testid="settings-projects">
      <span className="settings-field-label">Project</span>
      <p className="settings-hint">
        Workspaceに選んだフォルダを記憶します。そのフォルダで新しくTaskを始めたとき、ここで決めた既定アクセスから開始します。
      </p>

      {error !== null && <p className="settings-skill-error">{error}</p>}

      {api === null ? (
        <p className="settings-hint" data-testid="settings-projects-unsupported">
          このバージョンのバックエンドはProjectに未対応です。
        </p>
      ) : projects === null ? (
        <p className="settings-hint">読み込み中…</p>
      ) : projects.length === 0 ? (
        <p className="settings-hint" data-testid="settings-projects-empty">
          まだありません。ComposerからWorkspaceを選ぶと、そのフォルダがここに追加されます。
        </p>
      ) : (
        <ul className="settings-projects">
          {projects.map((project) => (
            <li key={project.id} className="settings-project" data-testid="settings-project">
              <div className="settings-project-head">
                <span className="settings-project-name">{project.name}</span>
                <span className="settings-project-count">
                  {project.taskCount > 0 ? `${project.taskCount}件のTask` : 'Taskなし'}
                </span>
                <button
                  type="button"
                  className="settings-project-forget"
                  aria-label={`${project.name} を一覧から削除`}
                  title="一覧から削除（Taskとフォルダは消えません）"
                  onClick={() => setPendingForget(project.id)}
                >
                  <Trash size={13} />
                </button>
              </div>
              {/* The full path, not just the basename: two checkouts of the same repo produce two
                  Projects with identical names, and the path is the only thing that tells them
                  apart — it is also the row's real identity, exactly as in Codex's config. */}
              <span className="settings-project-path" title={project.rootPath}>
                {project.rootPath}
              </span>
              <div className="settings-project-access">
                {(['ask', 'auto'] as const).map((access) => (
                  <label
                    key={access}
                    className={`settings-radio${project.defaultAccess === access ? ' active' : ''}`}
                  >
                    <input
                      type="radio"
                      name={`project-access-${project.id}`}
                      checked={project.defaultAccess === access}
                      onChange={() => void setAccess(project, access)}
                    />
                    <span className="settings-radio-text">
                      <span className="settings-radio-title">{ACCESS_LABEL[access]}</span>
                      <span className="settings-radio-desc">{ACCESS_DESC[access]}</span>
                    </span>
                  </label>
                ))}
              </div>
              {pendingForget === project.id && (
                <div className="permission-confirm" data-testid="settings-project-confirm">
                  <span className="runtime-menu-desc">
                    一覧から削除します。このフォルダのTaskも、フォルダ自体も残ります。次にここで
                    Taskを始めたときは既定の「{ACCESS_LABEL.ask}」から始まります。
                  </span>
                  <button
                    type="button"
                    className="permission-confirm-action"
                    onClick={() => void forget(project)}
                  >
                    削除する
                  </button>
                  <button
                    type="button"
                    className="permission-confirm-cancel"
                    onClick={() => setPendingForget(null)}
                  >
                    キャンセル
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <span className="sr-only" role="status">
        {status}
      </span>
    </div>
  );
}

/** Null when the backend predates Projects. This file's contract (types/sprint-coder.d.ts) requires
 * renderer code to feature-detect the optional surfaces rather than assume them. */
function projectApi(): NonNullable<NonNullable<Window['sprintCoder']>['projects']> | null {
  return window.sprintCoder?.projects ?? null;
}
