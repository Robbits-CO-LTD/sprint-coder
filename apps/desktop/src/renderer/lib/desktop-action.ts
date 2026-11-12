import type { ApprovalSummary } from '../types/sprint-coder';

type DesktopAction = NonNullable<ApprovalSummary['desktopAction']>;
type DesktopStep = Pick<
  DesktopAction,
  'kind' | 'title' | 'mode' | 'target' | 'destination' | 'text' | 'textRole'
>;

const ALL_TARGET = {
  windows: 'すべての窓',
  apps: '起動中のアプリ',
  displays: 'すべての画面',
  surfaces: 'アプリの画面の構成',
  notifications: 'すべての通知',
} as const;

/** The line a desktop-control card shows for what the run acts on. Names are the app's own text. */
export function desktopTargetText(target: NonNullable<DesktopStep['target']>): string {
  if (!target.resolved)
    return `対象を確かめられません${target.reference === undefined ? '' : `（${target.reference}）`}`;
  if (target.all !== undefined) return ALL_TARGET[target.all];
  // The window id tells apart two windows with the same title.
  const id = target.windowId === undefined ? '' : ` · ${target.windowId}`;
  const app = target.app === undefined ? '' : `（${target.app}）`;
  if (target.role === '窓' && target.window !== undefined)
    return `窓「${target.window}」${app}${id}`;
  if (target.window === undefined && target.role === undefined)
    return target.app === undefined ? '対象を確かめられません' : `アプリ「${target.app}」`;
  const place = target.window ?? target.app ?? '';
  // A part without a name is said to have none, so it is not taken for the window's only one.
  // Where it sits, when the window has others of the same name (a dialog's 「閉じる」).
  const within =
    target.within === undefined ? '' : `${target.within.role}「${target.within.name}」の`;
  const part = `${within}${target.role ?? '部品'}${target.name === undefined ? '（名前なし）' : `「${target.name}」`}`;
  return target.window === undefined ? `${place} の${part}${id}` : `${place}${app} の${part}${id}`;
}

const TEXT_LABEL = {
  enter: '入れる文字',
  select: '選ぶ値',
  keys: '押すキー',
  clipboard: '書く文字',
  button: '押すボタン',
} as const;

export function desktopTextLabel(step: Pick<DesktopStep, 'textRole'>): string {
  return TEXT_LABEL[step.textRole ?? 'enter'];
}

/**
 * The mark beside the heading. A background run takes no mouse or keyboard and leaves its window
 * behind the one in use; the card's notes say so. A launch gets no mark, and a read none.
 */
export function desktopModeLabel(step: Pick<DesktopStep, 'mode' | 'kind'>): string | null {
  if (step.mode === 'foreground') return '前面を使います';
  if (step.mode === 'background' && step.kind !== 'launch') return 'マウスとキーボードは使いません';
  return null;
}

/** Heading and target in one line, for history rows and accessible names. */
export function desktopActionSummary(step: DesktopStep): string {
  const summary =
    step.target === undefined ? step.title : `${step.title} ${desktopTargetText(step.target)}`;
  return step.destination === undefined
    ? summary
    : `${summary} → ${desktopTargetText(step.destination)}`;
}
