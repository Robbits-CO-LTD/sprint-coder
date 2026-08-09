import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { writeSetupComplete } from '../lib/setup-preference';
import { ArrowLeft, ArrowRight, Check, Folder, Settings } from './icons';
import { SetupAnimation } from './SetupAnimation';

const STEP_LABELS = ['ようこそ', 'AI', 'Workspace', '完了'] as const;

type PickedFolder = { path: string; label: string };

function readinessLabel(readiness: 'ready' | 'authentication_required' | 'unavailable'): string {
  if (readiness === 'ready') return '接続済み';
  if (readiness === 'authentication_required') return 'ログインが必要';
  return '未検出';
}

export function SetupWizard({ onOpenSettings }: { onOpenSettings: () => void }) {
  const runtime = useAppStore((state) => state.runtime);
  const createTask = useAppStore((state) => state.createTask);
  const createProject = useAppStore((state) => state.createProject);
  const pickProjectFolders = useAppStore((state) => state.pickProjectFolders);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  const moveTo = useCallback(
    (next: number) => {
      setDirection(next > step ? 'forward' : 'back');
      setError(null);
      setStep(next);
    },
    [step],
  );

  const chooseFolder = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await pickProjectFolders();
      if (!picked.canceled && picked.folders[0]) setFolder(picked.folders[0]);
    } finally {
      setBusy(false);
    }
  }, [pickProjectFolders]);

  const continueFromWorkspace = useCallback(async () => {
    if (folder === null) {
      moveTo(3);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await createProject(folder.label, [
        { path: folder.path, label: folder.label, role: 'primary' },
      ]);
      if (project === null) {
        setError('Projectを作成できませんでした。フォルダを確認して、もう一度お試しください。');
        return;
      }
      setProjectId(project.id);
      moveTo(3);
    } finally {
      setBusy(false);
    }
  }, [createProject, folder, moveTo]);

  const finish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const task = await createTask(projectId);
      if (task === null) {
        setError('最初のTaskを作成できませんでした。もう一度お試しください。');
        return;
      }
      writeSetupComplete();
    } finally {
      setBusy(false);
    }
  }, [createTask, projectId]);

  return (
    <main className="setup-wizard" data-testid="setup-wizard" aria-labelledby="setup-title">
      <div className="setup-visual">
        <div className="setup-visual-halo" />
        <SetupAnimation step={step} />
        <p className="setup-visual-caption">
          <span>SPRINT / 0{step + 1}</span>
          <span>{STEP_LABELS[step]}</span>
        </p>
      </div>

      <section className="setup-content">
        <header className="setup-progress" aria-label={`セットアップ ${step + 1} / 4`}>
          <span className="setup-wordmark">SPRINT CODER</span>
          <ol>
            {STEP_LABELS.map((label, index) => (
              <li
                key={label}
                className={index <= step ? 'is-reached' : ''}
                aria-current={index === step ? 'step' : undefined}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                <i />
              </li>
            ))}
          </ol>
        </header>

        <div key={step} className={`setup-step setup-step--${direction}`}>
          {step === 0 && (
            <>
              <p className="setup-kicker">MAKE MOMENTUM</p>
              <h1 id="setup-title" ref={headingRef} tabIndex={-1}>
                アイデアから、
                <br />
                動くコードまで。
              </h1>
              <p className="setup-lead">
                Sprint
                Coderは、あなたとAIの仕事場をひとつにつなぎます。最初のスプリントを、約1分で準備しましょう。
              </p>
              <button type="button" className="setup-primary" onClick={() => moveTo(1)}>
                セットアップを始める <ArrowRight size={16} />
              </button>
            </>
          )}

          {step === 1 && (
            <>
              <p className="setup-kicker">CONNECT INTELLIGENCE</p>
              <h1 id="setup-title" ref={headingRef} tabIndex={-1}>
                使うAIを確認
              </h1>
              <p className="setup-lead">
                インストール済みのCLIは自動で見つかります。API接続は設定から追加できます。
              </p>
              <div className="setup-runtime-list">
                <div>
                  <span className={`setup-status setup-status--${runtime.codexReadiness}`} />
                  <strong>Codex</strong>
                  <small>{readinessLabel(runtime.codexReadiness)}</small>
                </div>
                <div>
                  <span className={`setup-status setup-status--${runtime.claudeReadiness}`} />
                  <strong>Claude Code</strong>
                  <small>{readinessLabel(runtime.claudeReadiness)}</small>
                </div>
              </div>
              <button type="button" className="setup-secondary" onClick={onOpenSettings}>
                <Settings size={15} /> 接続を設定
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <p className="setup-kicker">SET THE BOUNDARY</p>
              <h1 id="setup-title" ref={headingRef} tabIndex={-1}>
                作業場所を選ぶ
              </h1>
              <p className="setup-lead">
                Projectのルートをひとつ選びます。AIが扱う範囲は、あとからいつでも変更できます。
              </p>
              <button
                type="button"
                className={`setup-folder ${folder ? 'is-selected' : ''}`}
                onClick={() => void chooseFolder()}
                disabled={busy}
              >
                <Folder size={19} />
                <span>
                  <strong>{folder?.label ?? 'フォルダを選択'}</strong>
                  <small>{folder?.path ?? '既存のリポジトリや新しい作業フォルダ'}</small>
                </span>
                {folder && <Check size={17} />}
              </button>
            </>
          )}

          {step === 3 && (
            <>
              <p className="setup-kicker">READY TO SPRINT</p>
              <h1 id="setup-title" ref={headingRef} tabIndex={-1}>
                準備できました。
              </h1>
              <p className="setup-lead">
                あとは、やりたいことをそのまま書くだけ。計画から実装まで、会話を止めずに進められます。
              </p>
              <div className="setup-ready-list">
                <span>
                  <Check size={14} /> AIランタイムを確認
                </span>
                <span>
                  <Check size={14} /> {projectId ? 'Workspaceを接続' : 'Workspaceはあとで設定'}
                </span>
              </div>
              <button
                type="button"
                className="setup-primary"
                onClick={() => void finish()}
                disabled={busy}
              >
                {busy ? 'Taskを準備中…' : '最初のTaskを始める'} <ArrowRight size={16} />
              </button>
            </>
          )}

          {error && (
            <p className="setup-error" role="alert">
              {error}
            </p>
          )}
        </div>

        {step > 0 && step < 3 && (
          <footer className="setup-actions">
            <button
              type="button"
              className="setup-back"
              onClick={() => moveTo(step - 1)}
              disabled={busy}
            >
              <ArrowLeft size={15} /> 戻る
            </button>
            <button
              type="button"
              className="setup-next"
              onClick={() => (step === 2 ? void continueFromWorkspace() : moveTo(step + 1))}
              disabled={busy}
            >
              {step === 2 && folder === null ? 'あとで設定' : '続ける'} <ArrowRight size={15} />
            </button>
          </footer>
        )}
      </section>
    </main>
  );
}
