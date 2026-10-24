import { win32 } from 'node:path';
import {
  bindComputerUseMaximumMode,
  computerWindowsNativeTargetListSchema,
  type ComputerUseMode,
  type ComputerWindowsNativeTargetList,
} from '@sprint-coder/contracts';
import {
  computerAppGrantIdentityFrom,
  computerAppNativeIdentityDigest,
} from './computer-use-grant-identity';
import { classifyTarget, denyRulesetVersion } from './computer-use-target-eligibility';

type NativeSelectableTarget = Extract<
  ComputerWindowsNativeTargetList['targets'][number],
  { kind: 'eligible' | 'upper' }
>;

/** Main-only evidence; never an agent-tool or Renderer result. */
export type ComputerUseNativeTargetList = Readonly<{
  generation: number;
  rulesetVersion: number;
  truncated: boolean;
  targets: readonly (
    | Readonly<{ kind: 'denied' | 'unresolvable' }>
    | Readonly<{
        kind: 'selectable';
        native: NativeSelectableTarget;
        maximumMode: ComputerUseMode;
      }>
  )[];
}>;

const asciiLower = (value: string): string =>
  value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());

/** Malformed evidence invalidates the whole response; ordinary refusals carry only their kind. */
export function parseWindowsComputerUseTargets(value: unknown): ComputerUseNativeTargetList | null {
  const parsed = computerWindowsNativeTargetListSchema.safeParse(value);
  if (!parsed.success || parsed.data.rulesetVersion !== denyRulesetVersion('win32')) return null;
  const targets: ComputerUseNativeTargetList['targets'][number][] = [];
  for (const native of parsed.data.targets) {
    if (native.kind === 'denied' || native.kind === 'unresolvable') {
      targets.push({ kind: native.kind });
      continue;
    }
    const derived = computerAppGrantIdentityFrom(native.identity);
    if (
      derived === null ||
      computerAppNativeIdentityDigest(native.identity, derived) !== native.appIdentityDigest
    )
      return null;
    const verdict = classifyTarget(native.facts);
    if (verdict.kind === 'denied' || verdict.kind === 'unresolvable') {
      targets.push({ kind: verdict.kind });
      continue;
    }
    // Both halves must name the same image/package, not valid facts from one target and a valid
    // identity from another. Signature kinds are not compared: catalog and embedded signatures
    // are distinct native measurements.
    if (
      native.facts.packaged !== (native.identity.packageFamilyName !== null) ||
      (native.facts.packaged && native.facts.packageFamily !== native.identity.packageFamilyName) ||
      native.facts.imageLeaf === null ||
      asciiLower(native.facts.imageLeaf) !==
        asciiLower(win32.basename(native.identity.executablePath))
    )
      return null;
    targets.push({
      kind: 'selectable',
      native,
      maximumMode: bindComputerUseMaximumMode(native.maximumMode, verdict.maximumMode),
    });
  }
  return { ...parsed.data, targets };
}
