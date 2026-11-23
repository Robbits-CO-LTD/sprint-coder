// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  skillSourceSchema,
  type SkillCatalogItem,
  type TurnSkillSelection,
} from '@sprint-coder/contracts';
import { Composer } from './Composer';
import { useAppStore } from '../../store/appStore';
import { mentionText, presentSkillDraft, skillMentions } from './skill-mentions';

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
  expect(text).toBe('本文 $created:outline $agents:outline ');
  expect(presentSkillDraft(text, selections).mentions.map((m) => m.selection)).toEqual(selections);
  expect(mentionText(first.ref, [first.ref])).toBe('$outline');
  expect(presentSkillDraft('$review is literal', []).mentions).toHaveLength(0);
});
it('reads qualified mentions from every contracted source and leaves unknown qualifiers literal', () => {
  const selections = skillSourceSchema.options.map((source) => item('review', source));
  const refs = selections.map(({ ref }) => ref);
  for (const skill of selections) {
    const token = mentionText(skill.ref, refs);
    expect(skillMentions(token + '.', selections)).toEqual([
      { start: 0, end: token.length, selection: skill },
    ]);
    expect(
      skillMentions(
        token,
        selections.filter((other) => other !== skill),
      ),
    ).toEqual([]);
  }
  expect(skillMentions('$unknown:review', [...selections, item('unknown', 'created')])).toEqual([]);
});
const taskId = 'inline-skills';
const completedReply = {
  id: 'reply',
  taskId,
  turnId: 'previous-turn',
  author: 'assistant' as const,
  attachments: [],
  createdAt: '2026-11-22T00:00:00Z',
};

it('continues the same conversation with the enabled Skill the user approves', async () => {
  const creator = item('skill-creator', 'builtin');
  await withComposer('', [creator], [], async ({ container, send }) => {
    const button = () =>
      [...container.querySelectorAll('button')].find(
        (element) => element.textContent === 'builtin/skill-creator を使って続ける',
      );
    await act(async () =>
      useAppStore.setState({
        messagesByTask: {
          [taskId]: [{ ...completedReply, content: '使用するSkill「builtin/skill-creator」' }],
        },
        skillCatalog: [{ ...creator, enabled: false }],
      }),
    );
    expect(button()).toBeUndefined();
    await act(async () => useAppStore.setState({ skillCatalog: [creator] }));
    expect(send).not.toHaveBeenCalled();
    await act(async () => button()!.click());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        skills: [{ kind: creator.kind, ref: creator.ref }],
      }),
    );
  });
});

it('waits for a folder selection before resuming a folderless chat', async () => {
  await withComposer('', [], [], async ({ container, send }) => {
    const select = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ name: 'demo', path: '/demo' });
    Object.assign(window.sprintCoder!, { workspace: { select } });
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find((element) => element.textContent === label);
    await act(async () =>
      useAppStore.setState({
        messagesByTask: {
          [taskId]: [{ ...completedReply, content: '作業フォルダーを選んでください。' }],
        },
      }),
    );
    await act(async () => button('作業フォルダーを選ぶ')!.click());
    expect(button('この作業フォルダーで続ける')).toBeUndefined();
    await act(async () => button('作業フォルダーを選ぶ')!.click());
    expect(select).toHaveBeenCalledWith(taskId);
    expect(send).not.toHaveBeenCalled();
    await act(async () => button('この作業フォルダーで続ける')!.click());
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ taskId, skills: [] }));
  });
});
const teamDraft = '/team リポジトリを並列調査して';
const firstSelection = { kind: first.kind, ref: first.ref };

async function withComposer(
  draft: string,
  catalog: SkillCatalogItem[],
  selections: TurnSkillSelection[],
  check: (ui: {
    container: HTMLElement;
    textarea: HTMLTextAreaElement;
    send: ReturnType<typeof vi.fn>;
    key: (key: string) => Promise<void>;
    showCaret: (offset: number) => Promise<void>;
    change: (value: string, offset: number, inputType?: string) => Promise<void>;
  }) => Promise<void>,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(callback, 0),
  );
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
      draftByTask: { [taskId]: draft },
      skillSelectionByTask: { [taskId]: selections },
      skillCatalog: catalog,
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
      await act(async () => {
        textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    };
    const key = async (key: string) => {
      await act(async () => {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
      });
    };
    const change = async (value: string, offset: number, inputType = 'insertText') => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          textarea,
          value,
        );
        textarea.setSelectionRange(offset, offset);
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
      });
    };
    await check({ container, textarea, send, showCaret, key, change });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState(), true);
    Reflect.deleteProperty(window, 'sprintCoder');
    vi.unstubAllGlobals();
  }
}
it.each(['both', 'remove', 'ime', 'legacy-team'])(
  'submits the expected text and Skill bindings for %s',
  async (scenario) => {
    await withComposer(
      scenario === 'legacy-team' ? teamDraft : '先に $out 本文',
      [first, second],
      scenario === 'legacy-team' ? [firstSelection] : [],
      async ({ container, textarea, send, showCaret, key, change }) => {
        if (scenario === 'legacy-team') {
          expect(textarea.value).toBe(teamDraft + ' $outline ');
          await showCaret(textarea.value.length);
          await key('Enter');
          expect(send).toHaveBeenCalledWith(
            expect.objectContaining({ text: teamDraft, skills: [firstSelection] }),
          );
          return;
        }
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
        if (scenario === 'ime') {
          const compose = (type: string) =>
            act(async () => textarea.dispatchEvent(new CompositionEvent(type, { bubbles: true })));
          await compose('compositionstart');
          await change('先に $outlined 本文 $review ', '先に $outlined'.length);
          expect(textarea.value).toBe('先に $outlined 本文 $review ');
          expect(useAppStore.getState().skillSelectionByTask[taskId]).toEqual(picked);
          await change('先に $outlineで 本文 $review ', '先に $outlineで'.length);
          await compose('compositionend');
          await key('Enter');
          expect(send).toHaveBeenCalledWith(
            expect.objectContaining({ text: '先に $outlineで 本文 $review ', skills: picked }),
          );
          return;
        }
        const removeFirst = scenario === 'remove';
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
      },
    );
  },
);

