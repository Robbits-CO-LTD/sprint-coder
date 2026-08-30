import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPUTER_USE_NATIVE_FEATURE_FLAG,
  evaluateComputerUseNativeGate,
  loadComputerUseNative,
  parseComputerUseNativeManifest,
} from './computer-use-native';
import {
  COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES,
  COMPUTER_USE_NATIVE_MAX_BINARY_BYTES,
  COMPUTER_USE_NATIVE_MAX_METADATA_BYTES,
  decodeComputerUseNativeFrame,
  encodeComputerUseNativeFrame,
  newComputerUseNativeFrameId,
} from './computer-use-native-protocol';
import {
  createComputerUseNativeHost,
  deriveComputerUseTargetFacts,
} from './computer-use-native-host';
import {
  assertWindowsComputerUseHelperHandshake,
  assertWindowsComputerUseSpawnedHelperAttestation,
  decodeWindowsObservationPayload,
  isWindowsHelperResponseBound,
  operationTimeoutMilliseconds,
  windowsHelperEnvironment,
} from './computer-use-native-windows';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageFixture(
  options: Readonly<{
    platform?: 'darwin' | 'win32';
    trust?: 'developer-id' | 'authenticode' | 'ad-hoc' | 'unsigned';
    bytes?: string;
  }> = {},
) {
  const platform = options.platform ?? 'darwin';
  const root = mkdtempSync(join(tmpdir(), 'sprint-coder-computer-use-native-'));
  roots.push(root);
  const resources = join(root, 'resources');
  const packagedDirname = join(root, 'app.asar', '.vite', 'build');
  mkdirSync(packagedDirname, { recursive: true });
  mkdirSync(resources, { recursive: true });
  const artifactName =
    platform === 'darwin'
      ? 'sprint_coder_computer_use_native.node'
      : 'sprint-coder-computer-use-host.exe';
  const bytes = Buffer.from(options.bytes ?? 'trusted-native-fixture');
  const artifactPath = join(resources, artifactName);
  writeFileSync(artifactPath, bytes);
  const trust = options.trust ?? (platform === 'darwin' ? 'developer-id' : 'authenticode');
  writeFileSync(
    join(resources, 'computer-use-native.manifest.json'),
    JSON.stringify({
      version: 1,
      sourceCommit: 'f'.repeat(40),
      platform,
      architecture: platform === 'darwin' ? 'arm64' : 'x64',
      protocolVersion: 1,
      apiVersion: 1,
      nativeVersion: 'computer-use-native-gate0-1',
      moduleDigest: createHash('sha256').update(bytes).digest('hex'),
      binaryDigest: createHash('sha256').update(bytes).digest('hex'),
      signerDigest: trust === 'developer-id' || trust === 'authenticode' ? 'a'.repeat(64) : null,
      capabilities: ['observe', 'capture', 'accessibility', 'input'],
    }),
  );
  return { root, resources, packagedDirname, artifactPath };
}

describe('Computer Use native protocol', () => {
  it('round-trips bounded request/session/cancel identifiers', () => {
    const requestId = newComputerUseNativeFrameId();
    const sessionId = newComputerUseNativeFrameId();
    const cancelId = newComputerUseNativeFrameId();
    const encoded = encodeComputerUseNativeFrame({
      messageType: 'cancel',
      flags: 3,
      requestId,
      sessionId,
      cancelId,
      metadata: Buffer.from('{"kind":"click"}'),
      binary: Buffer.from([1, 2, 3]),
    });
    expect(encoded.byteLength).toBeGreaterThan(COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES);
    expect(decodeComputerUseNativeFrame(encoded)).toMatchObject({
      messageType: 'cancel',
      flags: 3,
      requestId,
      sessionId,
      cancelId,
      metadata: Buffer.from('{"kind":"click"}'),
      binary: Buffer.from([1, 2, 3]),
    });
  });

  it('rejects truncated, oversized, and malformed frames before dispatch', () => {
    const requestId = newComputerUseNativeFrameId();
    const sessionId = newComputerUseNativeFrameId();
    const encoded = encodeComputerUseNativeFrame({
      messageType: 'probe',
      flags: 0,
      requestId,
      sessionId,
      cancelId: null,
      metadata: Buffer.from('probe'),
      binary: Buffer.from([1, 2, 3]),
    });
    expect(encoded.subarray(44, 60)).toEqual(Buffer.alloc(16));
    expect(() => decodeComputerUseNativeFrame(encoded.subarray(0, -1))).toThrow('truncated');
    const oversized = Buffer.from(encoded);
    oversized.writeUInt32LE(COMPUTER_USE_NATIVE_MAX_METADATA_BYTES + 1, 60);
    expect(() => decodeComputerUseNativeFrame(oversized)).toThrow(
      'metadata exceeds the bounded limit',
    );
    const binaryOversized = Buffer.from(encoded);
    binaryOversized.writeUInt32LE(COMPUTER_USE_NATIVE_MAX_BINARY_BYTES + 1, 64);
    expect(() => decodeComputerUseNativeFrame(binaryOversized)).toThrow(
      'binary exceeds the bounded limit',
    );
    const badMagic = Buffer.from(encoded);
    badMagic.writeUInt32LE(0, 0);
    expect(() => decodeComputerUseNativeFrame(badMagic)).toThrow('magic mismatch');
    const cancelEncoded = encodeComputerUseNativeFrame({
      messageType: 'cancel',
      flags: 0,
      requestId,
      sessionId,
      cancelId: newComputerUseNativeFrameId(),
      metadata: Buffer.from('{"cancel":true}'),
      binary: Buffer.alloc(0),
    });
    expect(decodeComputerUseNativeFrame(cancelEncoded).messageType).toBe('cancel');
  });

  it('ships a deterministic bounded sanitizer harness in target-native gates', () => {
    const harness = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_protocol_fuzz.cc'),
      'utf8',
    );
    const ci = readFileSync(join(__dirname, '../../../../.github/workflows/ci.yml'), 'utf8');
    const release = readFileSync(
      join(__dirname, '../../../../.github/workflows/release-beta.yml'),
      'utf8',
    );
    expect(harness).toContain("iteration < 4'096");
    expect(harness).toContain('DecodeFrame');
    expect(harness).toContain('kMaxBinaryBytes + 1');
    for (const workflow of [ci, release]) {
      expect(workflow).toContain('-fsanitize=address,undefined');
      expect(workflow).toContain('/fsanitize=address');
      expect(workflow).toContain('Windows ASan: SKIP');
    }
  });
});

