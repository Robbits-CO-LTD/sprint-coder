// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type CommandResult, type SprintCoderApi } from '@sprint-coder/contracts';
import { IpcRouter } from '../../main/ipc';
import { SkillSettingsService } from '../../main/skill-settings-service';
import { useAppStore } from '../store/appStore';
import { SkillDraftCard } from './SkillDraftCard';

const bridge = vi.hoisted(() => ({
  expose: vi.fn(),
  handle: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  clipboard: {},
  contextBridge: { exposeInMainWorld: bridge.expose },
  dialog: {},
  globalShortcut: {},
  ipcMain: { handle: bridge.handle, on: vi.fn() },
  ipcRenderer: { invoke: bridge.invoke },
  MessageChannelMain: class {},
  nativeImage: {},
  safeStorage: {},
  screen: {},
  session: {},
  shell: {},
  utilityProcess: {},
}));

await import('../../preload/index');
const api: SprintCoderApi = bridge.expose.mock.calls[0]![1];
const initial = useAppStore.getState();
afterEach(() => {
  useAppStore.setState(initial, true);
  vi.unstubAllGlobals();
});

const syntheticSkill = {
  kind: 'chat' as const,
  skillId: 'qa-draft',
  files: [
    {
      path: 'SKILL.md',
      content:
        '---\nname: qa-draft\ndescription: Synthetic QA Skill.\n---\n\n# Draft\nWrite a summary.',
    },
  ],
};

it.each([
  [
    'install',
    IPC_CHANNELS.skillsInstallDraft,
    'OPERATION_CONFLICT',
    '同名のSkillが既に存在します。',
    '同名のSkillが既に存在します。',
  ],
  [
    'discard',
    IPC_CHANNELS.skillsDiscardDraft,
    'NOT_FOUND',
    'Skill Draftが見つかりません',
    '対象が見つかりません。再読み込みしてください。',
  ],
] as const)(
  'shows the real %s failure inside the Skill draft card',
  async (action, channel, code, reason, shown) => {
    const home = await mkdtemp(join(tmpdir(), 'sprint-coder-skill-card-ipc-'));
    const service = new SkillSettingsService({ homePath: home });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      const draft = await service.createDraft(syntheticSkill);
      if (action === 'install') {
        const other = await service.createDraft(syntheticSkill);
        await service.installDraft(other.id, other.digest);
      } else {
        await service.discardDraft(draft.id);
      }

      const frame = {
        url: 'http://localhost:5173/',
        get top(): object {
          return frame;
        },
      };
      const event = { sender: { id: 1 }, senderFrame: frame };
      const replies: CommandResult<unknown>[] = [];
      const handlers = new Map<
        string,
        (sender: typeof event, envelope: unknown) => Promise<CommandResult<unknown>>
      >();
      bridge.handle.mockImplementation((name, handler) => handlers.set(name, handler));
      bridge.invoke.mockImplementation(async (name, envelope) => {
        const handler = handlers.get(name);
        if (!handler) throw new Error('IPC handler not registered');
        const result = await handler(event, envelope);
        replies.push(result);
        return result;
      });

      // Only Electron transport is simulated. Sender validation, IPC envelopes, the preload
      // rejection, the service's real disk state and the React card all use product code.
      const router: IpcRouter = Object.assign(Object.create(IpcRouter.prototype), {
        skillSettings: service,
        trustedRendererOrigin: 'http://localhost:5173',
        window: { webContents: { id: 1, once: vi.fn() } },
      });
      router.register();
      vi.stubGlobal('sprintCoder', api);
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const onInstall = vi.fn(() => useAppStore.getState().installSkillDraft(draft));
      const onDiscard = vi.fn(() => useAppStore.getState().discardSkillDraft(draft.id));
      const runAction = action === 'install' ? onInstall : onDiscard;
      const otherAction = action === 'install' ? onDiscard : onInstall;
      await act(async () =>
        root.render(<SkillDraftCard draft={draft} onInstall={onInstall} onDiscard={onDiscard} />),
      );
      if (action === 'install') {
        const details = container.querySelector('details')!;
        await act(async () => {
          details.open = true;
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      const button = [...container.querySelectorAll('button')].find(
        (item) => item.textContent === (action === 'install' ? 'インストール' : '破棄'),
      )!;
      expect(button.disabled).toBe(false);
      await act(async () => {
        button.click();
        expect(runAction).toHaveBeenCalledOnce();
        expect(otherAction).not.toHaveBeenCalled();
        await expect(runAction.mock.results[0]?.value).rejects.toMatchObject({ code });
      });
      expect(bridge.invoke).toHaveBeenLastCalledWith(channel, expect.anything());
      expect(replies).toEqual([
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code, userMessage: reason }),
        }),
      ]);
      expect(container.querySelector('.skill-draft-card [role="alert"]')?.textContent).toContain(
        shown,
      );
      expect(button.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      await rm(home, { recursive: true, force: true });
    }
  },
);