it('converts two typed aliases at the edit position and sends both pinned Skills', async () => {
  await withComposer(
    '先に  本文',
    [first, second],
    [],
    async ({ textarea, change, key, send, container }) => {
      let caret = '先に '.length;
      for (const ch of '&outline &review') {
        const next = textarea.value.slice(0, caret) + ch + textarea.value.slice(caret);
        await change(next, ++caret);
      }
      expect(textarea.value).toBe('先に $outline $review 本文');
      expect(textarea.selectionStart).toBe(caret);
      expect(
        [...container.querySelectorAll('.composer-skill-mention')].map((el) => el.textContent),
      ).toEqual(['$outline', '$review']);
      await key('Enter');
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '先に $outline $review 本文',
          skills: [firstSelection, { kind: second.kind, ref: second.ref }],
        }),
      );
    },
  );
});
it('defers shared prefixes and respects source ambiguity, availability and the selection limit', async () => {
  const duplicate = item('outline', 'builtin');
  const disabled = { ...item('off', 'created'), enabled: false };
  const blocked = item('blocked', 'created');
  for (const rt of ['codex', 'provider', 'claude', 'grok'] as const)
    blocked.compatibility.runtimeSupport[rt] = 'blocked';
  const longer = item('review-pr', 'created');
  const catalog = [first, duplicate, second, longer, disabled, blocked];
  await withComposer('', catalog, [], async ({ change, textarea }) => {
    for (const raw of [
      '&missing',
      '&outline',
      '&off',
      '&blocked',
      '&review',
      'https://x/?q=1&review',
    ]) {
      await change(raw, raw.length);
      expect(textarea.value).toBe(raw);
      expect(useAppStore.getState().skillSelectionByTask[taskId]).toEqual([]);
    }
    await change('&review-pr', 10);
    expect(textarea.value).toBe('$review-pr');
    await change('&review ', 8);
    expect(textarea.value).toBe('$review ');
    await change('&review-pr', 10, 'insertFromPaste');
    expect(textarea.value).toBe('&review-pr');
    expect(useAppStore.getState().skillSelectionByTask[taskId]).toEqual([]);
  });
  const selected = Array.from({ length: 5 }, (_, i) => item('picked-' + i, 'created'));
  const raw = selected.map((s) => '$' + s.ref.skillId).join(' ') + ' &review';
  await withComposer(
    raw.slice(0, -1),
    [...selected, second],
    selected.map(({ kind, ref }) => ({ kind, ref })),
    async ({ change, textarea }) => {
      await change(raw, raw.length);
      expect(textarea.value).toBe(raw);
      expect(useAppStore.getState().skillSelectionByTask[taskId]).toHaveLength(5);
    },
  );
});

it('keeps the source of a same-name Skill pinned before a catalog change', async () => {
  const older = item('review', 'created');
  const raw = '$review &review';
  await withComposer(
    '$review &revie',
    [second],
    [{ kind: older.kind, ref: older.ref }],
    async ({ change, textarea, send, key }) => {
      await change(raw, raw.length);
      expect(textarea.value).toBe('$review $agents:review');
      expect(textarea.selectionStart).toBe(textarea.value.length);
      await key('Enter');
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          skills: [
            { kind: older.kind, ref: older.ref },
            { kind: second.kind, ref: second.ref },
          ],
        }),
      );
    },
  );
});

it('keeps the selected Skill and sends punctuation after its inline name', async () => {
  await withComposer(
    '',
    [{ ...second, description: 'Run a review.' }],
    [],
    async ({ change, textarea, key, send, container }) => {
      await change('&review', 7);
      await change('$review.', 8);
      expect(container.querySelector('.composer-skill-mention')?.textContent).toBe('$review');
      expect(textarea.value).toBe('$review.');
      await key('Enter');
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '$review.',
          skills: [{ kind: second.kind, ref: second.ref }],
        }),
      );
    },
  );
});