describe('Computer Use accessibility policy projection', () => {
  it('derives revision-bound signatures and only restrictive security metadata', () => {
    const facts = deriveComputerUseTargetFacts(
      JSON.stringify({
        role: 'AXWindow',
        title: 'Document',
        identifier: 'main',
        children: [
          {
            role: 'AXSecureTextField',
            title: 'Password',
            identifier: 'secret-field',
            children: [],
          },
          {
            role: 'AXButton',
            title: '購入',
            identifier: 'checkout',
            children: [],
          },
        ],
      }),
    );

    expect(facts.signatures['secret-field']).toMatch(/^[a-f0-9]{64}$/u);
    expect(facts.metadata['secret-field']).toEqual({ secure: true, highImpact: true });
    expect(facts.metadata['checkout']).toEqual({ secure: false, highImpact: true });
  });

  it('drops duplicate target ids so a semantic action cannot pick an ambiguous control', () => {
    const facts = deriveComputerUseTargetFacts(
      JSON.stringify({
        role: 'AXWindow',
        title: '',
        identifier: '',
        children: [
          { role: 'AXButton', title: 'Save', identifier: '', children: [] },
          { role: 'AXButton', title: 'Save', identifier: '', children: [] },
        ],
      }),
    );
    expect(facts.signatures).not.toHaveProperty('Save');
    expect(facts.metadata).not.toHaveProperty('Save');
  });

  it('does not classify ordinary save/send/publish/delete controls as high impact', () => {
    const facts = deriveComputerUseTargetFacts(
      JSON.stringify({
        role: 'AXWindow',
        title: '',
        identifier: '',
        children: ['Save', 'Send', 'Publish', 'Delete'].map((title) => ({
          role: 'AXButton',
          title,
          identifier: title.toLowerCase(),
          children: [],
        })),
      }),
    );

    for (const targetId of ['save', 'send', 'publish', 'delete'])
      expect(facts.metadata[targetId]).toEqual({ secure: false, highImpact: false });
  });

  it('classifies bounded payment and order labels without matching embedded pay text', () => {
    const blocked = [
      'Pay',
      'Pay now',
      'pay_now',
      'Place order',
      'Pagar',
      'Comprar',
      'Acheter',
      'Bestellen',
      'Bezahlen',
      'Pagare',
      'Acquistare',
      'Betalen',
      'Kopen',
      '注文を確定',
      '今すぐ支払う',
    ];
    const ordinary = [
      'Papaya details',
      'Spay clinic',
      'Payload details',
      'Apagar reminder',
      'Unbestellend status',
      'Acheterium sample',
    ];
    const facts = deriveComputerUseTargetFacts(
      JSON.stringify({
        role: 'AXWindow',
        title: '',
        identifier: '',
        children: [...blocked, ...ordinary].map((title, index) => ({
          role: 'AXButton',
          title,
          identifier: `action-${index}`,
          children: [],
        })),
      }),
    );

    for (let index = 0; index < blocked.length; index += 1)
      expect(facts.metadata[`action-${index}`]).toEqual({ secure: false, highImpact: true });
    for (let index = blocked.length; index < blocked.length + ordinary.length; index += 1)
      expect(facts.metadata[`action-${index}`]).toEqual({ secure: false, highImpact: false });
  });
});

