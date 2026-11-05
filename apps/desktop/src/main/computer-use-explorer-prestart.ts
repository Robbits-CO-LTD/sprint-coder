import definition from '../../computer-use-native/eligibility.json';
import { parseComputerUseNativeCompiledPin } from './computer-use-native-provenance';
import type { ComputerWindowsNativeTargetList } from '@sprint-coder/contracts';

export const WINDOWS_EXPLORER_PRESTART_ENABLED = false;
// Same build definition as the generated native eligibility header. The native final declaration
// is checked against this definition by the seam test; Main never repeats its version numbers.
export const WINDOWS_EXPLORER_FINAL_VERSIONS = Object.freeze(definition.versions.win32.v2);
export type ExplorerPrestartTarget = Extract<
  ComputerWindowsNativeTargetList['targets'][number],
  { kind: 'eligible' | 'upper' }
>;

export function windowsExplorerFinalPinMatches(value: unknown): boolean {
  try {
    const pin = parseComputerUseNativeCompiledPin(value);
    const declared = pin.eligibility;
    return (
      pin.platform === 'win32' &&
      declared?.mode === 'v2-denylist' &&
      declared.ticketRequired === true &&
      declared.interlockEnforced === true &&
      declared.rulesetVersion === WINDOWS_EXPLORER_FINAL_VERSIONS.rulesetVersion &&
      declared.classifierVersion === WINDOWS_EXPLORER_FINAL_VERSIONS.classifierVersion &&
      declared.lexiconVersion === WINDOWS_EXPLORER_FINAL_VERSIONS.lexiconVersion
    );
  } catch {
    return false;
  }
}

export function windowsExplorerCompiledPinMatches(): boolean {
  return (
    typeof __SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__ !== 'undefined' &&
    windowsExplorerFinalPinMatches(__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__)
  );
}

const contextBrand: unique symbol = Symbol('explorer-prestart-context');
export type WindowsExplorerPrestartContext = Readonly<{ [contextBrand]: true }>;
const contexts = new WeakMap<
  WindowsExplorerPrestartContext,
  (target: ExplorerPrestartTarget, generation: number) => boolean
>();

/** Host-internal context, separate from the list's ordinary approval mode ceiling. */
export function createWindowsExplorerPrestartContext(
  verify: (target: ExplorerPrestartTarget, generation: number) => boolean,
): WindowsExplorerPrestartContext {
  const context: WindowsExplorerPrestartContext = Object.freeze({ [contextBrand]: true });
  contexts.set(context, verify);
  return context;
}

export function windowsExplorerPrestartContextAllows(
  context: WindowsExplorerPrestartContext | undefined,
  target: ExplorerPrestartTarget,
  generation: number,
): boolean {
  return context !== undefined && contexts.get(context)?.(target, generation) === true;
}
