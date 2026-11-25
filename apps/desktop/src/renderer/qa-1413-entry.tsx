import { createRoot } from 'react-dom/client';
import { qa1413FixtureSchema } from '../qa-1413';
import { Timeline } from './components/ChatSurface/Timeline';
import { useAppStore } from './store/appStore';
import './index.css';
import './themes.css';
import './sidebar.css';
import './fonts.css';

const fixtures = import.meta.glob('./qa-1413-generated.json', { eager: true, import: 'default' });
const fixture = qa1413FixtureSchema.parse(fixtures['./qa-1413-generated.json']);
const container = document.getElementById('root');
if (!container) throw new Error('QA root is missing');
const root = createRoot(container);
void (async () => {
  try {
    if (!window.sprintCoder) throw new Error('The Electron preload is unavailable');
    const messages = await window.sprintCoder.tasks.messages(fixture.taskId);
    useAppStore.setState({
      selectedTaskId: fixture.taskId,
      messagesByTask: { [fixture.taskId]: messages },
      skillDraftsByTask: {
        [fixture.taskId]: [fixture.conflict, fixture.missing].map((draft) => ({
          turnId: fixture.turnId,
          draft,
        })),
      },
    });
    root.render(
      <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
        <h1 style={{ fontSize: '1rem', margin: '12px 24px' }}>QA #1413 下書きカードの失敗理由</h1>
        <Timeline taskId={fixture.taskId} />
      </main>,
    );
  } catch {
    root.render(<p role="alert">検証用のチャット履歴を開けませんでした。</p>);
  }
})();