describe('Windows native helper compile boundary', () => {
  it('binds the lazy spawned helper image, digest, signer, and source commit', () => {
    const thumbprint = 'A'.repeat(40);
    const expected = {
      binaryDigest: 'b'.repeat(64),
      signerDigest: createHash('sha256').update(thumbprint, 'utf8').digest('hex'),
      sourceCommit: 'c'.repeat(40),
    } as const;
    const attestation = {
      imagePath: String.raw`C:\Program Files\Sprint Coder\sprint-coder-computer-use-host.exe`,
      binaryDigest: expected.binaryDigest,
      signatureStatus: 'Valid',
      signerThumbprint: thumbprint,
    } as const;

    expect(() =>
      assertWindowsComputerUseSpawnedHelperAttestation(
        String.raw`c:\program files\Sprint Coder\sprint-coder-computer-use-host.exe`,
        expected,
        attestation,
      ),
    ).not.toThrow();
    expect(() =>
      assertWindowsComputerUseSpawnedHelperAttestation(
        String.raw`C:\Program Files\Sprint Coder\sprint-coder-computer-use-host.exe`,
        expected,
        { ...attestation, imagePath: String.raw`C:\Temp\substituted-helper.exe` },
      ),
    ).toThrow('image path');
    expect(() =>
      assertWindowsComputerUseSpawnedHelperAttestation(attestation.imagePath, expected, {
        ...attestation,
        binaryDigest: 'd'.repeat(64),
      }),
    ).toThrow('digest');
    expect(() =>
      assertWindowsComputerUseSpawnedHelperAttestation(attestation.imagePath, expected, {
        ...attestation,
        signerThumbprint: 'E'.repeat(40),
      }),
    ).toThrow('signer');
    expect(() =>
      assertWindowsComputerUseHelperHandshake(
        {
          protocolVersion: 1,
          apiVersion: 1,
          platform: 'win32',
          sourceCommit: 'd'.repeat(40),
        },
        expected,
      ),
    ).toThrow('source commit');
  });

  it('keeps the trusted picker, identity, pipe, WGC, session, and input gates in source', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );
    expect(source).toContain('static_assert(sizeof(void *) == 8');
    expect(source).toContain('SPRINT_CODER_SOURCE_COMMIT');
    expect(source).toContain('sourceCommit');
    expect(source).toContain('GetForegroundWindow()');
    expect(source).toContain('TokenElevation');
    expect(source).toContain('cancellation_epoch.load');
    expect(source).toContain('ClassifyWindowsPoint');
    expect(source).toContain('CLSID_FileOpenDialog');
    expect(source).toContain('WinVerifyTrust');
    expect(source).toContain('CreateNamedPipeW');
    expect(source).toContain('PIPE_REJECT_REMOTE_CLIENTS');
    expect(source).toContain('BuildCurrentUserPipeSecurity');
    expect(source).toContain('IsActualParentProcess');
    expect(source).toContain('ResponseCacheKey');
    expect(source).toContain('RequestPayloadDigest');
    expect(source).toContain('request_id_conflict');
    expect(source).toContain('ReplayCachedResponse');
    expect(source).toContain('CreateForWindow');
    expect(source).toContain('DwmGetWindowAttribute');
    expect(source).toContain(String.raw`boundsUnit\":\"physical_px`);
    expect(source).toContain('DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2');
    expect(source).toContain('StartWindowsSession');
    expect(source).toContain('ObserveWindowsWindow(*session');
    expect(source).toContain('DispatchWindowsSemanticAction');
    expect(source).toContain('FindUiaTargetRecursive');
    expect(source).toContain('WindowsFocusedElementSignature');
    expect(source).toContain('focused_target_changed');
    expect(source).toContain('GetParentElement');
    expect(source).toContain('IsDisallowedTargetExecutable');
    expect(source).toContain('std::thread reader');
    expect(source).toContain('compare_exchange_weak');
    expect(source).toContain('requested_observation != session.observation_revision');
    expect(source).toContain('metadata_complete');
    expect(source).toContain('CaptureWindowsControlBindings');
    expect(source).toContain('session.semantic_control_signatures.find');
    expect(source).toContain('session.visual_control_signatures.contains');
    expect(source).not.toContain('CreateEnvironmentBlock');
    expect(source).toContain('class_length <= 0');
    expect(source).not.toContain('capture_frame = false');
    expect(source).not.toContain('      }\n        break;\n      default:');
    expect(source).toContain('#include <set>');
    expect(source.match(/bool ReadExact\(/gu)).toHaveLength(1);
  });

  it('publishes parent death into the shared input gate before disconnecting the pipe', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );
    const watcherSource = source.slice(
      source.indexOf('parent_watcher = std::thread'),
      source.indexOf('ServePipe(pipe, probe)'),
    );
    const revalidationSource = source.slice(
      source.indexOf('bool RevalidateWindowsTarget('),
      source.indexOf('WORD VirtualKeyForName('),
    );
    const startSource = source.slice(
      source.indexOf('const auto start_not_canceled'),
      source.indexOf('RECT physical_client{}'),
    );

    expect(watcherSource.indexOf('parent_process_dead.store')).toBeGreaterThanOrEqual(0);
    expect(watcherSource.indexOf('cancellation_epoch.fetch_add')).toBeGreaterThanOrEqual(0);
    expect(watcherSource.indexOf('parent_process_dead.store')).toBeLessThan(
      watcherSource.indexOf('CancelIoEx'),
    );
    expect(watcherSource.indexOf('cancellation_epoch.fetch_add')).toBeLessThan(
      watcherSource.indexOf('CancelIoEx'),
    );
    expect(revalidationSource).toContain('parent_process_dead.load(std::memory_order_acquire)');
    expect(revalidationSource).toContain('UINT SendInputForBoundTarget(');
    expect(revalidationSource).toContain(
      'RevalidateWindowsTarget(session, expected, expected_epoch)',
    );
    expect(startSource).toContain('parent_process_dead.load(std::memory_order_acquire)');
    expect(source.match(/\bSendInput\(/gu)).toHaveLength(1);
    expect(source.match(/SendInputForBoundTarget\(/gu)?.length).toBeGreaterThanOrEqual(7);
  });

  it('uses bounded payment labels in both native risk classifiers', () => {
    const windows = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );
    const macos = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const windowsRisk = windows.slice(
      windows.indexOf('bool ContainsBoundedWindowsRiskTerm('),
      windows.indexOf('WindowsUiaRisk ClassifyWindowsUiaElementSelf('),
    );
    const macosRisk = macos.slice(
      macos.indexOf('AxRiskClassification ClassifyAccessibilityElementNode('),
      macos.indexOf('constexpr std::size_t kMaxAccessibilityRiskParentDepth'),
    );

    for (const term of [
      '"pay"',
      '"pay now"',
      '"place order"',
      '"pagar"',
      '"comprar"',
      '"acheter"',
      '"bestellen"',
      '"bezahlen"',
      '"pagare"',
      '"acquistare"',
      '"betalen"',
      '"kopen"',
      '"注文を確定"',
      '"支払う"',
    ]) {
      expect(windowsRisk).toContain(term);
      expect(macosRisk).toContain(term);
    }
    expect(windowsRisk).toContain('ContainsBoundedWindowsRiskTerm(text, term)');
    expect(macosRisk).toContain('ContainsAnyBoundedAsciiTerm');
  });

  it('fails closed when the macOS AX risk parent chain exceeds its bound', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const classifierStart = source.indexOf(
      'constexpr std::size_t kMaxAccessibilityRiskParentDepth',
    );
    const classifier = source.slice(
      classifierStart,
      source.indexOf('AxRiskClassification ClassifyFocusedElement(', classifierStart),
    );

    expect(classifier).toContain('if (current != nullptr) {');
    expect(classifier).toContain('classification.classified = false;');
  });

  it('holds a canonical no-write/no-delete executable handle across launch and revalidates the running image', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );
    const openSource = source.slice(
      source.indexOf('bool OpenLockedWindowsExecutable('),
      source.indexOf('bool BuildWindowsExecutableIdentity('),
    );
    const launchSource = source.slice(
      source.indexOf('bool LaunchVerifiedExecutable('),
      source.indexOf('bool ListWindowsForIdentity('),
    );

    expect(source).toContain('GetFinalPathNameByHandleW');
    expect(openSource).toContain('GENERIC_READ, FILE_SHARE_READ, nullptr');
    expect(openSource).not.toContain('FILE_SHARE_WRITE');
    expect(openSource).not.toContain('FILE_SHARE_DELETE');
    expect(source).toContain('FileIdInfo');
    expect(source).toContain('file_info.hFile = file');
    expect(source).toContain('SameWindowsFileIdentity');
    expect(launchSource).toContain('const LockedWindowsExecutable &locked');
    expect(launchSource.indexOf('CreateProcessW')).toBeLessThan(
      launchSource.indexOf('OpenLockedProcessExecutable(information.hProcess'),
    );
    expect(launchSource).toContain('TerminateProcess');
    expect(source).toContain('WindowsSessionExecutableMatches');
    expect(source).toContain('session.executable_file = process_executable.file');
  });

  it('allows only same-path same-signer Windows updates to refresh the executable digest', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );
    const listSource = source.slice(
      source.indexOf('bool ListWindowsForIdentity('),
      source.indexOf('std::string FrameIdKey('),
    );
    const enumerationSource = source.slice(
      source.indexOf('bool EnumerateWindowsForExecutable('),
      source.indexOf('bool LaunchVerifiedExecutable('),
    );

    expect(listSource).toContain('const bool signed_identity_update');
    expect(listSource).toContain('!expected_signer_digest.empty()');
    expect(listSource).toContain(
      'current_executable.identity.signer_digest == expected_signer_digest',
    );
    expect(listSource).toContain(
      'current_executable.identity.identity_digest == expected_identity',
    );
    expect(listSource).toContain(
      'SameWindowsPath(current_executable.identity.path, canonical_path)',
    );
    expect(listSource).toContain('current_executable.identity.executable_digest');
    expect(listSource).toContain('*reason = "app_identity_changed"');
    expect(source).toContain(String.raw`executableDigest\":\"`);
    expect(source).toContain('context->executable_digest');
    expect(enumerationSource).toContain('context.executable_digest =');
  });

  it('binds visual actions to recaptured local image patches and keeps bounded digests only', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );
    const visualStart = source.indexOf('constexpr std::size_t kVisualPatchSize');
    const visualSource = source.slice(
      visualStart,
      source.indexOf('std::string BoundedUtf8(', visualStart),
    );
    const dispatchSource = source.slice(
      source.indexOf('bool DispatchWindowsAction('),
      source.indexOf('BackendProbe ProbeBackend('),
    );

    expect(visualSource).toContain('kVisualPatchSize = 64');
    expect(visualSource).toContain("kMaximumVisualPatchDigests = 1'000");
    expect(visualSource).toContain('CopyPixels');
    expect(visualSource).toContain('ComputePngPatchGrid');
    expect(visualSource).toContain('native_visual_patch_changed');
    expect(visualSource).toContain('8 * 1024 * 1024');
    expect(dispatchSource.match(/RevalidateVisualPatch\(session, x, y/gu)).toHaveLength(2);
    expect(source).toContain('session.observation_patch_digests = std::move(patch_digests)');
    expect(source).toContain('std::fill(digest.begin(), digest.end(),');
  });

  it('revisions safe same-owner dialogs but yields for native prompts and unsupported proxy hosts', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );
    const dialogSource = source.slice(
      source.indexOf('bool IsOwnedByRootWindow('),
      source.indexOf('BOOL CALLBACK CollectTopLevelWindow('),
    );
    const observeSource = source.slice(
      source.indexOf('bool ObserveWindowsWindow('),
      source.indexOf('bool HandlePipeRequest('),
    );

    expect(dialogSource).toContain('computer-dialog-set-v1');
    expect(dialogSource).toContain('dialog.modal ? "modal" : "modeless"');
    expect(dialogSource).toContain('L"#32770"');
    expect(dialogSource).toContain('EnumChildWindows');
    expect(dialogSource).toContain('SHELLDLL_DefView');
    expect(dialogSource).toContain('native_dialog_user_takeover');
    expect(source).toContain('ApplicationFrameHost.exe');
    expect(source).toContain('ApplicationFrameWindow');
    expect(observeSource).toContain('session.dialog_set_revision += 1');
    expect(observeSource).toContain('stable_dialogs.digest != dialogs.digest');
    expect(source).toContain('dialogs.digest != session.dialog_set_digest');
    expect(source).toContain('dialogs.active_identity != session.active_window_identity');
    expect(observeSource).toContain(String.raw`dialogSetRevision\":`);
    expect(observeSource).toContain(String.raw`activeWindowKind\":\"`);
  });

  it('refocuses an existing session to its observation-bound safe dialog without rebinding the set', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );
    const resolverSource = source.slice(
      source.indexOf('bool ResolveWindowsSessionRefocusTarget('),
      source.indexOf('BOOL CALLBACK CollectTopLevelWindow('),
    );
    const startSource = source.slice(
      source.indexOf('bool StartWindowsSession('),
      source.indexOf('bool CloseWindowsSession('),
    );

    expect(resolverSource).toContain('CaptureWindowsDialogInventory');
    expect(resolverSource).toContain('inventory.digest != session.dialog_set_digest');
    expect(resolverSource).toContain('candidate.window == session.active_window');
    expect(resolverSource).toContain('candidate.identity == session.active_window_identity');
    expect(resolverSource).toContain('native_dialog_user_takeover');
    expect(startSource).toContain('ResolveWindowsSessionRefocusTarget(');
    expect(startSource).toContain('HWND refocus_window = window');
    expect(startSource).toContain('active_before_focus == sessions.end()');
    expect(startSource).toContain('SetForegroundWindow(refocus_window)');
    expect(startSource).toContain('refocused_dialogs.digest !=');
    expect(startSource).toContain('active_before_focus->second.dialog_set_digest');
    expect(startSource).not.toContain('dialog_set_revision = 0');
  });

  it('rebinds only an explicit resume to the current safe dialog set and requires a fresh observation', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );
    const invalidationSource = source.slice(
      source.indexOf('void InvalidateWindowsObservation('),
      source.indexOf('bool IsProcessElevated('),
    );
    const resumeSource = source.slice(
      source.indexOf('bool ResolveWindowsExplicitResumeTarget('),
      source.indexOf('BOOL CALLBACK CollectTopLevelWindow('),
    );
    const startSource = source.slice(
      source.indexOf('bool StartWindowsSession('),
      source.indexOf('bool CloseWindowsSession('),
    );
    const dispatchSource = source.slice(
      source.indexOf('bool DispatchWindowsAction('),
      source.indexOf('BackendProbe ProbeBackend('),
    );

    expect(source).toContain('bool ReadOptionalJsonBoolean(');
    expect(source).toContain('json.find(needle, position + needle.size())');
    expect(source).toContain('json.substr(cursor, 4) == "true"');
    expect(startSource).toContain('ReadOptionalJsonBoolean(metadata, "resume"');
    expect(startSource).toContain('else if (explicit_resume)');
    expect(startSource).toContain('ResolveWindowsExplicitResumeTarget(');
    expect(resumeSource).toContain('CaptureWindowsDialogInventory');
    expect(resumeSource).toContain('GetLastActivePopup');
    expect(resumeSource).toContain('session->dialog_set_revision += 1');
    expect(resumeSource).toContain('session->dialog_set_digest = inventory.digest');
    expect(resumeSource).toContain('InvalidateWindowsObservation(session)');
    expect(resumeSource).not.toContain('response_cache.clear');
    expect(invalidationSource).not.toContain('response_cache');
    expect(invalidationSource).toContain('session->has_observation = false');
    expect(invalidationSource).toContain('session->semantic_control_signatures.clear()');
    expect(invalidationSource).toContain('session->visual_control_signatures.clear()');
    expect(invalidationSource).toContain('session->observation_patch_digests.clear()');
    expect(dispatchSource).toContain('!session.has_observation');
    expect(source).toContain('session.has_observation = true');
  });

  it('declares the Windows explicit-resume parser state in StartWindowsSession only', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );
    const listSource = source.slice(
      source.indexOf('bool ListWindowsForIdentity('),
      source.indexOf('std::string FrameIdKey('),
    );
    const startSource = source.slice(
      source.indexOf('bool StartWindowsSession('),
      source.indexOf('bool CloseWindowsSession('),
    );

    expect(listSource).not.toContain('bool explicit_resume');
    expect(startSource).toContain('bool explicit_resume = false;');
    expect(startSource.indexOf('bool explicit_resume = false;')).toBeLessThan(
      startSource.indexOf('ReadOptionalJsonBoolean(metadata, "resume"'),
    );
  });

  it('carries an OS-evidenced target policy language through every Windows response boundary', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );

    expect(source).toContain('PolicyLanguageForWindowsExecutable');
    expect(source).toContain('GetFileMUIPath');
    expect(source.match(/policyLanguage/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('std::string policy_language = "unknown"');
  });

  it('rejects exact common remote desktop executable identities without blocking ordinary apps', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );
    const classifier = source.slice(
      source.indexOf('bool IsDisallowedTargetExecutable('),
      source.indexOf('bool EnumerateWindowsForExecutable('),
    );

    for (const executable of [
      'mstsc.exe',
      'msrdc.exe',
      'TeamViewer.exe',
      'AnyDesk.exe',
      'RustDesk.exe',
      'parsec.exe',
    ])
      expect(classifier).toContain(`L"${executable}"`);
    expect(classifier).not.toContain('Code.exe');
    expect(classifier).not.toContain('notepad.exe');
  });

  it('enables native exploit mitigations without changing the N-API export surface', () => {
    const build = readFileSync(
      join(__dirname, '../../../../build-computer-use-native.mjs'),
      'utf8',
    );
    const binding = readFileSync(join(__dirname, '../../computer-use-native/binding.gyp'), 'utf8');
    for (const flag of ['/GS', '/guard:cf', '/sdl', '/NXCOMPAT', '/DYNAMICBASE', '/HIGHENTROPYVA'])
      expect(build).toContain(`'${flag}'`);
    expect(binding).toContain('-fstack-protector-strong');
    expect(binding).toContain('-D_FORTIFY_SOURCE=2');
    expect(binding).toContain('sprint_coder_computer_use_native');
  });

  it('does not pass provider credentials or arbitrary parent environment to the helper', () => {
    expect(
      windowsHelperEnvironment({
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        OPENROUTER_API_KEY: 'must-not-cross',
        SPRINT_CODER_SECRET: 'must-not-cross',
      }),
    ).toEqual({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' });
  });

  it('binds helper responses to request session, expected kind, and binary lane', () => {
    const requestId = newComputerUseNativeFrameId();
    const sessionId = newComputerUseNativeFrameId();
    const otherSessionId = newComputerUseNativeFrameId();
    const base = {
      flags: 0,
      requestId,
      sessionId,
      cancelId: null,
      metadata: Buffer.from('{}'),
      binary: Buffer.alloc(0),
    } as const;
    const expected = { sessionId, responseType: 'probe_result' as const, allowBinary: false };

    expect(isWindowsHelperResponseBound({ ...base, messageType: 'probe_result' }, expected)).toBe(
      true,
    );
    expect(
      isWindowsHelperResponseBound(
        { ...base, sessionId: otherSessionId, messageType: 'probe_result' },
        expected,
      ),
    ).toBe(false);
    expect(
      isWindowsHelperResponseBound({ ...base, messageType: 'dispatch_result' }, expected),
    ).toBe(false);
    expect(
      isWindowsHelperResponseBound(
        { ...base, messageType: 'probe_result', binary: Buffer.from([1]) },
        expected,
      ),
    ).toBe(false);
  });

  it('gives the helper-owned application picker a bounded human interaction timeout', () => {
    expect(operationTimeoutMilliseconds('pick_application')).toBe(5 * 60_000);
    expect(operationTimeoutMilliseconds('dispatch')).toBe(10_000);
  });

  it('splits the bounded Windows screenshot and UTF-8 tree binary without base64 inflation', () => {
    const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const tree = Buffer.from('{"role":"AXWindow"}', 'utf8');
    expect(
      decodeWindowsObservationPayload(
        { screenshotBytes: screenshot.byteLength, treeBytes: tree.byteLength },
        Buffer.concat([screenshot, tree]),
      ),
    ).toMatchObject({ screenshot, tree: tree.toString('utf8') });
    expect(() =>
      decodeWindowsObservationPayload(
        { screenshotBytes: screenshot.byteLength, treeBytes: tree.byteLength + 1 },
        Buffer.concat([screenshot, tree]),
      ),
    ).toThrow('payload is invalid');
  });
});

