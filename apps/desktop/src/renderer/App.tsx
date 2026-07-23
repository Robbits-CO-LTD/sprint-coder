import { useEffect } from 'react';
import './index.css';
import { useAppStore } from './store/appStore';
import { Sidebar } from './components/Sidebar';
import { TaskHeader } from './components/TaskHeader';
import { ChatSurface } from './components/ChatSurface/ChatSurface';
import { TeamCanvas } from './components/TeamCanvas/TeamCanvas';

export default function App() {
  const sprintCoderAvailable = useAppStore((s) => s.sprintCoderAvailable);
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

  if (initialized && !sprintCoderAvailable) {
    return (
      <div className="app-shell app-shell--unavailable">
        <div className="unavailable-card" role="alert">
          <h1>Electron環境で起動してください</h1>
          <p>
            このUIはElectronアプリのRendererとして動作します。ブラウザから直接開いた場合、
            <code>window.sprintCoder</code>{' '}
            が公開されないため、Taskの読み込みやメッセージ送信はできません。
          </p>
        </div>
      </div>
    );
  }

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;
  // Team mode promotes the chat into the spatial Canvas (demo/index.html `.team-mode`). Sidebar
  // and the main chat column stay mounted (so their CSS fade-out transitions play) but the main
  // column's ChatSurface is swapped for an inert placeholder — the same ChatSurface instance is
  // instead rendered inside the Canvas world as the Leader node, so it is never double-mounted.
  const inTeamMode = teamViewOpen && selectedTask !== null;

  return (
    <div className={`app-shell${inTeamMode ? ' team-mode' : ''}`}>
      <Sidebar />
      <div className="main">
        {selectedTask ? (
          <>
            <TaskHeader task={selectedTask} />
            {inTeamMode ? <div className="surface-placeholder" /> : <ChatSurface task={selectedTask} />}
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
      {inTeamMode && selectedTask && <TeamCanvas task={selectedTask} />}
    </div>
  );
}
