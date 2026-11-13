import type { AssistantPreferences } from './setup-settings';

// The sample reply in the Setup's "返事の仕方" step. Fixed text kept in the renderer — the AI is
// never called. Tone × length gives the nine base answers; the explanation style then inserts one
// sentence (a reason, or a plain comparison) right after the opening sentence, so all 27
// combinations read naturally without writing 27 texts.

type Tone = AssistantPreferences['tone'];
type Length = AssistantPreferences['length'];
type Depth = AssistantPreferences['depth'];

export const SETUP_PREVIEW_QUESTION = '保存ボタンを押しても、何も起きないみたい。直せる？';

/** [opening sentence, ...the rest] for each tone and length. */
const BASE: Record<Tone, Record<Length, readonly string[]>> = {
  polite: {
    short: ['ボタンと、押したときの動きがつながっていないようです。', 'つなぎ直しますね。'],
    balanced: [
      '原因は、ボタンと押したときの動きがつながっていないことのようです。',
      'つなぎ直して、押すと保存されるようにしますね。',
    ],
    detailed: [
      '原因は、ボタンと押したときの動きがつながっていないことのようです。',
      'つなぎ直して、押すと保存されるようにします。',
      'あわせて、保存中はボタンを押せないようにして、二重に保存されるのも防ぎますね。',
    ],
  },
  casual: {
    short: ['ボタンと動きがつながってないみたい。', 'つなぎ直しとくね！'],
    balanced: [
      '原因は、ボタンと押したときの動きがつながってないことっぽい。',
      'つなぎ直して、押したら保存されるようにしとくね！',
    ],
    detailed: [
      '原因は、ボタンと押したときの動きがつながってないことっぽい。',
      'つなぎ直して、押したら保存されるようにするね。',
      'ついでに、保存中は押せないようにして、二重に保存されないようにもしとく！',
    ],
  },
  crisp: {
    short: ['原因: ボタンと動きが未接続。', 'つなぎ直します。'],
    balanced: [
      '原因: ボタンと押したときの動きが未接続。',
      '対応: つなぎ直し、押すと保存されるようにします。',
    ],
    detailed: [
      '原因: ボタンと押したときの動きが未接続。',
      '対応: つなぎ直し、押すと保存されるようにします。',
      '追加: 保存中は押せないようにし、二重保存を防ぎます。',
    ],
  },
};

const DEPTH_SENTENCE: Record<Exclude<Depth, 'conclusion'>, Record<Tone, string>> = {
  reasoned: {
    polite: '画面を作り直したときに、つなぎ目が外れてしまったためです。',
    casual: '画面を作り直したときに、つなぎ目が外れちゃったんだと思う。',
    crisp: '理由: 画面の作り直しで、つなぎ目が外れたため。',
  },
  beginner: {
    polite: 'たとえるなら、電気のスイッチと電球をつなぐ線が抜けていた状態です。',
    casual: 'スイッチと電球をつなぐ線が抜けてた、みたいな感じ。',
    crisp: 'たとえ: スイッチと電球の線が抜けた状態。',
  },
};

export function setupPreviewReply(
  preferences: Pick<AssistantPreferences, 'tone' | 'length' | 'depth'>,
): string {
  const [opening, ...rest] = BASE[preferences.tone][preferences.length];
  const extra =
    preferences.depth === 'conclusion' ? [] : [DEPTH_SENTENCE[preferences.depth][preferences.tone]];
  return [opening, ...extra, ...rest].join('');
}