describe('macOS native capture boundary', () => {
  it('downscales Retina/4K single-window captures within dimension and byte limits', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    expect(source).toContain('BoundedCaptureDimensions');
    expect(source).toContain("kMaxCaptureWidth = 2'560");
    expect(source).toContain("kMaxCaptureHeight = 1'600");
    expect(source).toContain('kMaxCaptureBytes = 8 * 1024 * 1024');
    expect(source).toContain('configuration.preservesAspectRatio = YES');
    expect(source).toContain('CreateScaledImage');
    expect(source).toContain('initWithDesktopIndependentWindow:window');
  });

  it('binds ordinary same-owner dialogs but yields for file, OS, admin, and security prompts', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const validationSource = source.slice(
      source.indexOf('NativeTargetValidation RevalidateBoundTarget('),
      source.indexOf('void CacheDispatchOutcome('),
    );

    expect(source).toContain('kAXFocusedWindowAttribute');
    expect(source).toContain('kAXTopLevelUIElementAttribute');
    expect(source).toContain('kAXWindowAttribute');
    expect(source).toContain('kAXParentAttribute');
    expect(source).toContain('kAXModalAttribute');
    expect(source).toContain('"axsheet", "axdialog", "axsystemdialog"');
    expect(source).toContain('native_dialog_user_takeover');
    expect(source).toContain('Ordinary same-process AXDialog/AXSheet windows are allowed');
    expect(source).toContain('CaptureMacDialogSetSnapshot');
    expect(source).toContain('"DIALOG_USER_TAKEOVER"');
    expect(validationSource).toContain('current.dialog_set_digest != request.dialog_set_digest');
    expect(validationSource).toContain(
      'current.active_window_identity != request.active_window_identity',
    );
  });

  it('requires a focused macOS dialog owner/top-level chain to reach the selected base window', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const dialogSource = source.slice(
      source.indexOf('bool AccessibilitySurfaceReachesBaseWindow('),
      source.indexOf('AxRiskClassification ClassifyAccessibilityElementNode('),
    );

    expect(dialogSource).toContain('kAXParentAttribute');
    expect(dialogSource).toContain('kAXWindowAttribute');
    expect(dialogSource).toContain('kAXTopLevelUIElementAttribute');
    expect(dialogSource).toContain('FindUniqueAccessibilityWindow(pid, base_bounds)');
    expect(dialogSource).toContain('AxFocusedWindowBoundary::kUserTakeover');
    expect(dialogSource).toContain('focused_surface_reaches_base');
  });

  it('carries an OS-evidenced target policy language through every macOS response boundary', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );

    expect(source).toContain('PolicyLanguageForMacBundle');
    expect(source).toContain('CFPreferencesCopyValue');
    expect(source).toContain('kCFPreferencesAnyApplication');
    expect(source).toContain('preferredLocalizationsFromArray:bundle.localizations');
    expect(source).not.toContain('bundle.preferredLocalizations');
    expect(source.match(/"policyLanguage"/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('std::string policy_language = "unknown"');
  });

  it('merges protected and shell surface facts from a bounded AX parent chain', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const nodeClassifier = source.slice(
      source.indexOf('AxRiskClassification ClassifyAccessibilityElementNode('),
      source.indexOf('constexpr std::size_t kMaxAccessibilityRiskParentDepth'),
    );

    expect(source).toContain('kMaxAccessibilityRiskParentDepth = 8');
    expect(source).toContain('depth < kMaxAccessibilityRiskParentDepth');
    expect(source).toContain('CopyAccessibilityElementAttribute(current, kAXParentAttribute)');
    for (const attribute of [
      'kAXRoleAttribute',
      'kAXSubroleAttribute',
      'kAXTitleAttribute',
      'kAXDescriptionAttribute',
      'kAXIdentifierAttribute',
      'kAXHelpAttribute',
    ])
      expect(nodeClassifier).toContain(attribute);
    expect(source).toContain('ContainsAnyBoundedAsciiTerm');
    expect(source).toContain(
      '"integrated terminal", "terminal", "terminal.app", "console", "shell"',
    );
    expect(source).toContain('"powershell", "powershell.exe", "command prompt", "cmd.exe"');
    expect(nodeClassifier).not.toContain('kAXValueAttribute');
  });

  it('marks remote desktop, System Settings, and installer app identities ineligible', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );

    expect(source).toContain('IsMacComputerUseApplicationEligible');
    expect(source).toContain('"com.apple.systempreferences"');
    expect(source).toContain('"com.apple.installer"');
    expect(source).toContain('"com.microsoft.rdc.macos"');
    expect(source).toContain('"com.apple.screensharing"');
    expect(source).toContain('"com.apple.terminal"');
    expect(source).toContain('"com.googlecode.iterm2"');
    expect(source).toContain('"dev.warp.warp-stable"');
    expect(source).toContain('"com.carriez.rustdesk"');
    expect(source).toContain('"com.parsecgaming.parsec"');
    expect(source).toContain('"com.splashtop.splashtop-remote-desktop"');
    expect(source).not.toContain('"com.microsoft.vscode"');
    expect(source).not.toContain('"com.apple.textedit"');
    expect(source.match(/IsCurrentApplicationEligible\(/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('"TARGET_INELIGIBLE"');
  });

  it('validates the complete app signature before trusting stable signing identity facts', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const signingSource = source.slice(
      source.indexOf('bool CopySigningFacts('),
      source.indexOf('bool ReadWindowTitle('),
    );

    expect(signingSource).toContain('SecStaticCodeCheckValidity');
    expect(signingSource).toContain('kSecCSStrictValidate');
    expect(signingSource).toContain('kSecCSCheckAllArchitectures');
    expect(signingSource.indexOf('SecStaticCodeCheckValidity')).toBeLessThan(
      signingSource.indexOf('SecCodeCopySigningInformation'),
    );
  });

  it('binds macOS path and native signer identity to the selected app bundle', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const loader = readFileSync(join(__dirname, './computer-use-native.ts'), 'utf8');
    const forge = readFileSync(join(__dirname, '../../forge.config.ts'), 'utf8');
    const pickerSource = source.slice(
      source.indexOf('napi_value PickApplication('),
      source.indexOf('std::string ComputerWindowIdentityDigest('),
    );
    expect(source).toContain('SameMacExecutablePath');
    expect(source).toContain(
      'ResolveRunningApplicationForIdentity(env, argv[0], app_identity, executable_path)',
    );
    expect(source).toContain('"canonicalPath"');
    expect(loader).toContain('MAC_TEAM_IDENTIFIER_PATTERN');
    expect(loader).toContain('appTeamIdentifier !== teamIdentifier');
    expect(forge).toContain('MAC_TEAM_IDENTIFIER_PATTERN');
    expect(forge).toContain('native module signer identities differ');
    expect(pickerSource).toContain('SameMacExecutablePath(candidate.executableURL.path,');
    expect(pickerSource).toContain('selected_executable_path');
    expect(pickerSource).not.toContain('.firstObject');
  });

  it('honors requested macOS semantic toggle/select values', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const semanticSource = source.slice(
      source.indexOf('NativeDispatchOutcome PerformSemanticDispatch('),
      source.indexOf('bool FreshVisualPatchMatches('),
    );
    expect(semanticSource).toContain('current == request.boolean_value');
    expect(source).toContain('CopyAccessibilityBooleanLike');
    expect(source).toContain('kCFNumberDoubleType');
    expect(semanticSource).toContain('request.selected_value != request.target_id');
    expect(semanticSource).toContain('kAXSelectedAttribute');
    expect(semanticSource).toContain('AXUIElementPerformAction(target, kAXPressAction)');
    expect(semanticSource).toContain('if (!confirmed) return outcome');
    expect(semanticSource).toContain('"unknown_effect", "native_input_effect_unknown"');
  });

  it('lists the target topmost window during onboarding and focuses it only at trusted start', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const listStart = source.indexOf('napi_value ListWindows(');
    const listSource = source.slice(
      listStart,
      source.indexOf('bool ReadAccessibilityWindowBounds(', listStart),
    );
    const startSource = source.slice(
      source.indexOf('napi_value StartSession('),
      source.indexOf('napi_value CloseSession('),
    );
    const activationSource = source.slice(
      source.indexOf('bool ActivateAndRaiseSelectedWindow('),
      source.indexOf('napi_value StartSession('),
    );

    expect(listSource).toContain('topmost_target_window_id');
    expect(listSource).toContain('const bool candidate_eligible =');
    expect(listSource).toContain('ax_classified && !ax_dialog && !protected_prompt');
    expect(listSource).toContain('"ownerKind", StringValue(env, owner_kind)');
    expect(listSource).not.toContain('app_eligible && frontmost_pid == pid');
    expect(source).toContain('activateWithOptions:options');
    expect(source).toContain('AXUIElementPerformAction(selected_window, kAXRaiseAction)');
    expect(source).toContain('kStartActivationPollAttempts = 20');
    expect(activationSource.match(/CheckCancellationEpoch\(/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(startSource.match(/CheckCancellationEpoch\(/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(startSource).toContain('ComputerWindowIdentityDigest');
    expect(startSource).toContain('&new_session_target, false');
    expect(startSource).toContain('new_session_target.active_window_kind != "application"');
    expect(startSource).toContain('focused_new_session_target.dialog_set_digest !=');
    expect(startSource).toContain('topmost_target_window_id != window_id');
    expect(startSource).toContain('FrontmostPid() != pid');
    expect(source).toContain('session->cancel_epoch.load(std::memory_order_acquire)');
    expect(source).toContain('cancellation_epoch.compare_exchange_weak');
  });

  it('resumes an existing session on its unchanged safe dialog without raising the primary window', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const startSource = source.slice(
      source.indexOf('napi_value StartSession('),
      source.indexOf('napi_value CloseSession('),
    );
    expect(startSource).toContain('CaptureMacDialogSetSnapshot(pid, window_id, app_identity,');
    expect(startSource).toContain('process_generation, &resume_target, false');
    expect(startSource).toContain('existing_session->dialog_set_digest ==');
    expect(startSource).toContain('resume_target.active_window_identity');
    expect(startSource).toContain('activation_window_id = resume_target.active_window_id');
    expect(startSource).toContain('activation_bounds = resume_target.active_bounds');
    expect(startSource).toContain('"DIALOG_USER_TAKEOVER"');
    expect(startSource.indexOf('if (creating_session) {')).toBeLessThan(
      startSource.indexOf('topmost_target_window_id != window_id'),
    );
    expect(startSource).toContain('focused_resume_target.dialog_set_digest !=');
  });

  it('explicitly resumes onto a currently safe dialog set only after invalidating the old observation', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const startSource = source.slice(
      source.indexOf('napi_value StartSession('),
      source.indexOf('napi_value CloseSession('),
    );
    const explicitResumeStart = startSource.indexOf('if (explicit_resume) {');
    const explicitResumeSource = startSource.slice(
      explicitResumeStart,
      startSource.indexOf('} else {', explicitResumeStart),
    );
    expect(startSource).toContain('ReadOptionalNamedBool(env, argv[0], "resume"');
    expect(startSource).toContain('creating_session && explicit_resume');
    expect(startSource).toContain('if (explicit_resume) {');
    expect(startSource).toContain('existing_session->dialog_set_revision += 1');
    expect(startSource).toContain('existing_session->has_observation = false');
    expect(startSource).toContain('existing_session->focused_control_signature.clear()');
    expect(startSource).toContain('existing_session->semantic_control_signatures.clear()');
    expect(startSource).toContain('existing_session->visual_control_signatures.clear()');
    expect(startSource).toContain('existing_session->visual_patch_digests.clear()');
    expect(startSource).toContain('resume_binding_matches = true');
    expect(explicitResumeSource).not.toContain('dispatch_replay_cache.clear()');
    expect(explicitResumeSource).not.toContain('dispatch_replay_order.clear()');
    expect(source).toContain('cached->second.envelope_digest != request->envelope_digest');
    expect(source).toContain('native_request_id_conflict');
  });

  it('launches only the exact registered bundle and re-verifies identity before listing windows', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const launchSource = source.slice(
      source.indexOf('NSURL* ExactApplicationBundleUrlForExecutable('),
      source.indexOf('napi_value PickApplication('),
    );
    const listStart = source.indexOf('napi_value ListWindows(');
    const listSource = source.slice(
      listStart,
      source.indexOf('bool ReadAccessibilityWindowBounds(', listStart),
    );
    expect(launchSource).toContain('NSWorkspaceOpenConfiguration');
    expect(launchSource).toContain('openApplicationAtURL:bundle_url');
    expect(launchSource).toContain('configuration.activates = NO');
    expect(launchSource).not.toContain('configuration.activates = YES');
    expect(launchSource).toContain('SameMacExecutablePath');
    expect(launchSource).toContain('before_launch.identity_digest != expected_identity');
    expect(launchSource).toContain('CurrentApplicationMatchesIdentityNative');
    expect(launchSource).toContain('kLaunchCompletionPollAttempts = 200');
    expect(launchSource).toContain('kLaunchIdentityPollAttempts = 100');
    expect(launchSource).toContain('ReadFrontmostWindow(pid');
    expect(listSource).toContain(
      'pid = LaunchExactRegisteredApplication(app_identity, executable_path)',
    );
    expect(listSource).toContain('const bool cached_pid_matches =');
    expect(listSource).toContain('if (!cached_pid_matches)');
  });

  it('never advertises an AX dialog or protected prompt as an onboarding primary window', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const listStart = source.indexOf('napi_value ListWindows(');
    const listSource = source.slice(
      listStart,
      source.indexOf('bool ReadAccessibilityWindowBounds(', listStart),
    );
    expect(listSource).toContain('FindUniqueAccessibilityWindow(pid, bounds)');
    expect(listSource).toContain('kAXFocusedWindowAttribute');
    expect(listSource).toContain('hosts_focused_ax_surface');
    expect(listSource).toContain('CGRectContainsRect(bounds, focused_ax_bounds)');
    expect(listSource).toContain('IsDialogAccessibilityDescriptor(role, subrole)');
    expect(listSource).toContain('IsFileOrSystemPromptTitle(ax_title)');
    expect(listSource).toContain('normalized.find("axsystemdialog")');
    expect(listSource).toContain('!ax_dialog && !protected_prompt');
    expect(listSource).toContain('protected_prompt ? "dialog"');
    expect(listSource).toContain('foreign_system_prompt');
    expect(listSource).toContain('? "unknown"');
    expect(listSource).toContain('? "dialog" : "application"');
  });

  it('binds observation revision and captured geometry inside the native mac session', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const observeSource = source.slice(
      source.indexOf('napi_value Observe('),
      source.indexOf('bool ReadNamedInt32('),
    );
    expect(source).toContain(
      'std::unordered_map<std::string, std::shared_ptr<MacComputerUseSession>> mac_sessions',
    );
    expect(source).toContain('CGRect expected_bounds');
    expect(source).toContain('std::uint64_t observation_revision');
    expect(observeSource).toContain('session.observation_revision += 1');
    expect(observeSource).toContain('session.observation_bounds = observed_dialogs.active_bounds');
    expect(observeSource).toContain('BoundsEqual(base_bounds, session.expected_bounds)');
    expect(source).toContain('request->observation_revision != session.observation_revision');
    expect(source).toContain('session->observation_revision != request.observation_revision');
    expect(source).toContain(
      'BoundsEqual(session->observation_bounds, request.observation_bounds)',
    );
    expect(source).toContain('mac_sessions.erase(session_id)');
    expect(source).toContain('"nativeObservationRevision"');
  });

  it('binds native actions to bounded AX control signatures captured by the observation', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const signatureSource = source.slice(
      source.indexOf('bool ComputeAccessibilityControlSignature('),
      source.indexOf('std::string AccessibilityTargetLookupDigest('),
    );
    const observeSource = source.slice(
      source.indexOf('napi_value Observe('),
      source.indexOf('bool ReadNamedInt32('),
    );
    const dispatchSource = source.slice(
      source.indexOf('AXUIElementRef FindBoundSemanticTarget('),
      source.indexOf('napi_value Cancel('),
    );

    expect(signatureSource).toContain('AXUIElementGetPid');
    expect(signatureSource).toContain('CFHash(element)');
    expect(signatureSource).toContain('kAXRoleAttribute');
    expect(signatureSource).toContain('kAXSubroleAttribute');
    expect(signatureSource).toContain('kAXIdentifierAttribute');
    expect(signatureSource).toContain('ReadAccessibilityWindowBounds(element, &bounds)');
    expect(signatureSource).not.toContain('kAXTitleAttribute');
    expect(signatureSource).not.toContain('kAXValueAttribute');
    expect(observeSource).toContain('CaptureAccessibilityControlBindings');
    expect(observeSource).toContain('session.focused_control_signature');
    expect(observeSource).toContain('session.semantic_control_signatures');
    expect(observeSource).toContain('session.visual_control_signatures');
    expect(dispatchSource).toContain(
      'current_control_signature != request.focused_control_signature',
    );
    expect(dispatchSource).toContain('request.visual_control_signatures.contains');
    expect(dispatchSource).toContain('AccessibilityTargetLookupDigest(request->target_id)');
    expect(source).toContain('current_target_signature != request.expected_target_signature');
  });

  it('queues each dispatch asynchronously on a serial native effect lane with cancel-safe lifetime', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const executeSource = source.slice(
      source.indexOf('void ExecuteNativeDispatch('),
      source.indexOf('void CompleteNativeDispatch('),
    );
    expect(source).toContain('napi_create_async_work');
    expect(source).toContain('napi_queue_async_work');
    expect(source).toContain('std::lock_guard<std::mutex> serial_lock(mac_dispatch_serial_mutex)');
    expect(source).toContain('std::shared_ptr<MacComputerUseSession> session');
    expect(source).toContain('std::atomic<bool> closed');
    expect(executeSource).toContain('PerformNativeDispatch(work->request)');
    expect(executeSource).not.toContain('napi_get_named_property');
    expect(source).toContain('session->cancel_epoch.store(requested_cancel_epoch');
    expect(source).toContain('DispatchCancellationStillValid(request)');
    expect(source).toContain('between_mouse_events = RevalidateBoundTarget(request)');
    expect(source).toContain('between_key_events = RevalidateBoundTarget(request)');
  });

  it('binds request/session/observation/action digest and replays only identical bounded requests', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const parserSource = source.slice(
      source.indexOf('bool ParseNativeDispatchRequest('),
      source.indexOf('struct AsyncNativeDispatchWork'),
    );
    expect(source).toContain('kMaxDispatchReplayEntries = 128');
    expect(source).toContain('kMaxInflightDispatchEntries = 1');
    expect(parserSource).toContain('"requestId"');
    expect(parserSource).toContain('"sessionId"');
    expect(parserSource).toContain('"observationRevision"');
    expect(parserSource).toContain('"actionDigest"');
    expect(parserSource).toContain('computer-native-dispatch-envelope-v1');
    expect(parserSource).toContain('native_request_id_conflict');
    expect(parserSource).toContain('native_dispatch_busy');
    expect(source).toContain('"accepted"');
    expect(source).toContain('"effectStarted"');
    expect(source).toContain('"unknown_effect"');
  });

  it('recaptures and compares an observation-bound local visual patch before click or scroll', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    const visualSource = source.slice(
      source.indexOf('bool FreshVisualPatchMatches('),
      source.indexOf('NativeDispatchOutcome PerformFocusedInputDispatch('),
    );
    expect(source).toContain('ComputeVisualPatchDigests');
    expect(source).toContain('kVisualPatchColumns = 16');
    expect(source).toContain('session.visual_patch_digests = std::move(visual_patch_digests)');
    expect(visualSource).toContain('CaptureWindowPng(active');
    expect(visualSource).toContain('fresh_patch_digests[patch_index] !=');
    expect(visualSource).toContain('native_visual_patch_changed');
    expect(visualSource.indexOf('FreshVisualPatchMatches(request')).toBeLessThan(
      visualSource.indexOf('CGEventCreateMouseEvent'),
    );
  });

  it('returns dialog-set revision and active-window identity as native-only observation bindings', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
      'utf8',
    );
    expect(source).toContain('session.dialog_set_revision += 1');
    expect(source).toContain('"dialogSetRevision"');
    expect(source).toContain('"dialogSetDigest"');
    expect(source).toContain('"activeWindowIdentityDigest"');
    expect(source).toContain('"activeWindowKind"');
  });
});

