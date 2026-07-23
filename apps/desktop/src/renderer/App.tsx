import { useEffect } from 'react';
import './index.css';
import { useAppStore } from './store/appStore';
import { Sidebar } from './components/Sidebar';
import { TaskHeader } from './components/TaskHeader';
import { ChatSurface } from './components/ChatSurface/ChatSurface';
import { TeamListView } from './components/TeamListView';

export default function App() {
  const vibeAvailable = useAppStore((s) => s.vibeAvailable);
  const initialized = useAppStore((s) => s.initialized);
  const init = useAppStore((s) => s.init);
  const tasks = useAppStore((s) => s.tasks);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const createTask = useAppStore((s) => s.createTask);
  const teamViewOpen = useAppStore((s) => s.teamViewOpen);

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (initialized && !vibeAvailable) {
    return (
      <div className="app-shell app-shell--unavailable">
        <div className="unavailable-card" role="alert">
          <h1>Electron環境で起動してください</h1>
          <p>
            このUIはElectronアプリのRendererとして動作します。ブラウザから直接開いた場合、
            <code>window.vibe</code>{' '}
            が公開されないため、Taskの読み込みやメッセージ送信はできません。
          </p>
        </div>
      </div>
    );
  }

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        {selectedTask ? (
          <>
            <TaskHeader task={selectedTask} />
            {teamViewOpen ? (
              <TeamListView task={selectedTask} />
            ) : (
              <ChatSurface task={selectedTask} />
            )}
          </>
        ) : (
          <div className="empty-state" style={{ margin: 'auto' }}>
            <h2>Taskを選択してください</h2>
            <p>左のTask履歴から選ぶか、新しいTaskを作成して会話を始めます。</p>
            <div className="chips">
              <button
                type="button"
                className="chip"
                data-testid="empty-state-create-task-button"
                onClick={() => void createTask()}
              >
                ＋ 新しいTaskを作成
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
