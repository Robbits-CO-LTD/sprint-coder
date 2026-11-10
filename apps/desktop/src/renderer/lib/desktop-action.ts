import type { ApprovalSummary } from '../types/sprint-coder';

type DesktopAction = NonNullable<ApprovalSummary['desktopAction']>;
type DesktopStep = Pick<DesktopAction, 'kind' | 'title' | 'mode' | 'target' | 'text' | 'textRole'>;

/** The line a desktop-control card shows for what the run acts on. Names are the app's own text. */
export function desktopTargetText(target: NonNullable<DesktopStep['target']>): string {
  if (!target.resolved)
    return `対象を確かめられません${target.reference === undefined ? '' : `（${target.reference}）`}`;
  const app = target.app === undefined ? '' : `（${target.app}）`;
  if (target.role === '窓' && target.window !== undefined) return `窓「${target.window}」${app}`;
  if (target.window === undefined && target.role === undefined)
    return target.app === undefined ? '対象を確かめられません' : `アプリ「${target.app}」`;
  const place = target.window ?? target.app ?? '';
  const part = `${target.role ?? '部品'}${target.name === undefined ? '' : `「${target.name}」`}`;
  return target.window === undefined ? `${place} の${part}` : `${place}${app} の${part}`;
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

/** The mark beside the heading: background runs and foreground runs are told apart at a glance. */
export function desktopModeLabel(mode: DesktopStep['mode']): string | null {
  if (mode === 'background') return '裏で動きます';
  if (mode === 'foreground') return '前面を使います';
  return null;
}

/** Heading and target in one line, for history rows and accessible names. */
export function desktopActionSummary(step: DesktopStep): string {
  return step.target === undefined ? step.title : `${step.title} ${desktopTargetText(step.target)}`;
}