describe('Computer Use native manifest and runtime gate', () => {
  it('rejects artifact path traversal and invalid trusted manifests', () => {
    const validManifest = {
      version: 1,
      sourceCommit: 'f'.repeat(40),
      platform: 'darwin',
      architecture: 'arm64',
      protocolVersion: 1,
      apiVersion: 1,
      nativeVersion: 'computer-use-native-gate0-1',
      moduleDigest: 'a'.repeat(64),
      binaryDigest: 'a'.repeat(64),
      signerDigest: 'a'.repeat(64),
      capabilities: ['observe'],
    } as const;
    expect(() =>
      parseComputerUseNativeManifest({ ...validManifest, artifact: { file: '../escape.node' } }),
    ).toThrow();
  });

  it('keeps source builds disabled even when the flag is set', () => {
    const fixture = packageFixture();
    const binding = loadComputerUseNative({
      environment: { [COMPUTER_USE_NATIVE_FEATURE_FLAG]: '1' },
      dirname: join(fixture.root, 'src', 'main'),
      resourcesPath: fixture.resources,
      platform: 'darwin',
      architecture: 'arm64',
      requireAddon: () => ({
        probe: () => ({ protocolVersion: 1, apiVersion: 1, available: true, backend: 'fixture' }),
      }),
    });
    expect(binding.probe.available).toBe(false);
    expect(binding.probe.reason).toBe('PACKAGED_RUNTIME_REQUIRED');
  });

  it('requires the feature flag, packaged path, digest, and native handshake', () => {
    const fixture = packageFixture();
    const addon = {
      probe: () => ({ protocolVersion: 1, apiVersion: 1, available: true, backend: 'fixture' }),
      handshake: () => ({ protocolVersion: 1, apiVersion: 1, platform: 'darwin', napiVersion: 10 }),
    };
    const binding = loadComputerUseNative({
      environment: { [COMPUTER_USE_NATIVE_FEATURE_FLAG]: '1' },
      dirname: fixture.packagedDirname,
      resourcesPath: fixture.resources,
      platform: 'darwin',
      architecture: 'arm64',
      requireAddon: () => addon,
      verifySignature: () => 'a'.repeat(64),
    });
    expect(binding.probe).toMatchObject({ available: true, backend: 'fixture' });
    expect(binding.addon).toBe(addon);

    const signerMismatch = loadComputerUseNative({
      environment: { [COMPUTER_USE_NATIVE_FEATURE_FLAG]: '1' },
      dirname: fixture.packagedDirname,
      resourcesPath: fixture.resources,
      platform: 'darwin',
      architecture: 'arm64',
      requireAddon: () => addon,
      verifySignature: () => 'b'.repeat(64),
    });
    expect(signerMismatch.probe.reason).toBe('ARTIFACT_SIGNATURE_MISMATCH');

    const flagOff = loadComputerUseNative({
      dirname: fixture.packagedDirname,
      resourcesPath: fixture.resources,
      platform: 'darwin',
      architecture: 'arm64',
      requireAddon: () => addon,
    });
    expect(flagOff.probe.reason).toBe('FEATURE_FLAG_DISABLED');
  });

  it('rejects ad-hoc macOS and unsigned Windows manifests before loading artifacts', () => {
    for (const [platform, trust] of [
      ['darwin', 'ad-hoc'],
      ['win32', 'unsigned'],
    ] as const) {
      const fixture = packageFixture({ platform, trust });
      let loaded = false;
      const binding = loadComputerUseNative({
        environment: { [COMPUTER_USE_NATIVE_FEATURE_FLAG]: '1' },
        dirname: fixture.packagedDirname,
        resourcesPath: fixture.resources,
        platform,
        architecture: platform === 'darwin' ? 'arm64' : 'x64',
        requireAddon: () => {
          loaded = true;
          return {
            probe: () => ({
              protocolVersion: 1,
              apiVersion: 1,
              available: true,
              backend: 'fixture',
            }),
          };
        },
        probeHelper: () => {
          loaded = true;
          return { protocolVersion: 1, apiVersion: 1, available: true, backend: 'fixture' };
        },
      });
      expect(binding.probe.available).toBe(false);
      expect(binding.probe.reason).toMatch(/SIGNATURE_REQUIRED/u);
      expect(loaded).toBe(false);
    }
  });

  it('requires an attested available probe and matching artifact facts', () => {
    const fixture = packageFixture();
    const manifest = JSON.parse(
      readFileSync(join(fixture.resources, 'computer-use-native.manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(
      evaluateComputerUseNativeGate({
        featureFlag: true,
        packaged: true,
        platform: 'darwin',
        manifest,
        probe: { protocolVersion: 1, apiVersion: 1, available: false, backend: 'fixture' },
        artifactDigest: manifest['moduleDigest'],
      }).available,
    ).toBe(false);
  });

  it('retains a verified handshake surface when only native permissions are unavailable', () => {
    const fixture = packageFixture();
    const addon = {
      probe: () => ({
        protocolVersion: 1,
        apiVersion: 1,
        available: false,
        backend: 'fixture',
      }),
      handshake: () => ({ protocolVersion: 1, apiVersion: 1, platform: 'darwin', napiVersion: 10 }),
    };
    const binding = loadComputerUseNative({
      environment: { [COMPUTER_USE_NATIVE_FEATURE_FLAG]: '1' },
      dirname: fixture.packagedDirname,
      resourcesPath: fixture.resources,
      platform: 'darwin',
      architecture: 'arm64',
      requireAddon: () => addon,
      verifySignature: () => 'a'.repeat(64),
    });

    expect(binding.probe).toMatchObject({
      available: false,
      reason: 'NATIVE_PROBE_UNAVAILABLE',
    });
    expect(binding.addon).toBe(addon);
  });

  it('exposes the complete signed Windows controller surface after an API-ready probe', () => {
    const fixture = packageFixture({ platform: 'win32', trust: 'authenticode' });
    const binding = loadComputerUseNative({
      environment: { [COMPUTER_USE_NATIVE_FEATURE_FLAG]: '1' },
      dirname: fixture.packagedDirname,
      resourcesPath: fixture.resources,
      platform: 'win32',
      architecture: 'x64',
      verifySignature: () => 'a'.repeat(64),
      probeHelper: () => ({
        protocolVersion: 1,
        apiVersion: 1,
        sourceCommit: 'f'.repeat(40),
        platform: 'win32',
        napiVersion: 10,
        available: true,
        backend: 'windows-uia-graphics-capture-sendinput',
      }),
    });

    expect(binding.probe.available).toBe(true);
    expect(binding.addon).toMatchObject({
      pickApplication: expect.any(Function),
      listWindows: expect.any(Function),
      startSession: expect.any(Function),
      observe: expect.any(Function),
      dispatch: expect.any(Function),
      cancel: expect.any(Function),
      close: expect.any(Function),
    });
    expect(
      createComputerUseNativeHost(binding, 'win32', {
        windowsPhysicalBoundsToDip: (bounds) => bounds,
      }).availability(),
    ).toMatchObject({
      state: 'ready',
      packageReady: true,
      handshakeReady: true,
      observe: true,
      control: true,
      available: true,
    });
  });

  it('rejects a signed Windows helper built from a different source commit', () => {
    const fixture = packageFixture({ platform: 'win32', trust: 'authenticode' });
    const binding = loadComputerUseNative({
      environment: { [COMPUTER_USE_NATIVE_FEATURE_FLAG]: '1' },
      dirname: fixture.packagedDirname,
      resourcesPath: fixture.resources,
      platform: 'win32',
      architecture: 'x64',
      verifySignature: () => 'a'.repeat(64),
      probeHelper: () => ({
        protocolVersion: 1,
        apiVersion: 1,
        sourceCommit: 'e'.repeat(40),
        platform: 'win32',
        napiVersion: 10,
        available: true,
        backend: 'windows-uia-graphics-capture-sendinput',
      }),
    });

    expect(binding.probe).toMatchObject({
      available: false,
      reason: 'SOURCE_COMMIT_MISMATCH',
    });
    expect(binding.addon).toBeNull();
  });
});
