// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SkillCatalogItem } from '@sprint-coder/contracts';
import { Composer } from './Composer';
import { useAppStore } from '../../store/appStore';
import { mentionText, presentSkillDraft } from './skill-mentions';

function item(id: string, source: SkillCatalogItem['ref']['source']): SkillCatalogItem {
  return {
    ref: { skillId: id, source, digest: 'a'.repeat(64) },
    name: id,
    description: id,
    kind: 'chat',
    enabled: true,
    removable: false,
    exportable: false,
    activationPolicy: 'manual',
    compatibility: {
      profile: 'portable',
      runtimeSupport: { codex: 'full', claude: 'full', grok: 'full', provider: 'full' },
      features: [],
      requestedTools: [],
      warnings: [],
      blockers: [],
      requiresConversion: false,
      nativeModeConsentRequired: false,
    },
  };
}
const first = item('outline', 'created');
const second = item('review', 'agents');
it('restores old drafts and distinguishes same-name skills from different sources', () => {
  const other = item('outline', 'agents');
  const selections = [first, other].map(({ ref, kind }) => ({ ref, kind }));
  const text = presentSkillDraft('本文', selections).text;
  expect(text).toBe('$created:outline $agents:outline 本文');
  expect(presentSkillDraft(text, selections).mentions.map((m) => m.selection)).toEqual(selections);
  expect(mentionText(first.ref, [first.ref])).toBe('$outline');
  expect(presentSkillDraft('$review is literal', []).mentions).toHaveLength(0);
});
it.each([false, true])(
  'selects multiple mentions at the caret and submits their bindings (remove first: %s)',
  async (removeFirst) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(callback, 0),
    );
    const taskId = 'inline-skills';
    const send = vi.fn().mockResolvedValue({ turnId: 'accepted' });
    const saveSkills = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'sprintCoder', {
      configurable: true,
      value: {
        tasks: { setDraft: vi.fn().mockResolvedValue(undefined) },
        skills: { setDraftSelection: saveSkills },
        turns: { start: send },
      },
    });
    useAppStore.setState(
      {
        ...useAppStore.getInitialState(),
        selectedTaskId: taskId,
        draftByTask: { [taskId]: '先に $out 本文' },
        skillCatalog: [first, second],
        skillCatalogRevision: '1',
        permissionByTask: { [taskId]: { preset: 'ask', policyEpoch: 0 } },
      },
      true,
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Composer taskId={taskId} />));
      const textarea = container.querySelector('textarea')!;
      const showCaret = async (offset: number) => {
        textarea.setSelectionRange(offset, offset);
        await act(async () => textarea.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      };
      const key = async (key: string) =>
        act(async () =>
          textarea.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
          ),
        );
      const change = async (value: string, offset: number) => {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
            textarea,
            value,
          );
          textarea.setSelectionRange(offset, offset);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
      };
      await showCaret('先に $out'.length);
      expect(container.querySelector('[data-testid="slash-command-goal"]')).toBeNull();
      await key('Tab');
      expect(textarea.value).toBe('先に $outline 本文');
      await change(textarea.value + ' /rev', (textarea.value + ' /rev').length);
      await key('Enter');
      expect(textarea.value).toBe('先に $outline 本文 $review ');
      expect(
        [...container.querySelectorAll('.composer-skill-mention')].map((el) => el.textContent),
      ).toEqual(['$outline', '$review']);
      const picked = useAppStore.getState().skillSelectionByTask[taskId];
      expect(picked?.map((s) => s.ref)).toEqual([first.ref, second.ref]);
      if (removeFirst) {
        await showCaret('先に $outline'.length);
        await key('Backspace');
        expect(textarea.value).toBe('先に  本文 $review ');
        expect(container.querySelectorAll('.composer-skill-mention')).toHaveLength(1);
      }
      await key('Enter');
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          text: removeFirst ? '先に  本文 $review ' : '先に $outline 本文 $review ',
          skills: removeFirst ? [{ kind: 'chat', ref: second.ref }] : picked,
        }),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useAppStore.setState(useAppStore.getInitialState(), true);
      Reflect.deleteProperty(window, 'sprintCoder');
      vi.unstubAllGlobals();
    }
  },
);
