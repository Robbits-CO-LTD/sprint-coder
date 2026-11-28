import { useEffect, useId, useState } from 'react';

export function TeamBlenderSettings({ taskId }: { taskId: string }) {
  const id = useId();
  const [targets, setTargets] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.sprintCoder?.teams.blenderStatus?.(taskId).then(
      (value) => {
        if (active) setTargets(value);
      },
      () => {
        if (active) setError('Blenderの接続状態を確認できませんでした。');
      },
    );
    return () => {
      active = false;
    };
  }, [taskId]);

  async function changeConnection() {
    const api = window.sprintCoder?.teams;
    if (api === undefined) return;
    setPending(true);
    setError(null);
    try {
      if (targets === null) {
        setTargets(await api.pairBlender(taskId, code));
        setCode('');
      } else {
        await api.disconnectBlender(taskId);
        setTargets(null);
      }
    } catch {
      setError(
        targets === null
          ? '接続できませんでした。Blenderでペアリングを開始し、コードを確認してください。'
          : 'Blenderとの接続を解除できませんでした。',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <fieldset className="settings-group settings-fieldset" disabled={pending}>
      <legend>Blender</legend>
      {targets === null ? (
        <>
          <p className="settings-hint" id={`${id}-hint`}>
            Blenderでメッシュを選び、Teamパネルでペアリングを開始してコードをコピーします。
            このTeamのWorkerは選んだメッシュを編集でき、視点画像は利用中のAIに送られます。
          </p>
          <label className="settings-field" htmlFor={id}>
            <span className="settings-field-label">ペアリングコード</span>
            <input
              id={id}
              type="password"
              className="settings-text-input"
              spellCheck={false}
              autoComplete="off"
              aria-describedby={`${id}-hint`}
              maxLength={100}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                if (code.trim() !== '' && !pending) void changeConnection();
              }}
            />
          </label>
        </>
      ) : (
        <p className="settings-hint" role="status">
          {targets.length}個のメッシュに接続中 · {targets.join('、')}
        </p>
      )}
      <button
        type="button"
        className="settings-secondary-button"
        disabled={targets === null && code.trim() === ''}
        onClick={() => void changeConnection()}
      >
        {pending ? '処理中…' : targets === null ? 'このTeamに接続' : '接続を解除'}
      </button>
      {error !== null && (
        <p className="team-policy-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
