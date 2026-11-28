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
        setTargets(await api.pairBlender(taskId, code.trim() || undefined));
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
            このTeamのWorkerは選んだメッシュを編集できます。ローカル接続には視点画像を渡し、対応する外部接続では画像ごとに送信を確認します。
          </p>
          <label className="settings-field" htmlFor={id}>
            <span className="settings-field-label">ペアリングコード（手入力の場合）</span>
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
                if (!pending) void changeConnection();
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
        onClick={() => void changeConnection()}
      >
        {pending
          ? '処理中…'
          : targets !== null
            ? '接続を解除'
            : code.trim() === ''
              ? 'コピーしたコードで接続'
              : '入力したコードで接続'}
      </button>
      {error !== null && (
        <p className="team-policy-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
