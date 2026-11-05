import { computerUseBackgroundFixtureDigest } from './computer-use-acceptance-mode';
import { win32 } from 'node:path';
import { createHash } from 'node:crypto';
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
import {
  classifyTarget,
  denyRulesetVersion,
  type TargetFacts,
} from './computer-use-target-eligibility';
import type { ComputerTargetWindowsGeneration } from './computer-use-target-model';
import type { ComputerAppProfileRecord } from './persistence';
import {
  WINDOWS_EXPLORER_FINAL_VERSIONS,
  windowsExplorerPrestartContextAllows,
  type WindowsExplorerPrestartContext,
} from './computer-use-explorer-prestart';
import { classifyWindowsExplorerPrestart } from './computer-use-target-eligibility';

export type WindowsComputerTargetCandidate = Readonly<{
  profile: ComputerAppProfileRecord;
  windows: readonly Readonly<{
    windowId: string;
    windowIdentityDigest: string;
    title: string;
    maximumMode: ComputerUseMode;
    windowsGeneration: ComputerTargetWindowsGeneration;
    eligible: true;
  }>[];
}>;

type NativeSelectableTarget = Extract<
  ComputerWindowsNativeTargetList['targets'][number],
  { kind: 'eligible' | 'upper' }
>;

/** Main-only evidence; never an agent-tool or Renderer result. */
export type ComputerUseNativeTargetList = Readonly<{
  windowsGeneration?: ComputerTargetWindowsGeneration;
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

/** Ephemeral profiles bound to tokens: no registration, grant, or egress agreement. */
export function windowsComputerTargetCandidates(
  list: ComputerUseNativeTargetList,
): readonly WindowsComputerTargetCandidate[] {
  const windowsGeneration = list.windowsGeneration;
  if (
    windowsGeneration === undefined ||
    windowsGeneration.listGeneration !== list.generation ||
    windowsGeneration.rulesetVersion !== list.rulesetVersion
  )
    throw new Error('Computer Use target generation changed');
  const candidates = new Map<string, WindowsComputerTargetCandidate>();
  for (const target of list.targets) {
    if (target.kind !== 'selectable') continue;
    const { native, maximumMode } = target;
    // Byte identity also separates simultaneous versions of the same signed application.
    const id = `native-target:${createHash('sha256')
      .update(`${native.appIdentityDigest}:${native.executableDigest}`)
      .digest('hex')}`;
    const previous = candidates.get(id);
    const profile: ComputerAppProfileRecord = previous?.profile ?? {
      id,
      platform: 'win32',
      kind: native.identity.packageFamilyName === null ? 'win32-executable' : 'windows-package',
      label: native.identity.displayName,
      canonicalPath: native.identity.executablePath,
      appUrl: null,
      identity: { ...native.identity, maximumMode },
      identityDigest: native.appIdentityDigest,
      version: null,
      executableDigest: native.executableDigest,
      mode: 'full_access_app',
      connectionId: '',
      modelId: '',
      providerEgressConsent: false,
      remember: false,
      revision: 1,
      createdAt: '',
      updatedAt: '',
    };
    candidates.set(id, {
      profile,
      windows: [
        ...(previous?.windows ?? []),
        {
          windowId: native.windowId,
          windowIdentityDigest: native.windowIdentityDigest,
          title: native.title,
          maximumMode,
          windowsGeneration,
          eligible: true,
        },
      ],
    });
  }
  return [...candidates.values()];
}

/** Independently check the private native list against Main's build-time pin. */
export function backgroundAcceptanceTargetVerdict(
  facts: TargetFacts,
  digest: string,
): ReturnType<typeof classifyTarget> {
  const pinned = computerUseBackgroundFixtureDigest();
  if (
    pinned !== null &&
    digest === pinned &&
    facts.platform === 'win32' &&
    facts.runningImageMatches === true &&
    facts.imageVolume === 'fixed' &&
    facts.signature === 'unsigned' &&
    facts.packaged === false &&
    facts.peSubsystem === 'gui' &&
    facts.windowClass === 'P7aFixture'
  ) {
    return classifyTarget({
      ...facts,
      imageRoot: facts.imageRoot === 'other' ? 'local_programs' : facts.imageRoot,
      signature: 'valid',
    });
  }
  return classifyTarget(facts);
}

/** Malformed evidence invalidates the whole response; ordinary refusals carry only their kind. */
export function parseWindowsComputerUseTargets(
  value: unknown,
  windowsApprovalAvailable = false,
  explorerContext?: WindowsExplorerPrestartContext,
): ComputerUseNativeTargetList | null {
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
    const evidence = native.explorerPrestart;
    if (
      evidence !== undefined &&
      (evidence.pid !== native.pid ||
        evidence.listGeneration !== parsed.data.generation ||
        evidence.rulesetVersion !== parsed.data.rulesetVersion ||
        evidence.rulesetVersion !== WINDOWS_EXPLORER_FINAL_VERSIONS.rulesetVersion ||
        evidence.classifierVersion !== WINDOWS_EXPLORER_FINAL_VERSIONS.classifierVersion ||
        evidence.lexiconVersion !== WINDOWS_EXPLORER_FINAL_VERSIONS.lexiconVersion ||
        native.windowIdentityDigest !==
          createHash('sha256')
            .update(
              `computer-window-identity-v1\n${native.appIdentityDigest}\n${evidence.processStartTime}\n${native.windowId}`,
            )
            .digest('hex'))
    )
      return null;
    const explorerAllowed =
      evidence !== undefined &&
      native.kind === 'upper' &&
      native.maximumMode === 'supervised' &&
      windowsApprovalAvailable &&
      windowsExplorerPrestartContextAllows(explorerContext, native, parsed.data.generation);
    const verdict = explorerAllowed
      ? classifyWindowsExplorerPrestart(native.facts)
      : computerUseBackgroundFixtureDigest() === null
        ? classifyTarget(native.facts)
        : backgroundAcceptanceTargetVerdict(native.facts, native.executableDigest);
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
      maximumMode: bindComputerUseMaximumMode(
        native.maximumMode,
        verdict.maximumMode,
        verdict.kind === 'upper' && !windowsApprovalAvailable ? 'observe_only' : 'full_access_app',
      ),
    });
  }
  return { ...parsed.data, targets };
}
