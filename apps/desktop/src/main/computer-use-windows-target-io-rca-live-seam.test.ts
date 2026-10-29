import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #940-1: the real ServePipe reader/consumer and real named-pipe framing. Held workers must not
// delay Stop/Close, publish stale results, or admit another synchronous target operation.
// Gates are injected only into generated test source; only our own fixture windows are enumerated.
const nativeDirectory = join(__dirname, '../../computer-use-native');
const host = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
const measurement = '  out->measured = MeasureWindowsTargetFacts(pid, nullptr, context);';
const enumeration = 'EnumWindows(CollectWindowsV2TopLevel, reinterpret_cast<LPARAM>(&windows))';
const contextFactory =
  '  WindowsTargetFactsContext context = had_cached_context ? *cached : CurrentWindowsTargetFactsContext(';
const completion = '        // All measured handles and COM objects are gone';
const adoption =
  '    // Stop and adoption share this lock; a late result cannot advance the generation.';
const consumer =
  '    if (!HandlePipeRequest(pipe, probe, queued.frame, &handshaken, queued.stop_serial,';
const uiaContact =
  'WindowsV1UiaContact(root, [&] { return automation->ElementFromHandle(window, &root); });';
const startReady = '  const auto begin_focus = [&] {';
const startAdopt = '  // Stop and final start adoption share this lock.';
const startEpilogue =
  '        // Adopted handles belong to the session; this worker must not release the shared slot.';

function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error('RCA seam source boundary changed');
  return source.replace(before, after);
}

function instrumentedHost(): string {
  let source = replaceOnce(
    replaceOnce(host, measurement, `  Sc940MeasureGate(pid);\n${measurement}`),
    enumeration,
    'Sc940EnumerateOwnedWindow(CollectWindowsV2TopLevel, reinterpret_cast<LPARAM>(&windows))',
  );
  source = replaceOnce(
    source,
    contextFactory,
    `  if (!had_cached_context) Sc940ContextGate();\n${contextFactory}`,
  );
  source = replaceOnce(source, completion, `        Sc940CompletionGate();\n${completion}`);
  source = replaceOnce(source, adoption, `    Sc940AdoptionGate();\n${adoption}`);
  source = replaceOnce(
    source,
    consumer,
    `    Sc940ConsumerGate(queued.frame.header.request_id.bytes[0]);\n${consumer}`,
  );
  const rejudgeFrom = source.indexOf('// BEGIN windows v2 rejudge');
  const rejudgeTo = source.indexOf('// END windows v2 rejudge', rejudgeFrom);
  if (rejudgeFrom < 0 || rejudgeTo < 0) throw new Error('Rejudge boundary changed');
  let rejudge = replaceOnce(
    source.slice(rejudgeFrom, rejudgeTo),
    'ReadWindowsFileIdentity(work.executable.value, &held)',
    'Sc940RejudgeFileIdentity(work, &held)',
  );
  rejudge = replaceOnce(
    rejudge,
    'void WindowsV2RejudgeWorkerLoop(WindowsV2RejudgeState *state) {',
    'void WindowsV2RejudgeWorkerLoop(WindowsV2RejudgeState *state) {\n  Sc940RejudgeWorkerStarted();',
  );
  rejudge = replaceOnce(
    rejudge,
    '    CancelSynchronousIo(state.cancellation_thread);',
    '    { Sc940RejudgeCancelAttempt(job_id, GetThreadId(state.cancellation_thread)); CancelSynchronousIo(state.cancellation_thread); }',
  );
  rejudge = replaceOnce(
    rejudge,
    '    context = CurrentWindowsTargetFactsContext(work.main_pid, std::move(signer),',
    '    Sc940RejudgeContextGate(work);\n    context = CurrentWindowsTargetFactsContext(work.main_pid, std::move(signer),',
  );
  rejudge = replaceOnce(
    rejudge,
    "    // Rejudge job retirement precedes result publication. No old job may touch a new job's slot.",
    "    Sc940RejudgeRetired(job_id);\n    // Rejudge job retirement precedes result publication. No old job may touch a new job's slot.",
  );
  source = source.slice(0, rejudgeFrom) + rejudge + source.slice(rejudgeTo);
  const measureFrom = source.indexOf('bool MeasureWindowsNewStart(');
  const measureTo = source.indexOf('struct WindowsNewStartWaitGuard', measureFrom);
  if (measureFrom < 0 || measureTo < 0) throw new Error('Start measurement boundary changed');
  source =
    source.slice(0, measureFrom) +
    replaceOnce(
      source.slice(measureFrom, measureTo),
      'OpenLockedProcessExecutable(target_process->value, process_executable)',
      'Sc940StartOpen(target_process->value, process_executable)',
    ) +
    source.slice(measureTo);
  const startFrom = source.indexOf('bool StartWindowsNewSession(');
  const startTo = source.indexOf('// BEGIN windows shared existing start', startFrom);
  if (startFrom < 0 || startTo < 0) throw new Error('Start consumer boundary changed');
  let newStart = source.slice(startFrom, startTo);
  newStart = replaceOnce(newStart, startReady, `${startReady}\n    Sc940StartReadyGate();`);
  newStart = replaceOnce(newStart, startAdopt, `  Sc940StartAdoptGate();\n${startAdopt}`);
  newStart = replaceOnce(
    newStart,
    startEpilogue,
    `        Sc940StartEpilogueGate();\n${startEpilogue}`,
  );
  newStart = replaceOnce(
    newStart,
    '    std::thread([pending, input]() mutable {',
    '    Sc940StartWorkerAttempt();\n    std::thread([pending, input]() mutable {',
  );
  newStart = replaceOnce(
    newStart,
    'ShowWindow(input.window, SW_RESTORE);',
    'Sc940StartShow(input.window, SW_RESTORE);',
  );
  newStart = replaceOnce(
    newStart,
    'SetForegroundWindow(input.window);',
    'Sc940StartForeground(input.window);',
  );
  source = source.slice(0, startFrom) + newStart + source.slice(startTo);
  const resumeFrom = source.indexOf('// BEGIN windows shared existing start');
  const resumeTo = source.indexOf('// END windows shared existing start', resumeFrom);
  if (resumeFrom < 0 || resumeTo < 0) throw new Error('Resume consumer boundary changed');
  let resume = replaceOnce(
    source.slice(resumeFrom, resumeTo),
    'OpenLockedProcessExecutable(target_process.value, &current_executable)',
    'Sc940ResumeOpen(work, target_process.value, &current_executable)',
  );
  const heldRead = 'ReadWindowsFileIdentity(work.executable.value, &held)';
  if (resume.split(heldRead).length !== 3)
    throw new Error('Both resume identity reads must remain');
  resume = resume.replaceAll(heldRead, 'Sc940ResumeFileIdentity(work, &held)');
  resume = replaceOnce(
    resume,
    '      context = CurrentWindowsTargetFactsContext(input.main_pid, std::move(signer),',
    '      Sc940ResumeContextGate(work);\n      context = CurrentWindowsTargetFactsContext(input.main_pid, std::move(signer),',
  );
  resume = replaceOnce(
    resume,
    '  // Existing start worker entry; this job owns its thread and source duplicates.',
    '  // Existing start worker entry; this job owns its thread and source duplicates.\n  Sc940ResumeWorkerStarted(*work);',
  );
  resume = replaceOnce(
    resume,
    '  if (pending->thread.value != nullptr) CancelSynchronousIo(pending->thread.value);',
    '  if (pending->thread.value != nullptr) { Sc940ResumeCancelAttempt(); CancelSynchronousIo(pending->thread.value); }',
  );
  const ticketInvalidation = 'InvalidateWindowsTicket(input.session_key);';
  if (resume.split(ticketInvalidation).length !== 4)
    throw new Error('Resume ticket boundaries changed');
  resume = resume.replaceAll(ticketInvalidation, 'Sc940ResumeInvalidateTicket(input.session_key);');
  resume = replaceOnce(
    resume,
    '  // Existing start before consumer focus preparation.',
    '  // Existing start before consumer focus preparation.\n  if (!Sc940ResumeSourcePin(session, before)) { *reason = "diagnostic_source_pin"; return false; }',
  );
  resume = replaceOnce(
    resume,
    '  const auto begin_focus = [&] {',
    '  Sc940ResumePrepareFocus(input.window);\n  const auto begin_focus = [&] {',
  );
  resume = replaceOnce(resume, 'ResolveWindowsExplicitResumeTarget(', 'Sc940ResumeResolve(');
  resume = replaceOnce(resume, 'ResolveWindowsSessionRefocusTarget(', 'Sc940ResumeRefocus(');
  resume = replaceOnce(
    resume,
    'ShowWindow(input.window, SW_RESTORE);',
    'Sc940ResumeShow(input.window, SW_RESTORE);',
  );
  resume = replaceOnce(
    resume,
    'ShowWindow(refocus_window, SW_RESTORE);',
    'Sc940ResumeShow(refocus_window, SW_RESTORE);',
  );
  resume = replaceOnce(
    resume,
    'SetForegroundWindow(refocus_window);',
    'Sc940ResumeForeground(refocus_window);',
  );
  source = source.slice(0, resumeFrom) + resume + source.slice(resumeTo);
  for (const [begin, end, call] of [
    [
      'WindowsUiaRisk ClassifyWindowsPointOnWorker(',
      '\nWindowsUiaRisk ClassifyWindowsFocusedElementOnWorker(',
      'automation->ElementFromPoint(query, &element)',
    ],
    [
      'WindowsUiaRisk ClassifyWindowsFocusedElementOnWorker(',
      '\nbool ComputeWindowsControlSignature(',
      'automation->GetFocusedElement(&element)',
    ],
  ] as const) {
    const from = source.indexOf(begin);
    const to = source.indexOf(end, from);
    if (from < 0 || to < from) throw new Error('Classification contact boundary changed');
    source =
      source.slice(0, from) +
      replaceOnce(
        source.slice(from, to),
        call,
        `(Sc820ClassificationContactHeld() ? Sc820HeldClassificationContact(automation, &element) : ${call})`,
      ) +
      source.slice(to);
  }
  for (const [begin, end, call, output] of [
    [
      'bool CaptureWindowsControlBindingsOnWorker(',
      '\nbool WindowsFocusedElementSignatureOnWorker(',
      'automation->ElementFromHandle(window, &root)',
      '&root',
    ],
    [
      'bool WindowsFocusedElementSignatureOnWorker(',
      '\nbool RejectWindowsRisk(',
      'automation->GetFocusedElement(&element)',
      '&element',
    ],
  ] as const) {
    const from = source.indexOf(begin);
    const to = source.indexOf(end, from);
    if (from < 0 || to < from) throw new Error('Binding read contact boundary changed');
    source =
      source.slice(0, from) +
      replaceOnce(
        source.slice(from, to),
        call,
        `(Sc820ClassificationContactHeld() ? Sc820HeldClassificationContact(automation, ${output}) : ${call})`,
      ) +
      source.slice(to);
  }
  const semanticFrom = source.indexOf('bool FindWindowsSemanticTarget(');
  const semanticTo = source.indexOf('\nbool Utf16FromUtf8(', semanticFrom);
  if (semanticFrom < 0 || semanticTo < semanticFrom)
    throw new Error('Semantic search contact boundary changed');
  const semantic = replaceOnce(
    source.slice(semanticFrom, semanticTo),
    'automation->ElementFromHandle(window, &root)',
    '(Sc820ClassificationContactHeld() ? Sc820HeldClassificationContact(automation, &root) : automation->ElementFromHandle(window, &root))',
  );
  source = source.slice(0, semanticFrom) + semantic + source.slice(semanticTo);
  const observeFrom = source.indexOf('bool ObserveWindowsWindow(');
  const observeTo = source.indexOf('\nstruct ArtifactReadPending', observeFrom);
  if (observeFrom < 0 || observeTo < observeFrom) throw new Error('Observe boundary changed');
  let observe = source.slice(observeFrom, observeTo);
  for (const [name, wrapper, count] of [
    ['ValidateWindowsSession(', 'Sc820ObserveValidate(', 2],
    ['ReadUiaObservation(', 'Sc820ObserveTree(', 2],
    ['CaptureWindowsControlBindings(', 'Sc820ObserveBindings(', 2],
    ['ClassifyWindowsFocusedElement(', 'Sc820ObserveRisk(', 1],
    ['ScreenBoundsPhysicalForWindow(', 'Sc820ObserveScreen(', 1],
  ] as const) {
    if (observe.split(name).length !== count + 1)
      throw new Error('Observe dependency boundary changed');
    observe = observe.replaceAll(name, wrapper);
  }
  source = source.slice(0, observeFrom) + observe + source.slice(observeTo);
  source = replaceOnce(
    source,
    '    std::thread([pending, snapshot, preserve_stopped_result, measure = std::move(measure)]() mutable {',
    '    std::thread([pending, snapshot, preserve_stopped_result, measure = std::move(measure)]() mutable {\n      Sc820ReadWorkerStarted();',
  );
  source = replaceOnce(
    source,
    'HRESULT CreateWindowsV1Automation(IUIAutomation **automation) {',
    'HRESULT CreateWindowsV1Automation(IUIAutomation **automation) {\n  Sc820AutomationCreated();',
  );
  const riskFrom = source.indexOf('WindowsUiaRisk ClassifyWindowsUiaElementSelf(');
  const riskTo = source.indexOf('struct WindowsUiaPointResult', riskFrom);
  let risk = source.slice(riskFrom, riskTo);
  risk = replaceOnce(risk, 'element->get_CurrentName(&name)', 'Sc820ReadName(element, &name)');
  risk = replaceOnce(
    risk,
    'walker->GetParentElement(current, &parent)',
    'Sc820ReadParent(walker, current, &parent)',
  );
  risk = risk.replace(
    /(parent|current|walker|automation|element)->Release\(\)/gu,
    'Sc820Release($1)',
  );
  risk = risk.replaceAll('SysFreeString(', 'Sc820FreeBstr(');
  source = source.slice(0, riskFrom) + risk + source.slice(riskTo);
  const signatureFrom = source.indexOf(
    'bool ComputeWindowsControlSignature(',
    source.indexOf('struct WindowsUiaPointResult'),
  );
  const signatureTo = source.indexOf('struct WindowsControlBindings', signatureFrom);
  let signature = source.slice(signatureFrom, signatureTo);
  signature = replaceOnce(
    signature,
    'element->GetRuntimeId(&runtime_id)',
    'Sc820RuntimeId(element, &runtime_id)',
  );
  signature = replaceOnce(signature, 'Sha256String(material)', 'Sc820SignatureHash(material)');
  signature = replaceOnce(
    signature,
    'element->get_CurrentAutomationId(&automation_id)',
    'Sc820BindingAutomationId(element, &automation_id)',
  );
  signature = signature.replaceAll('SysFreeString(', 'Sc820FreeBstr(');
  signature = signature
    .replaceAll('SafeArrayUnaccessData(runtime_id)', 'Sc820UnaccessArray(runtime_id)')
    .replaceAll('SafeArrayDestroy(runtime_id)', 'Sc820DestroyArray(runtime_id)');
  source = source.slice(0, signatureFrom) + signature + source.slice(signatureTo);
  const bindingsFrom = source.indexOf('bool ReadWindowsElementTargetId(');
  const bindingsTo = source.indexOf('\nbool RejectWindowsRisk(', bindingsFrom);
  let bindings = source.slice(bindingsFrom, bindingsTo);
  bindings = replaceOnce(
    bindings,
    'element->get_CurrentAutomationId(&automation_id)',
    'Sc820BindingAutomationId(element, &automation_id)',
  );
  bindings = replaceOnce(
    bindings,
    'element->get_CurrentName(&name)',
    'Sc820BindingName(element, &name)',
  );
  bindings = replaceOnce(
    bindings,
    'walker->GetFirstChildElement(element, &child)',
    'Sc820BindingFirst(walker, element, &child)',
  );
  bindings = replaceOnce(
    bindings,
    'walker->GetNextSiblingElement(child, &next)',
    'Sc820BindingNext(walker, child, &next)',
  );
  bindings = replaceOnce(
    bindings,
    'automation->get_RawViewWalker(&walker)',
    'Sc820BindingWalker(automation, &walker)',
  );
  if (bindings.split('CreateWindowsV1Automation(&automation)').length !== 3)
    throw new Error('Binding factory boundary changed');
  bindings = bindings.replaceAll(
    'CreateWindowsV1Automation(&automation)',
    'Sc820BindingAutomation(&automation)',
  );
  bindings = bindings
    .replace(/(next|child|root|walker|automation|element)->Release\(\)/gu, 'Sc820Release($1)')
    .replaceAll('SysFreeString(', 'Sc820FreeBstr(');
  source = source.slice(0, bindingsFrom) + bindings + source.slice(bindingsTo);
  const engineFrom = source.indexOf('bool RunWindowsUiaRead(');
  const engineTo = source.indexOf('struct WindowsUiaObservationResult', engineFrom);
  const engine = replaceOnce(
    source.slice(engineFrom, engineTo),
    '~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }',
    '~Apartment() { if (SUCCEEDED(result)) Sc820ReadCoUninitialize(); }',
  );
  source = source.slice(0, engineFrom) + engine + source.slice(engineTo);
  const readFrom = source.indexOf('bool ReadUiaObservationOnWorker(');
  const readTo = source.indexOf('bool ReadUiaObservation(', readFrom);
  if (readFrom < 0 || readTo < 0) throw new Error('Observation worker boundary changed');
  source =
    source.slice(0, readFrom) +
    replaceOnce(
      replaceOnce(
        source.slice(readFrom, readTo),
        uiaContact,
        `WindowsV1UiaContact(root, [&] {
        if (!Sc820ContactGate(window)) return E_ABORT;
        const HRESULT result = automation->ElementFromHandle(window, &root);
        Sc820ContactResult(SUCCEEDED(result), root != nullptr);
        return result;
      });`,
      ),
      'if (root != nullptr) root->Release();',
      'if (root != nullptr) { root->Release(); Sc820RootReleased(); }',
    ) +
    source.slice(readTo);
  source = replaceOnce(
    source,
    '    if (operation == "read_node_value") {',
    `    if (operation == "sc940_resume_component") {
      WindowsSession *session = FindWindowsSession(request);
      if (session == nullptr) return Respond(pipe, request, MessageType::kError, ErrorPayload("session_missing"));
      try {
        return Respond(pipe, request, MessageType::kProbeResult, Sc940ResumeComponent(*session, metadata, FrameIdKey(request.header.session_id)));
      } catch (...) {
        return Respond(pipe, request, MessageType::kError, ErrorPayload("sc940_resume_component_failed"));
      }
    }
    if (operation == "sc940_resume_baseline") {
      WindowsSession *session = FindWindowsSession(request);
      if (session == nullptr) return Respond(pipe, request, MessageType::kError, ErrorPayload("session_missing"));
      try {
        return Respond(pipe, request, MessageType::kProbeResult, Sc940ResumeBaseline(*session, metadata));
      } catch (...) {
        return Respond(pipe, request, MessageType::kError, ErrorPayload("sc940_resume_baseline_failed"));
      }
    }
    if (operation == "sc940_rejudge_probe") {
      try {
        return Respond(pipe, request, MessageType::kProbeResult, Sc940RejudgeProbe(metadata));
      } catch (...) {
        return Respond(pipe, request, MessageType::kError, ErrorPayload("sc940_rejudge_probe_failed"));
      }
    }
    if (operation == "sc940_validation_probe") {
      try {
        return Respond(pipe, request, MessageType::kProbeResult, Sc940ValidationProbe(metadata));
      } catch (...) {
        return Respond(pipe, request, MessageType::kError, ErrorPayload("sc940_validation_probe_failed"));
      }
    }
    if (operation == "sc820_semantic_stall_probe") {
      try {return Respond(pipe,request,MessageType::kProbeResult,Sc820SemanticStallProbe(metadata,queued_stop_serial));}
      catch(const std::exception& error){return Respond(pipe,request,MessageType::kError,ErrorPayload(error.what()));}
    }
    if (operation == "sc820_binding_healthy_probe") {
      try {return Respond(pipe, request, MessageType::kProbeResult, Sc820BindingHealthyProbe(queued_stop_serial));}
      catch(const std::exception& error){return Respond(pipe,request,MessageType::kProbeResult,ErrorPayload(error.what()));}
    }
    if (operation == "sc820_observe_signature_probe") {
      return Respond(pipe, request, MessageType::kProbeResult, Sc820ObserveSignatureProbe(queued_stop_serial));
    }
    if (operation == "sc820_binding_probe") {
      try {
        return Respond(pipe, request, MessageType::kProbeResult,
                       Sc820BindingProbe(metadata, queued_stop_serial));
      } catch (...) {
        return Respond(pipe, request, MessageType::kError, ErrorPayload("sc820_binding_probe_failed"));
      }
    }
    if (operation == "sc820_classification_probe") {
      try {
        return Respond(pipe, request, MessageType::kProbeResult,
                       Sc820ClassificationProbe(metadata, queued_stop_serial));
      } catch (...) {
        return Respond(pipe, request, MessageType::kError, ErrorPayload("sc820_classification_probe_failed"));
      }
    }
    if (operation == "sc820_read_probe") {
      try {
        return Respond(pipe, request, MessageType::kProbeResult,
                       Sc820ReadProbe(metadata, queued_stop_serial));
      } catch (...) {
        return Respond(pipe, request, MessageType::kError, ErrorPayload("sc820_probe_failed"));
      }
    }
    if (operation == "read_node_value") {`,
  );
  const identityFrom = source.indexOf(
    'WindowsSessionIdentityResult MeasureWindowsSessionIdentity(',
  );
  const identityTo = source.indexOf('// END windows session identity validation', identityFrom);
  if (identityFrom < 0 || identityTo < 0) throw new Error('Validation identity boundary changed');
  let identity = replaceOnce(
    source.slice(identityFrom, identityTo),
    'ReadWindowsFileIdentity(work.executable.value, &held_file_identity)',
    'Sc940ValidationFileIdentity(work, &held_file_identity)',
  );
  identity = replaceOnce(
    identity,
    'void WindowsValidationWorkerLoop(WindowsValidationState *state) {',
    'void WindowsValidationWorkerLoop(WindowsValidationState *state) {\n  Sc940ValidationWorkerStarted();',
  );
  identity = replaceOnce(
    identity,
    '    CancelSynchronousIo(state.cancellation_thread);',
    '    { Sc940ValidationCancelAttempt(job_id, GetThreadId(state.cancellation_thread)); CancelSynchronousIo(state.cancellation_thread); }',
  );
  identity = replaceOnce(
    identity,
    '    // Job retirement precedes result publication. Nothing below touches the shared slot or alias:',
    '    Sc940ValidationRetired(job_id);\n    // Job retirement precedes result publication. Nothing below touches the shared slot or alias:',
  );
  source = source.slice(0, identityFrom) + identity + source.slice(identityTo);
  const from = source.indexOf('bool ValidateWindowsSession(\n');
  const to = source.indexOf('bool ReadExact(', from);
  if (from < 0 || to < 0) throw new Error('Session validation boundary changed');
  return (
    source.slice(0, from) +
    replaceOnce(
      source.slice(from, to),
      '  WindowsSessionIdentityResult identity;',
      '  Sc940SyncSessionProbe();\n  WindowsSessionIdentityResult identity;',
    ) +
    source.slice(to)
  );
}

type Build = { file: string; args: (arguments_: string[]) => string[]; verbatim: boolean };
function compiler(): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return { file: 'cl.exe', args: (arguments_) => arguments_, verbatim: false };
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  if (!existsSync(vswhere)) return null;
  const found = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8' },
  );
  const vcvars = join(found.stdout.trim(), 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (found.status !== 0 || !existsSync(vcvars)) return null;
  return {
    file: 'cmd.exe',
    args: (arguments_) => [
      '/d',
      '/s',
      '/c',
      `"call "${vcvars}" >nul && cl.exe ${arguments_.map((argument) => `"${argument}"`).join(' ')}"`,
    ],
    verbatim: true,
  };
}

function run(file: string, args: string[], timeout: number, verbatim = false) {
  return new Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      const child = spawn(file, args, {
        windowsVerbatimArguments: verbatim,
        env: { ...process.env, VSLANG: '1033' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // vcvars starts cl/link below cmd.exe; killing only cmd can leave its pipes open forever.
        if (process.platform === 'win32' && child.pid !== undefined)
          spawnSync(
            join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/pid', String(child.pid), '/t', '/f'],
            { stdio: 'ignore', timeout: 5_000 },
          );
        child.kill();
      }, timeout);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ status: -1, stdout, stderr, timedOut });
      });
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr, timedOut });
      });
    },
  );
}

const program = String.raw`
#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>
#include <cstdint>
#include <optional>
#include <string>
namespace {
struct LockedWindowsExecutable;
struct WindowsSession;
struct WindowsDialogSetSnapshot;
struct WindowsControlBindings;
struct WindowsUiaRisk;
bool Sc820ObserveValidate(const WindowsSession&, RECT*, std::string*, WindowsDialogSetSnapshot*);
bool Sc820ObserveTree(std::uint32_t, HWND, std::string*, std::size_t*);
bool Sc820ObserveBindings(std::uint32_t, HWND, WindowsControlBindings*);
WindowsUiaRisk Sc820ObserveRisk(std::uint32_t);
bool Sc820ObserveScreen(HWND, RECT*);
std::string Sc820ObserveSignatureProbe(std::optional<std::uint64_t>);
std::string Sc820BindingHealthyProbe(std::optional<std::uint64_t>);
std::string Sc820SemanticStallProbe(const std::string&,std::optional<std::uint64_t>);

struct WindowsValidationWork;
struct WindowsFileIdentity;
struct WindowsV2RejudgeWork;
bool Sc940RejudgeFileIdentity(const WindowsV2RejudgeWork &work, WindowsFileIdentity *identity);
void Sc940RejudgeWorkerStarted();
void Sc940RejudgeCancelAttempt(std::uint64_t job_id, DWORD thread_id);
void Sc940RejudgeRetired(std::uint64_t job_id);
void Sc940RejudgeContextGate(const WindowsV2RejudgeWork &work);
std::string Sc940RejudgeProbe(const std::string &metadata);
bool Sc940ValidationFileIdentity(const WindowsValidationWork &work, WindowsFileIdentity *identity);
void Sc940ValidationWorkerStarted();
void Sc940ValidationCancelAttempt(std::uint64_t job_id, DWORD thread_id);
void Sc940ValidationRetired(std::uint64_t job_id);
std::string Sc940ValidationProbe(const std::string &metadata);
bool Sc940StartOpen(HANDLE process, LockedWindowsExecutable *output);
struct WindowsExistingStartWork;
struct WindowsExistingStartPending;
struct WindowsExistingStartMeasurement;
bool Sc940ResumeSourcePin(const WindowsSession &session, const WindowsExistingStartMeasurement &before);
bool Sc940ResumeOpen(const WindowsExistingStartWork &work, HANDLE process, LockedWindowsExecutable *output);
bool Sc940ResumeFileIdentity(const WindowsExistingStartWork &work, WindowsFileIdentity *identity);
void Sc940ResumeContextGate(const WindowsExistingStartWork &work);
void Sc940ResumeWorkerStarted(const WindowsExistingStartWork &work);
void Sc940ResumeCancelAttempt();
void Sc940ResumeInvalidateTicket(const std::string &session_key);
bool Sc940ResumeResolve(WindowsSession *session, HWND *window, std::string *reason);
bool Sc940ResumeRefocus(const WindowsSession &session, HWND *window, std::string *reason);
void Sc940ResumePrepareFocus(HWND window);
BOOL Sc940ResumeShow(HWND window, int command);
BOOL Sc940ResumeForeground(HWND window);
std::string Sc940ResumeBaseline(const WindowsSession &session, const std::string &metadata);
std::string Sc940ResumeComponent(const WindowsSession &session, const std::string &metadata, const std::string &session_key);
void Sc940StartReadyGate();
void Sc940StartAdoptGate();
void Sc940StartEpilogueGate();
void Sc940StartWorkerAttempt();
BOOL Sc940StartShow(HWND window, int command);
BOOL Sc940StartForeground(HWND window);
void Sc820AutomationCreated();
void Sc820ReadWorkerStarted();
bool Sc820ClassificationContactHeld();
HRESULT Sc820HeldClassificationContact(IUIAutomation*, IUIAutomationElement**);
HRESULT Sc820BindingAutomation(IUIAutomation**);
HRESULT Sc820BindingWalker(IUIAutomation*, IUIAutomationTreeWalker**);
HRESULT Sc820BindingFirst(IUIAutomationTreeWalker*, IUIAutomationElement*, IUIAutomationElement**);
HRESULT Sc820BindingNext(IUIAutomationTreeWalker*, IUIAutomationElement*, IUIAutomationElement**);
HRESULT Sc820BindingAutomationId(IUIAutomationElement*, BSTR*);
HRESULT Sc820BindingName(IUIAutomationElement*, BSTR*);
HRESULT Sc820ReadName(IUIAutomationElement*, BSTR*);
HRESULT Sc820ReadParent(IUIAutomationTreeWalker*, IUIAutomationElement*, IUIAutomationElement**);
ULONG Sc820Release(IUnknown*);
void Sc820FreeBstr(BSTR);
HRESULT Sc820RuntimeId(IUIAutomationElement*, SAFEARRAY**);
std::string Sc820SignatureHash(const std::string&);
HRESULT Sc820UnaccessArray(SAFEARRAY*);
HRESULT Sc820DestroyArray(SAFEARRAY*);
void Sc820ReadCoUninitialize();
std::string Sc820BindingProbe(const std::string &metadata, std::optional<std::uint64_t> stop_serial);
std::string Sc820ClassificationProbe(const std::string &metadata, std::optional<std::uint64_t> stop_serial);
bool Sc820ContactGate(HWND window);
void Sc820ContactResult(bool succeeded, bool nonnull);
void Sc820RootReleased();
std::string Sc820ReadProbe(const std::string &metadata, std::optional<std::uint64_t> stop_serial);
void Sc940MeasureGate(std::uint32_t pid);
void Sc940ContextGate();
void Sc940CompletionGate();
void Sc940AdoptionGate();
void Sc940ConsumerGate(std::uint8_t request);
void Sc940SyncSessionProbe();
BOOL Sc940EnumerateOwnedWindow(WNDENUMPROC callback, LPARAM parameter);
}
#define wmain sc940_original_host_wmain
#include "instrumented-host.cc"
#undef wmain
#include <exception>
#include <stdexcept>

namespace {
HANDLE gate_entered = nullptr;
HANDLE gate_release = nullptr;
HANDLE adoption_entered = nullptr;
HANDLE start_epilogue_entered = nullptr;
HANDLE start_epilogue_release = nullptr;
std::mutex start_epilogue_mutex;
ScopedKernelHandle *start_epilogue_thread_owner = nullptr;
bool start_epilogue_capture_failed = false;
std::array<DWORD, 2> fixture_pids{};
std::array<HWND, 2> fixture_windows{};
unsigned fixture_count = 0;
unsigned enumeration_count = 0;
DWORD held_measure_pid = 0;
enum class HoldPoint { kNone, kMeasure, kContext, kCompletion, kConsumer, kStartOpen, kStartReady, kStartAdopt };
std::atomic<HoldPoint> hold_point{HoldPoint::kNone};
std::atomic<bool> hold_deadline_adoption{false};
std::atomic<bool> gate_timed_out{false};
std::atomic<bool> wrong_measurement{false};
std::atomic<unsigned> measurement_calls{0};
std::atomic<unsigned> context_factory_calls{0};
std::atomic<unsigned> synchronous_session_probes{0};
std::atomic<unsigned> uia_contacts{0};
std::atomic<unsigned> uia_completed_contacts{0};
std::atomic<unsigned> uia_successful_contacts{0};
std::atomic<unsigned> uia_nonnull_roots{0};
std::atomic<unsigned> uia_released_roots{0};
std::atomic<unsigned> uia_hold_contact{0};
std::atomic<ULONGLONG> uia_held_since{0};
std::atomic<unsigned> start_open_calls{0};
std::atomic<unsigned> start_worker_attempts{0};
std::atomic<unsigned> start_open_successes{0};
std::atomic<unsigned> start_focus_calls{0};
std::atomic<bool> hold_start_epilogue{false};
std::atomic<bool> resume_diagnostic_active{false};
std::atomic<unsigned> resume_resolve_attempts{0}, resume_focus_attempts{0};
std::atomic<bool> resume_no_focus{true}, resume_hold_focus_unit{false};
std::atomic<bool> resume_focus_setup_minimized{false}, resume_minimized_client_bounds{false};
std::atomic<bool> resume_hold_before{false}, resume_hold_after{false}, resume_hold_context{false};
std::atomic<bool> resume_fail_after_read{false};
std::atomic<unsigned> resume_before_calls{0}, resume_before_successes{0};
std::atomic<unsigned> resume_after_reads{0}, resume_after_successes{0}, resume_context_calls{0};
std::atomic<unsigned> resume_workers{0}, resume_cancel_attempts{0}, resume_ticket_invalidations{0};
std::atomic<unsigned> resume_before_jobs{0}, resume_after_jobs{0}, resume_before_file_reads{0};
std::atomic<HANDLE> resume_source_process{nullptr}, resume_source_file{INVALID_HANDLE_VALUE};
std::mutex resume_threads_mutex;
std::vector<std::pair<std::shared_ptr<WindowsExistingStartPending>, HANDLE>> resume_threads;
std::shared_ptr<WindowsExistingStartPending> resume_held_pending;
std::atomic<unsigned> resume_pin_checks{0};
HANDLE resume_other_file = INVALID_HANDLE_VALUE;
std::atomic<bool> validation_case_active{false};
std::atomic<unsigned> validation_file_reads{0}, validation_file_successes{0}, validation_workers{0};
std::atomic<unsigned> validation_cancel_attempts{0}, validation_retired_jobs{0};
std::atomic<unsigned> validation_gate_read{0};
std::atomic<DWORD> validation_thread_id{0};
std::atomic<HANDLE> validation_source_process{nullptr}, validation_source_file{INVALID_HANDLE_VALUE};
std::atomic<std::uint64_t> validation_last_cancel_id{0}, validation_last_retired_id{0};
std::mutex validation_pending_mutex;
std::shared_ptr<WindowsValidationPending> validation_first_pending, validation_last_pending;
const WindowsSession *validation_probe_source = nullptr;
std::atomic<const WindowsSession *> rejudge_probe_source{nullptr};
std::atomic<DWORD> rca_consumer_thread_id{0};
std::atomic<unsigned> rejudge_file_reads{0}, rejudge_file_successes{0}, rejudge_hold_call{0};
std::atomic<unsigned> rejudge_workers{0}, rejudge_cancel_attempts{0}, rejudge_retired_jobs{0};
std::atomic<unsigned> rejudge_context_calls{0};
std::atomic<bool> rejudge_hold_context{false};
std::atomic<DWORD> rejudge_thread_id{0};
std::atomic<HANDLE> rejudge_source_file{INVALID_HANDLE_VALUE};
std::atomic<std::uint64_t> rejudge_last_cancel_id{0};
std::mutex rejudge_pending_mutex;
std::shared_ptr<WindowsV2RejudgePending> rejudge_last_pending;
HANDLE rejudge_other_file = INVALID_HANDLE_VALUE;

void Require(bool condition, const char *reason) {
  if (!condition) throw std::runtime_error(reason);
}

void Sc940Gate(HoldPoint point) {
  if (hold_point.load() != point) return;
  SetEvent(gate_entered);
  if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0)
    gate_timed_out.store(true);
}

void Sc940MeasureGate(std::uint32_t pid) {
  if (std::find(fixture_pids.begin(), fixture_pids.begin() + fixture_count, pid) ==
      fixture_pids.begin() + fixture_count) {
    wrong_measurement.store(true);
    throw std::runtime_error("foreign_measurement");
  }
  measurement_calls.fetch_add(1);
  if (pid == held_measure_pid) Sc940Gate(HoldPoint::kMeasure);
}

void Sc940ContextGate() {
  context_factory_calls.fetch_add(1);
  Sc940Gate(HoldPoint::kContext);
}
void Sc940CompletionGate() { Sc940Gate(HoldPoint::kCompletion); }
void Sc940AdoptionGate() {
  if (!hold_deadline_adoption.load()) return;
  SetEvent(adoption_entered);
  if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0)
    gate_timed_out.store(true);
}
void Sc940ConsumerGate(std::uint8_t request) {
  if (request == 2) Sc940Gate(HoldPoint::kConsumer);
}
void Sc940SyncSessionProbe() { synchronous_session_probes.fetch_add(1); }

void Sc940RejudgeWorkerStarted() {
  rejudge_workers.fetch_add(1);
  rejudge_thread_id.store(GetCurrentThreadId());
}
void Sc940RejudgeCancelAttempt(std::uint64_t job_id, DWORD thread_id) {
  if (thread_id == 0 || thread_id != rejudge_thread_id.load()) wrong_measurement.store(true);
  rejudge_last_cancel_id.store(job_id);
  rejudge_cancel_attempts.fetch_add(1);
}
void Sc940RejudgeRetired(std::uint64_t) { rejudge_retired_jobs.fetch_add(1); }
void Sc940RejudgeContextGate(const WindowsV2RejudgeWork &work) {
  {
    std::lock_guard lock(rejudge_pending_mutex);
    rejudge_last_pending = work.pending;
  }
  rejudge_context_calls.fetch_add(1);
  if (!rejudge_hold_context.load()) return;
  SetEvent(gate_entered);
  if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0) gate_timed_out.store(true);
}
bool Sc940RejudgeFileIdentity(const WindowsV2RejudgeWork &work, WindowsFileIdentity *identity) {
  // Work owns the duplicate. Never read or borrow the consumer's Session from this worker hook.
  if (work.executable.value == rejudge_source_file.load() || work.pid != fixture_pids[0] ||
      work.window != fixture_windows[0] || GetCurrentThreadId() != rejudge_thread_id.load()) {
    wrong_measurement.store(true);
    return false;
  }
  {
    std::lock_guard lock(rejudge_pending_mutex);
    rejudge_last_pending = work.pending;
  }
  const unsigned ordinal = rejudge_file_reads.fetch_add(1) + 1;
  if (ordinal == rejudge_hold_call.load()) {
    SetEvent(gate_entered);
    if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0) gate_timed_out.store(true);
  }
  const bool read = ReadWindowsFileIdentity(work.executable.value, identity);
  if (read) rejudge_file_successes.fetch_add(1);
  return read;
}

std::string Sc940RejudgeProbe(const std::string &metadata) {
  const WindowsSession *original = rejudge_probe_source.load(std::memory_order_acquire);
  Require(original != nullptr && GetCurrentThreadId() == rca_consumer_thread_id.load(), "rejudge_component_source");
  WindowsSession source = *original;
  Require(ReadJsonUint64(metadata, "epoch", &source.cancel_epoch), "rejudge_component_epoch");
  std::string mode;
  ReadJsonString(metadata, "mode", &mode);
  if (mode == "mode_mismatch") source.maximum_mode = "full_access_app";
  if (mode == "app_mismatch") source.app_identity = std::string(64, '0');
  if (mode == "start_mismatch") source.process_start += "-different";
  if (mode == "file_mismatch") source.executable_file = rejudge_other_file;
  if (mode == "read_failure") source.executable_file = gate_entered;
  rejudge_source_file.store(source.executable_file);
  const unsigned count = mode == "repeat" ? 3 : 1;
  unsigned successes = 0;
  std::optional<bool> not_web;
  std::string reason;
  bool judged = false;
  for (unsigned index = 0; index < count; ++index) {
    judged = RejudgeWindowsV2Session(source, &not_web, &reason);
    if (!judged) break;
    ++successes;
  }
  // Local component outputs only: no global session, ticket, mode, or input capability is updated.
  return "{\"componentOnly\":true,\"rejudgeOk\":" + std::string(judged ? "true" : "false") +
      ",\"notWeb\":" + (not_web.has_value() ? (*not_web ? "true" : "false") : "null") +
      ",\"successes\":" + std::to_string(successes) + ",\"inputAttemptCount\":" +
      std::to_string(source.input_api_attempts->load()) + "}";
}

void Sc940ValidationWorkerStarted() {
  if (!validation_case_active.load()) return;
  validation_workers.fetch_add(1);
  validation_thread_id.store(GetCurrentThreadId());
}
bool Sc940ValidationFileIdentity(const WindowsValidationWork &work, WindowsFileIdentity *identity) {
  if (!validation_case_active.load()) return ReadWindowsFileIdentity(work.executable.value, identity);
  if (work.pid != fixture_pids[0] || GetProcessId(work.process.value) != fixture_pids[0] ||
      work.process.value == validation_source_process.load() || work.executable.value == validation_source_file.load() ||
      GetCurrentThreadId() != validation_thread_id.load()) {
    wrong_measurement.store(true);
    return false;
  }
  {
    std::lock_guard lock(validation_pending_mutex);
    if (validation_first_pending == nullptr) validation_first_pending = work.pending;
    validation_last_pending = work.pending;
  }
  const unsigned ordinal = validation_file_reads.fetch_add(1) + 1;
  if (ordinal == validation_gate_read.load()) {
    SetEvent(gate_entered);
    if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0) gate_timed_out.store(true);
  }
  const bool read = ReadWindowsFileIdentity(work.executable.value, identity);
  if (read) validation_file_successes.fetch_add(1);
  return read;
}
void Sc940ValidationCancelAttempt(std::uint64_t job_id, DWORD thread_id) {
  if (!validation_case_active.load()) return;
  if (thread_id == 0 || thread_id != validation_thread_id.load()) wrong_measurement.store(true);
  validation_last_cancel_id.store(job_id);
  validation_cancel_attempts.fetch_add(1);
}
void Sc940ValidationRetired(std::uint64_t job_id) {
  if (!validation_case_active.load()) return;
  validation_last_retired_id.store(job_id);
  validation_retired_jobs.fetch_add(1);
}

std::string Sc940ValidationProbe(const std::string &metadata) {
  Require(validation_probe_source != nullptr, "validation_probe_source");
  const WindowsValidationFrameScope frame;
  WindowsSession source = *validation_probe_source;
  source.cancel_epoch = cancellation_epoch.load(std::memory_order_acquire);
  std::string mode;
  ReadJsonString(metadata, "mode", &mode);
  if (mode == "start_mismatch") source.process_start += "-different";
  if (mode == "path_mismatch") source.canonical_path += L".different";
  if (mode == "file_mismatch") source.executable_file_id.Identifier[0] ^= 1;
  // A real owned event can be duplicated, but FileIdInfo on it must fail; no API result is faked.
  if (mode == "read_failure") source.executable_file = gate_entered;
  const unsigned count = mode == "repeat" ? 16 : 1;
  unsigned successes = 0;
  bool available = false, matches = false;
  const auto started = std::chrono::steady_clock::now();
  for (unsigned index = 0; index < count; ++index) {
    validation_source_process.store(source.process_handle);
    validation_source_file.store(source.executable_file);
    WindowsSessionIdentityResult result;
    available = ReadWindowsSessionIdentityOnLane(source, frame.StopSerial(), &result);
    matches = available && result.identity_matches;
    if (matches) ++successes;
    if (!available) break;
  }
  const double elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  return "{\"identityOnly\":true,\"available\":" + std::string(available ? "true" : "false") +
      ",\"matches\":" + (matches ? "true" : "false") + ",\"calls\":" + std::to_string(count) +
      ",\"successes\":" + std::to_string(successes) + ",\"elapsedMs\":" + std::to_string(elapsed) + "}";
}

bool Sc940StartOpen(HANDLE process, LockedWindowsExecutable *output) {
  if (fixture_count != 1 || GetProcessId(process) != fixture_pids[0]) {
    wrong_measurement.store(true);
    return false;
  }
  start_open_calls.fetch_add(1);
  Sc940Gate(HoldPoint::kStartOpen);
  const bool opened = OpenLockedProcessExecutable(process, output);
  if (opened) start_open_successes.fetch_add(1);
  return opened;
}
void Sc940ResumeWorkerStarted(const WindowsExistingStartWork &work) {
  if (!resume_diagnostic_active.load()) return;
  resume_workers.fetch_add(1);
  if (work.phase == WindowsExistingStartPhase::BeforeFocus) resume_before_jobs.fetch_add(1);
  else resume_after_jobs.fetch_add(1);
  HANDLE thread = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &thread,
                       SYNCHRONIZE | THREAD_QUERY_LIMITED_INFORMATION, FALSE, 0)) {
    wrong_measurement.store(true);
    return;
  }
  try {
    std::lock_guard lock(resume_threads_mutex);
    resume_threads.emplace_back(work.pending, thread);
  } catch (...) {
    CloseHandle(thread);
    wrong_measurement.store(true);
  }
}
void Sc940ResumeInvalidateTicket(const std::string &session_key) {
  if (resume_diagnostic_active.load()) resume_ticket_invalidations.fetch_add(1);
  InvalidateWindowsTicket(session_key);
}
void Sc940ResumeCancelAttempt() {
  if (resume_diagnostic_active.load()) resume_cancel_attempts.fetch_add(1);
}
void Sc940ResumeHold(const WindowsExistingStartWork &work) {
  {
    std::lock_guard lock(resume_threads_mutex);
    resume_held_pending = work.pending;
  }
  SetEvent(gate_entered);
  if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0) gate_timed_out.store(true);
}
bool Sc940ResumeOpen(const WindowsExistingStartWork &work, HANDLE process, LockedWindowsExecutable *output) {
  if (!resume_diagnostic_active.load()) return OpenLockedProcessExecutable(process, output);
  if (GetProcessId(process) != fixture_pids[0] || work.process.value == resume_source_process.load() ||
      work.executable.value == resume_source_file.load()) {
    wrong_measurement.store(true);
    return false;
  }
  resume_before_calls.fetch_add(1);
  if (resume_hold_before.load()) Sc940ResumeHold(work);
  const bool opened = OpenLockedProcessExecutable(process, output);
  if (opened) resume_before_successes.fetch_add(1);
  return opened;
}
bool Sc940ResumeFileIdentity(const WindowsExistingStartWork &work, WindowsFileIdentity *identity) {
  if (!resume_diagnostic_active.load()) return ReadWindowsFileIdentity(work.executable.value, identity);
  const bool after = work.phase == WindowsExistingStartPhase::AfterFocus;
  if (after) resume_after_reads.fetch_add(1);
  else resume_before_file_reads.fetch_add(1);
  if (work.executable.value == resume_source_file.load()) wrong_measurement.store(true);
  if (after && resume_hold_after.load()) Sc940ResumeHold(work);
  const bool read = ReadWindowsFileIdentity(after && resume_fail_after_read.load() ? gate_entered : work.executable.value, identity);
  if (after && read) resume_after_successes.fetch_add(1);
  return read;
}
void Sc940ResumeContextGate(const WindowsExistingStartWork &work) {
  if (!resume_diagnostic_active.load()) return;
  resume_context_calls.fetch_add(1);
  if (resume_hold_context.load()) Sc940ResumeHold(work);
}
std::shared_ptr<WindowsExistingStartPending> ResumeHeldPending() {
  std::lock_guard lock(resume_threads_mutex);
  return resume_held_pending;
}
bool WaitResumeThread(const std::shared_ptr<WindowsExistingStartPending> &pending, DWORD budget = 5000) {
  HANDLE thread = nullptr;
  {
    std::lock_guard lock(resume_threads_mutex);
    for (const auto &entry : resume_threads) if (entry.first == pending) thread = entry.second;
  }
  return thread != nullptr && WaitForSingleObject(thread, budget) == WAIT_OBJECT_0;
}
bool WaitAllResumeThreads() {
  std::vector<HANDLE> threads;
  {
    std::lock_guard lock(resume_threads_mutex);
    for (const auto &entry : resume_threads) threads.push_back(entry.second);
  }
  const ULONGLONG deadline = GetTickCount64() + 5000;
  for (HANDLE thread : threads) {
    const ULONGLONG now = GetTickCount64();
    if (WaitForSingleObject(thread, now >= deadline ? 0 : static_cast<DWORD>(deadline - now)) != WAIT_OBJECT_0)
      return false;
  }
  return threads.size() == resume_workers.load();
}
bool CloseResumeThreadEvidence() {
  std::lock_guard lock(resume_threads_mutex);
  bool closed = true;
  for (const auto &entry : resume_threads) closed = CloseHandle(entry.second) != FALSE && closed;
  resume_threads.clear();
  resume_held_pending.reset();
  return closed;
}
bool Sc940ResumeResolve(WindowsSession *session, HWND *window, std::string *reason) {
  if (!resume_diagnostic_active.load()) return ResolveWindowsExplicitResumeTarget(session, window, reason);
  resume_resolve_attempts.fetch_add(1);
  if (!resume_no_focus.load()) return ResolveWindowsExplicitResumeTarget(session, window, reason);
  *reason = "diagnostic_resume_resolve_forbidden";
  return false;
}
bool Sc940ResumeRefocus(const WindowsSession &session, HWND *window, std::string *reason) {
  if (!resume_diagnostic_active.load()) return ResolveWindowsSessionRefocusTarget(session, window, reason);
  resume_resolve_attempts.fetch_add(1);
  if (!resume_no_focus.load()) return ResolveWindowsSessionRefocusTarget(session, window, reason);
  *reason = "diagnostic_resume_resolve_forbidden";
  return false;
}
void Sc940ResumePrepareFocus(HWND window) {
  if (!resume_diagnostic_active.load() || !resume_hold_focus_unit.load()) return;
  RECT before{};
  Require(!resume_no_focus.load() && window == fixture_windows[0] && !IsIconic(window) &&
              GetForegroundWindow() != window && ClientBoundsPhysical(window, &before),
          "resume_owned_focus_setup_after_validation");
  // List and the real pre-focus geometry/resolver checks need normal client bounds. Model an
  // owned target minimizing after those checks, so the real restore and foreground units both apply.
  ShowWindow(window, SW_MINIMIZE);
  Require(IsIconic(window) && GetForegroundWindow() != window, "resume_owned_target_minimized");
  RECT minimized{};
  resume_minimized_client_bounds.store(ClientBoundsPhysical(window, &minimized));
  resume_focus_setup_minimized.store(true);
}
BOOL Sc940ResumeShow(HWND window, int command) {
  if (!resume_diagnostic_active.load()) return ShowWindow(window, command);
  resume_focus_attempts.fetch_add(1);
  if (resume_no_focus.load()) return FALSE;
  const BOOL result = ShowWindow(window, command);
  if (resume_hold_focus_unit.load()) {
    SetEvent(gate_entered);
    if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0) gate_timed_out.store(true);
  }
  return result;
}
BOOL Sc940ResumeForeground(HWND window) {
  if (!resume_diagnostic_active.load()) return SetForegroundWindow(window);
  resume_focus_attempts.fetch_add(1);
  return resume_no_focus.load() ? FALSE : SetForegroundWindow(window);
}
std::string Sc940ResumeBaseline(const WindowsSession &session, const std::string &metadata) {
  Require(resume_diagnostic_active.load() && session.pid == fixture_pids[0] &&
              GetCurrentThreadId() == rca_consumer_thread_id.load(), "resume_baseline_owned_consumer");
  LockedWindowsExecutable current;
  std::string mode;
  std::optional<sprint_coder::computer_use::WindowsFileKey> not_web;
  const bool identity = OpenLockedProcessExecutable(session.process_handle, &current) &&
      SameWindowsPath(current.identity.path, session.canonical_path) &&
      WindowsSessionProcessMatches(session) && WindowsSessionExecutableMatches(session, current);
  const bool admitted = identity && AdmitWindowsV2Start(session.pid, session.window, current, metadata,
      /*new_session=*/false, session.app_identity, session.executable_digest, session.signer_digest, &mode, &not_web) &&
      mode == session.maximum_mode && not_web == session.not_web_file;
  return "{\"componentOnly\":true,\"identityMatches\":" + std::string(identity ? "true" : "false") +
      ",\"admissionMatches\":" + (admitted ? "true" : "false") + ",\"inputAttemptCount\":" +
      std::to_string(session.input_api_attempts->load()) + "}";
}
bool Sc940ResumeSourcePin(const WindowsSession &session, const WindowsExistingStartMeasurement &before) {
  if (!resume_diagnostic_active.load()) return true;
  WindowsFileIdentity original;
  const bool matched = GetCurrentThreadId() == rca_consumer_thread_id.load() &&
              session.executable_file == resume_source_file.load() && session.process_handle == resume_source_process.load() &&
              ReadWindowsFileIdentity(session.executable_file, &original) &&
              SameWindowsFileIdentity(original, before.executable.file_identity) &&
              GetProcessId(session.process_handle) == session.pid &&
              WaitForSingleObject(session.process_handle, 0) == WAIT_TIMEOUT;
  if (!matched) { wrong_measurement.store(true); return false; }
  resume_pin_checks.fetch_add(1);
  return true;
}
std::string Sc940ResumeComponent(const WindowsSession &session, const std::string &metadata,
                                 const std::string &session_key) {
  Require(resume_diagnostic_active.load() && GetCurrentThreadId() == rca_consumer_thread_id.load(),
          "resume_component_consumer");
  const WindowsSession &source = session;
  resume_fail_after_read.store(false);
  WindowsStartInput input;
  input.pid = source.pid;
  input.window = source.window;
  input.window_value = reinterpret_cast<UINT_PTR>(source.window);
  input.session_key = session_key;
  input.session_id = source.session_id;
  input.app_identity = source.app_identity;
  input.expected_window_identity = source.window_identity;
  input.canonical_path = source.canonical_path;
  input.executable_digest = source.executable_digest;
  input.signer_digest = source.signer_digest;
  input.cancel_epoch = source.cancel_epoch;
  input.stop_serial = WindowsValidationFrameStopSerial();
  input.main_pid = windows_v2_main_pid;
  Require(ReadJsonUint64(metadata, "denyRulesetVersion", &input.ruleset_version), "resume_component_ruleset");
  std::string mode;
  ReadJsonString(metadata, "mode", &mode);
  if (mode == "before_app") input.app_identity = std::string(64, '0');
  if (mode == "before_window") input.expected_window_identity = std::string(64, '0');
  if (mode == "before_ruleset") input.ruleset_version = 0;
  const unsigned count = mode == "repeat" ? 3 : 1;
  unsigned completed = 0;
  bool before_ok = false, after_ok = false;
  for (unsigned index = 0; index < count; ++index) {
    WindowsExistingStartMeasurement before, after;
    std::string reason;
    before_ok = RunWindowsExistingStartMeasurement(input, source, WindowsExistingStartPhase::BeforeFocus,
                                                     nullptr, &before, &reason);
    if (!before_ok) break;
    // Before's temporary handles have been closed. The original Session still pins the same file
    // across the consumer/focus interval; this diagnostic does not perform that focus interval.
    Require(Sc940ResumeSourcePin(source, before), "resume_source_pin_survives_before");
    if (mode == "after_digest") before.executable.executable_digest = std::string(64, '0');
    if (mode == "after_signer") before.executable.signer_digest = std::string(64, '0');
    if (mode == "after_language") before.executable.policy_language = "different";
    if (mode == "after_file") {
      WindowsFileIdentity other;
      Require(ReadWindowsFileIdentity(resume_other_file, &other), "resume_real_other_file");
      before.executable.file_identity = other;
    }
    resume_fail_after_read.store(mode == "after_read_failure");
    after_ok = RunWindowsExistingStartMeasurement(input, source, WindowsExistingStartPhase::AfterFocus,
                                                    &before, &after, &reason);
    resume_fail_after_read.store(false);
    if (!after_ok) break;
    ++completed;
  }
  return "{\"componentOnly\":true,\"beforeOk\":" + std::string(before_ok ? "true" : "false") +
      ",\"afterOk\":" + (after_ok ? "true" : "false") + ",\"completed\":" + std::to_string(completed) + "}";
}
void Sc940StartReadyGate() { Sc940Gate(HoldPoint::kStartReady); }
void Sc940StartWorkerAttempt() { start_worker_attempts.fetch_add(1); }
void Sc940StartAdoptGate() { Sc940Gate(HoldPoint::kStartAdopt); }
void Sc940StartEpilogueGate() {
  HANDLE release = nullptr;
  {
    // Publication and disarming share this lock, so cleanup either owns this real thread handle
    // or prevents the hook from borrowing its events. The worker never closes the published handle.
    std::lock_guard lock(start_epilogue_mutex);
    if (!hold_start_epilogue.load() || start_epilogue_thread_owner == nullptr) return;
    ScopedKernelHandle thread;
    if (start_epilogue_thread_owner->value != nullptr ||
        !DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &thread.value,
                         SYNCHRONIZE, FALSE, 0)) {
      start_epilogue_capture_failed = true;
      SetEvent(start_epilogue_entered);
      return;
    }
    start_epilogue_thread_owner->value = thread.release();
    release = start_epilogue_release;
    SetEvent(start_epilogue_entered);
  }
  if (WaitForSingleObject(release, 20'000) != WAIT_OBJECT_0) gate_timed_out.store(true);
}
BOOL Sc940StartShow(HWND window, int command) {
  start_focus_calls.fetch_add(1);
  return ShowWindow(window, command);
}
BOOL Sc940StartForeground(HWND window) {
  start_focus_calls.fetch_add(1);
  return SetForegroundWindow(window);
}

// A deterministic foreign-call stall, not a measurement of Windows UIA timing.
// It returns a timeout without querying any desktop element after release.
std::atomic<bool> classification_contact_held{false};
std::atomic<unsigned> classification_contacts{0}, classification_returns{0}, uia_read_worker_starts{0};
std::atomic<ULONGLONG> classification_contact_started{0};
std::atomic<unsigned> uia_factory_calls{0};
void Sc820AutomationCreated(){uia_factory_calls.fetch_add(1);}
void Sc820ReadWorkerStarted(){uia_read_worker_starts.fetch_add(1);}
bool Sc820ClassificationContactHeld() { return classification_contact_held.load(); }
std::string classification_detail;
std::atomic<unsigned> binding_acquired_refs{0};
bool Sc820BindingTracking(){return classification_detail.starts_with("binding-")&&windows_uia_read_progress!=nullptr;}

std::atomic<unsigned> classification_gate_calls{0}, classification_release_calls{0}, classification_release_returns{0};
std::atomic<unsigned> classification_bstr_allocs{0}, classification_bstr_frees{0};
std::atomic<unsigned> classification_array_allocs{0}, classification_array_unlocks{0}, classification_array_frees{0};
std::atomic<unsigned> classification_apartments{0}, classification_hash_faults{0};
std::atomic<bool> classification_bad_cleanup{false};
std::mutex classification_resource_mutex;
std::set<BSTR> classification_bstrs;
std::set<SAFEARRAY*> classification_arrays;
void Sc820DetailGate() {
  if(classification_detail.starts_with("success-"))Require(windows_v1_uia_lane!=nullptr&&windows_v1_uia_lane->stop==WindowsV1UiaStop::kNone,"successful_cleanup_has_no_prior_stop");
  classification_gate_calls.fetch_add(1);SetEvent(gate_entered);
  if(WaitForSingleObject(gate_release,20'000)!=WAIT_OBJECT_0)gate_timed_out.store(true);
}
HRESULT Sc820HeldClassificationContact(IUIAutomation* automation, IUIAutomationElement** output) {
  classification_contacts.fetch_add(1);
  classification_contact_started.store(GetTickCount64());
  if(!classification_detail.empty()) {
    DWORD owner=0;
    Require(fixture_count==1&&GetWindowThreadProcessId(fixture_windows[0],&owner)!=0&&owner==fixture_pids[0],"classification_contact_owned_window");
    const auto result=automation->ElementFromHandle(fixture_windows[0],output);
    if(Sc820BindingTracking()&&*output!=nullptr)binding_acquired_refs.fetch_add(1);
    classification_returns.fetch_add(1);return result;
  }
  SetEvent(gate_entered);
  if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0) gate_timed_out.store(true);
  classification_returns.fetch_add(1);
  return kWindowsV1UiaTimeoutResult;
}
HRESULT Sc820BindingAutomation(IUIAutomation** output){
  const auto result=CreateWindowsV1Automation(output);if(Sc820BindingTracking()&&*output)binding_acquired_refs.fetch_add(1);return result;
}
HRESULT Sc820BindingWalker(IUIAutomation* automation,IUIAutomationTreeWalker** output){
  const auto result=automation->get_RawViewWalker(output);if(Sc820BindingTracking()&&*output)binding_acquired_refs.fetch_add(1);return result;
}
HRESULT Sc820BindingFirst(IUIAutomationTreeWalker* walker,IUIAutomationElement* element,IUIAutomationElement** output){
  const auto result=walker->GetFirstChildElement(element,output);
  if(Sc820BindingTracking()){
    if(*output)binding_acquired_refs.fetch_add(1);
    if(classification_detail=="binding-first-child-close"&&classification_gate_calls==0)Sc820DetailGate();
  }return result;
}
HRESULT Sc820BindingNext(IUIAutomationTreeWalker* walker,IUIAutomationElement* element,IUIAutomationElement** output){
  const auto result=walker->GetNextSiblingElement(element,output);
  if(Sc820BindingTracking()){
    if(*output)binding_acquired_refs.fetch_add(1);
    if(classification_detail=="binding-sibling-cancel"&&classification_gate_calls==0)Sc820DetailGate();
  }return result;
}
void Sc820BindingTrackBstr(BSTR value){
  if(Sc820BindingTracking()&&value){std::lock_guard lock(classification_resource_mutex);Require(classification_bstrs.insert(value).second,"binding_bstr_unique_allocation");classification_bstr_allocs.fetch_add(1);}
}
HRESULT Sc820BindingAutomationId(IUIAutomationElement* element,BSTR* output){
  const auto result=element->get_CurrentAutomationId(output);Sc820BindingTrackBstr(*output);return result;
}
HRESULT Sc820BindingName(IUIAutomationElement* element,BSTR* output){
  const auto result=element->get_CurrentName(output);Sc820BindingTrackBstr(*output);
  if(Sc820BindingTracking()){
    if(classification_detail=="binding-name-cancel"&&classification_gate_calls==0)Sc820DetailGate();
    if(classification_detail=="binding-name-exception")throw std::runtime_error("binding_name_fault");
  }return result;
}
HRESULT Sc820ReadName(IUIAutomationElement* element,BSTR* output) {
  if(classification_contact_held.load()&&classification_detail.starts_with("name-")) {
    if(classification_detail!="name-exception")Sc820DetailGate();
  }
  const auto result=element->get_CurrentName(output);
  if(classification_contact_held.load()&&!classification_detail.empty()&&SUCCEEDED(result)&&*output!=nullptr){
    std::lock_guard lock(classification_resource_mutex);classification_bstrs.insert(*output);classification_bstr_allocs.fetch_add(1);
  }
  if(classification_contact_held.load()&&classification_detail=="name-exception")throw std::runtime_error("classification_name_fault");
  return result;
}
void Sc820FreeBstr(BSTR value){
  {std::lock_guard lock(classification_resource_mutex);if(classification_bstrs.erase(value)!=0)classification_bstr_frees.fetch_add(1);}
  SysFreeString(value);
}
HRESULT Sc820ReadParent(IUIAutomationTreeWalker* walker,IUIAutomationElement* element,IUIAutomationElement** output){
  if(!classification_contact_held.load()||classification_detail.empty())return walker->GetParentElement(element,output);
  *output=nullptr;
  if(classification_detail.starts_with("parent-"))Sc820DetailGate();
  if(classification_detail=="partial-result"||classification_detail=="release-cancel"||
     classification_detail=="apartment-close"||classification_detail.starts_with("parent-"))return kWindowsV1UiaTimeoutResult;
  // End the component's controlled chain at its own window; no desktop ancestors are read.
  return S_OK;
}
ULONG Sc820Release(IUnknown* value){
  const bool tracked=classification_contact_held.load()&&windows_uia_read_progress!=nullptr;
  if(tracked){const auto call=classification_release_calls.fetch_add(1);if(call==0&&(classification_detail=="release-cancel"||classification_detail=="success-release-cancel"||classification_detail=="binding-release-cancel"))Sc820DetailGate();}
  const auto result=value->Release();if(tracked)classification_release_returns.fetch_add(1);return result;
}
HRESULT Sc820RuntimeId(IUIAutomationElement* element,SAFEARRAY** output){
  if(classification_contact_held.load()&&(classification_detail=="signature-result"||classification_detail=="signature-cancel"||classification_detail=="signature-close")){
    if(classification_detail!="signature-result")Sc820DetailGate();*output=nullptr;return kWindowsV1UiaTimeoutResult;
  }
  const auto result=element->GetRuntimeId(output);
  if(classification_contact_held.load()&&!classification_detail.empty()&&SUCCEEDED(result)&&*output!=nullptr){
    std::lock_guard lock(classification_resource_mutex);classification_arrays.insert(*output);classification_array_allocs.fetch_add(1);
  }
  if(Sc820BindingTracking()&&classification_detail=="binding-runtime-close"&&classification_gate_calls==0)Sc820DetailGate();
  return result;
}
std::string Sc820SignatureHash(const std::string& value){
  if(classification_contact_held.load()&&(classification_detail=="signature-exception"||classification_detail=="binding-hash-exception")){
    classification_hash_faults.fetch_add(1);throw std::runtime_error("classification_hash_fault");
  }
  return Sha256String(value);
}
HRESULT Sc820UnaccessArray(SAFEARRAY* value){
  const auto result=SafeArrayUnaccessData(value);
  std::lock_guard lock(classification_resource_mutex);
  if(classification_arrays.contains(value)){if(SUCCEEDED(result))classification_array_unlocks.fetch_add(1);else classification_bad_cleanup=true;}
  return result;
}
HRESULT Sc820DestroyArray(SAFEARRAY* value){
  bool tracked=false;{std::lock_guard lock(classification_resource_mutex);tracked=classification_arrays.erase(value)!=0;}
  if(tracked&&value->cLocks!=0)classification_bad_cleanup=true;
  const auto result=SafeArrayDestroy(value);
  if(tracked){if(SUCCEEDED(result))classification_array_frees.fetch_add(1);else classification_bad_cleanup=true;}return result;
}
void Sc820ReadCoUninitialize(){
  const bool tracked=classification_contact_held.load()&&windows_uia_read_progress!=nullptr;
  if(tracked&&Sc820BindingTracking()){
    if(classification_release_returns!=binding_acquired_refs)classification_bad_cleanup=true;
    std::lock_guard lock(classification_resource_mutex);
    if(!classification_bstrs.empty()||!classification_arrays.empty())classification_bad_cleanup=true;
  }
  if(tracked&&(classification_detail=="apartment-close"||classification_detail=="success-apartment-close"||classification_detail=="binding-apartment-close"))Sc820DetailGate();
  if(tracked&&classification_detail=="healthy-consecutive")Sleep(30);
  CoUninitialize();if(tracked)classification_apartments.fetch_add(1);
}

// Only the Observe prerequisite reads are controlled here. The production Observe flow and
// focused-signature worker execute normally; any downstream capture attempt is a test failure.
bool observe_signature_mode=false;
std::atomic<unsigned> observe_after_signature_calls{0};
bool Sc820ObserveValidate(const WindowsSession& session,RECT* bounds,std::string* reason,WindowsDialogSetSnapshot* dialogs){
  if(!observe_signature_mode)return ValidateWindowsSession(session,bounds,reason,dialogs);
  *bounds=RECT{0,0,100,100};dialogs->active_window=fixture_windows[0];return true;
}
bool Sc820ObserveTree(std::uint32_t pid,HWND window,std::string* tree,std::size_t* nodes){
  if(!observe_signature_mode)return ReadUiaObservation(pid,window,tree,nodes);
  *tree="controlled-observe-prerequisite";*nodes=1;return true;
}
bool Sc820ObserveBindings(std::uint32_t pid,HWND window,WindowsControlBindings* bindings){
  if(!observe_signature_mode)return CaptureWindowsControlBindings(pid,window,bindings);
  return true;
}
WindowsUiaRisk Sc820ObserveRisk(std::uint32_t pid){
  if(!observe_signature_mode)return ClassifyWindowsFocusedElement(pid);
  return WindowsUiaRisk{true,false,false,true};
}
bool Sc820ObserveScreen(HWND window,RECT* bounds){
  if(!observe_signature_mode)return ScreenBoundsPhysicalForWindow(window,bounds);
  observe_after_signature_calls.fetch_add(1);return false;
}
std::string Sc820ObserveSignatureProbe(std::optional<std::uint64_t> stop_serial){
  WindowsSession session;session.pid=fixture_pids[0];session.active_window=fixture_windows[0];session.cancel_epoch=1;
  std::string response,reason;std::vector<std::uint8_t> binary;
  observe_signature_mode=true;
  const bool ok=ObserveWindowsWindow(session,&response,&binary,&reason,stop_serial);
  observe_signature_mode=false;
  return std::string("{\"ok\":")+(ok?"true":"false")+",\"reason\":\""+JsonEscape(reason)+"\",\"empty\":"+(response.empty()&&binary.empty()?"true":"false")+"}";
}

std::string Sc820SemanticStallProbe(const std::string& metadata,std::optional<std::uint64_t> stop_serial){
  const WindowsV1UiaPath path(std::chrono::milliseconds::zero(),1,stop_serial);
  std::string kind;Require(ReadJsonString(metadata,"kind",&kind)&&(kind=="search"||kind=="dispatch"),"semantic_stall_kind");
  WindowsSession session;session.session_id="sc940-control";session.pid=fixture_pids[0];session.active_window=fixture_windows[0];session.cancel_epoch=1;
  // No observed target signature is present: even an unexpected match cannot reach an input API.
  bool ok=false,accepted=false;std::string reason;IUIAutomationElement* target=nullptr;
  if(kind=="search")ok=FindWindowsSemanticTarget(session.active_window,"sc820-absent-control",&target,&reason);
  else ok=DispatchWindowsSemanticAction(session,RECT{0,0,100,100},1,"invoke","{\"targetId\":\"sc820-absent-control\"}",&accepted,&reason);
  if(target!=nullptr)target->Release();
  return std::string("{\"ok\":")+(ok?"true":"false")+",\"accepted\":"+(accepted?"true":"false")+
      ",\"inputAttempts\":"+std::to_string(session.input_api_attempts->load())+",\"reason\":\""+JsonEscape(reason)+"\"}";
}

std::string Sc820BindingHealthyProbe(std::optional<std::uint64_t> stop_serial){
  const WindowsV1UiaPath path(kWindowsV1UiaObserveBudget,1,stop_serial);
  struct Objects {IUIAutomation* automation=nullptr;IUIAutomationElement* element=nullptr;
    ~Objects(){if(element)element->Release();if(automation)automation->Release();}} objects;
  Require(SUCCEEDED(CreateWindowsV1Automation(&objects.automation))&&objects.automation,"binding_healthy_automation");
  Require(SUCCEEDED(objects.automation->ElementFromHandle(fixture_windows[0],&objects.element))&&objects.element,"binding_healthy_root");
  RECT bounds{};Require(SUCCEEDED(objects.element->get_CurrentBoundingRectangle(&bounds)),"binding_healthy_bounds");
  std::string duplicate_id,unique_id;unsigned duplicate_controls=0,unique_controls=0;
  for(HWND child=GetWindow(fixture_windows[0],GW_CHILD);child!=nullptr;child=GetWindow(child,GW_HWNDNEXT)){
    if(GetDlgCtrlID(child)!=901&&GetDlgCtrlID(child)!=902)continue;
    DWORD owner=0;Require(GetWindowThreadProcessId(child,&owner)!=0&&owner==fixture_pids[0],"binding_healthy_child_owner");
    struct Element {IUIAutomationElement* value=nullptr;~Element(){if(value)value->Release();}} element;
    Require(SUCCEEDED(objects.automation->ElementFromHandle(child,&element.value))&&element.value,"binding_healthy_child");
    std::string id;Require(ReadWindowsElementTargetId(element.value,&id)&&!id.empty(),"binding_healthy_child_id");
    if(GetDlgCtrlID(child)==902){unique_id=id;++unique_controls;}
    else {if(duplicate_controls==0)duplicate_id=id;else Require(id==duplicate_id,"binding_healthy_duplicate_id");++duplicate_controls;}
  }
  Require(duplicate_controls==2&&unique_controls==1&&!unique_id.empty()&&unique_id!=duplicate_id,"binding_healthy_duplicate_and_unique_controls");
  WindowsControlBindings baseline,first,second;
  first.semantic.emplace("old-id","old-signature");first.visual.insert("old-visual");second=first;
  Require(CaptureWindowsControlBindingsOnWorker(fixture_pids[0],fixture_windows[0],&baseline),"binding_healthy_direct_capture");
  const auto nodes=path.Nodes();Require(nodes>=3&&baseline.visual.size()>=3&&!baseline.semantic.contains(duplicate_id)&&baseline.semantic.contains(unique_id),"binding_healthy_duplicate_omitted_unique_preserved");
  Require(CaptureWindowsControlBindings(fixture_pids[0],fixture_windows[0],&first)&&
          CaptureWindowsControlBindings(fixture_pids[0],fixture_windows[0],&second),"binding_healthy_worker_capture");
  Require(first.semantic==baseline.semantic&&second.semantic==baseline.semantic&&first.visual==baseline.visual&&second.visual==baseline.visual&&path.Nodes()==3*nodes,"binding_healthy_values_and_cumulative_nodes");
  std::string direct_signature,first_signature="old-signature",second_signature="old-signature";
  Require(WindowsFocusedElementSignatureOnWorker(fixture_pids[0],bounds,&direct_signature)&&
          WindowsFocusedElementSignature(fixture_pids[0],bounds,&first_signature)&&
          WindowsFocusedElementSignature(fixture_pids[0],bounds,&second_signature)&&direct_signature.size()==64&&
          direct_signature==first_signature&&direct_signature==second_signature,"binding_healthy_signature_equivalence");
  Require(path.Stop()==WindowsV1UiaStop::kNone&&!WindowsUiaReadWorkerRunning().load(),"binding_healthy_worker_retired");
  return "{\"equivalent\":true,\"duplicateOmitted\":true,\"nodes\":"+std::to_string(nodes)+"}";
}

std::string Sc820BindingProbe(const std::string &metadata, std::optional<std::uint64_t> stop_serial) {
  Require(fixture_count==1,"binding_owned_fixture");
  std::string kind;Require(ReadJsonString(metadata,"kind",&kind)&&(kind=="bindings"||kind=="signature"||kind=="recovery"),"binding_probe_kind");
  bool fresh=false;ReadOptionalJsonBoolean(metadata,"fresh",&fresh);
  const WindowsV1UiaPath path(kWindowsV1UiaObserveBudget,fresh?cancellation_epoch.load():1,stop_serial);
  if(kind=="recovery") {
    bool recovered=false;RunWindowsUiaRead<bool>(false, []() -> std::optional<bool> {return true;},[&](bool value){recovered=value;});
    return std::string("{\"recovered\":")+(recovered?"true":"false")+"}";
  }
  WindowsControlBindings bindings;std::string signature;
  bool sentinel=false;ReadOptionalJsonBoolean(metadata,"sentinel",&sentinel);
  if(sentinel){bindings.semantic.emplace("sentinel-id","sentinel-signature");bindings.visual.insert("sentinel-visual");signature="sentinel-signature";}
  // Controlled owned-window contact tests isolate lifetime from focus/coordinate acceptance.
  const RECT signature_bounds=classification_detail.starts_with("binding-")?RECT{-1000000,-1000000,1000000,1000000}:RECT{0,0,100,100};
  const bool ok=kind=="bindings" ? CaptureWindowsControlBindings(fixture_pids[0],fixture_windows[0],&bindings)
      : WindowsFocusedElementSignature(fixture_pids[0],signature_bounds,&signature);
  const bool output_unchanged=sentinel&&bindings.semantic==std::unordered_map<std::string,std::string>{{"sentinel-id","sentinel-signature"}}&&
      bindings.visual==std::set<std::string>{"sentinel-visual"}&&signature=="sentinel-signature";
  return std::string("{\"ok\":")+(ok?"true":"false")+",\"outputUnchanged\":"+(output_unchanged?"true":"false")+",\"empty\":"+
      (bindings.semantic.empty()&&bindings.visual.empty()&&signature.empty()?"true":"false")+
      ",\"canceled\":"+(path.Stop()==WindowsV1UiaStop::kCanceled?"true":"false")+
      ",\"timedOut\":"+(path.Stop()==WindowsV1UiaStop::kTimeout?"true":"false")+"}";
}

std::string Sc820ClassificationProbe(const std::string &metadata, std::optional<std::uint64_t> stop_serial) {
  Require(fixture_count == 1, "classification_owned_fixture");
  std::string kind;
  Require(ReadJsonString(metadata, "kind", &kind) && (kind == "point" || kind == "focused" || kind == "recovery"),
          "classification_probe_kind");
  bool fresh=false,frame_fallback=false;ReadOptionalJsonBoolean(metadata,"fresh",&fresh);ReadOptionalJsonBoolean(metadata,"frameFallback",&frame_fallback);
  const WindowsV1UiaPath path(kWindowsV1UiaObserveBudget, fresh ? cancellation_epoch.load() : 1, frame_fallback?std::nullopt:stop_serial);
  if(kind=="recovery") {
    bool recovered=false;
    RunWindowsUiaRead<bool>(true, []() -> std::optional<bool> { return true; },
                           [&recovered](bool value){recovered=value;});
    return std::string("{\"recovered\":")+(recovered?"true":"false")+"}";
  }
  std::string signature;
  const WindowsUiaRisk risk = kind == "point"
      ? ClassifyWindowsPoint(POINT{}, fixture_pids[0], &signature)
      : ClassifyWindowsFocusedElement(fixture_pids[0]);
  if(path.Stop()!=WindowsV1UiaStop::kNone) {
    const auto factories=uia_factory_calls.load();std::string discarded_signature;
    Require(!WindowsFocusedElementSignature(fixture_pids[0],RECT{0,0,100,100},&discarded_signature) &&
                uia_factory_calls.load()==factories,"stopped_classification_prevents_following_signature_uia");
  }
  return "{\"incomplete\":" + std::string(!risk.metadata_complete ? "true" : "false") +
      ",\"signatureEmpty\":" + (signature.empty() ? "true" : "false") +
      ",\"secure\":" + (risk.secure?"true":"false") +
      ",\"classified\":" + (risk.classified?"true":"false") +
      ",\"rejected\":" + ([&]{std::string reason;return RejectWindowsRisk(risk,&reason)?std::string("true"):std::string("false");})() +
      ",\"canceled\":" + (path.Stop()==WindowsV1UiaStop::kCanceled?"true":"false") +
      ",\"timedOut\":" + (path.Stop()==WindowsV1UiaStop::kTimeout?"true":"false") + "}";
}

bool Sc820ContactGate(HWND window) {
  if (fixture_count != 1 || window != fixture_windows[0] || windows_uia_read_progress == nullptr) {
    wrong_measurement.store(true);
    return false;
  }
  {
    std::lock_guard lock(windows_uia_read_progress->mutex);
    if (!windows_uia_read_progress->contact_active) {
      wrong_measurement.store(true);
      return false;
    }
  }
  const unsigned index = uia_contacts.fetch_add(1) + 1;
  if (index != uia_hold_contact.load()) return true;
  uia_held_since.store(GetTickCount64());
  SetEvent(gate_entered);
  if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0)
    gate_timed_out.store(true);
  return true;
}
void Sc820ContactResult(bool succeeded, bool nonnull) {
  uia_completed_contacts.fetch_add(1);
  if (succeeded) uia_successful_contacts.fetch_add(1);
  if (nonnull) uia_nonnull_roots.fetch_add(1);
}
void Sc820RootReleased() { uia_released_roots.fetch_add(1); }

const char *Sc820StopName(WindowsV1UiaStop stop) {
  switch (stop) {
  case WindowsV1UiaStop::kNone: return "none";
  case WindowsV1UiaStop::kTimeout: return "timeout";
  case WindowsV1UiaStop::kBudget: return "budget";
  case WindowsV1UiaStop::kCanceled: return "canceled";
  }
  return "invalid";
}

std::string Sc820ReadProbe(const std::string &metadata, std::optional<std::uint64_t> stop_serial) {
  std::string mode;
  ReadJsonString(metadata, "mode", &mode);
  const bool twice = mode == "twice" || mode == "deadline";
  const auto budget = mode == "deadline" ? std::chrono::milliseconds(1500) : kWindowsV1UiaObserveBudget;
  const auto started = std::chrono::steady_clock::now();
  // The seeded control session's epoch, as an actual observe would use, not a refreshed epoch.
  const WindowsV1UiaPath path(budget, 1, stop_serial);
  // Existing diagnostic work in the outer scope; this is not a node limit.
  const std::size_t initial_nodes = twice ? 17 : 0;
  for (std::size_t index = 0; index < initial_nodes; ++index) WindowsV1UiaCountNode();
  std::string tree;
  std::size_t first_nodes = 0, second_nodes = 0;
  const bool first = ReadUiaObservation(fixture_pids[0], fixture_windows[0], &tree, &first_nodes);
  const bool first_empty = tree.empty();
  ScrubString(&tree);
  bool second = false;
  if (twice && first && path.Stop() == WindowsV1UiaStop::kNone) {
    if (mode == "deadline") {
      // Leave about 150 ms of the SAME outer deadline for the second real contact.
      Require(std::chrono::steady_clock::now() - started < std::chrono::milliseconds(1200),
              "uia_first_read_within_test_budget");
      std::this_thread::sleep_until(started + std::chrono::milliseconds(1350));
    }
    second = ReadUiaObservation(fixture_pids[0], fixture_windows[0], &tree, &second_nodes);
  }
  const bool empty = twice ? tree.empty() : first_empty;
  ScrubString(&tree);
  return "{\"firstOk\":" + std::string(first ? "true" : "false") +
      ",\"secondOk\":" + (second ? "true" : "false") +
      ",\"firstNodes\":" + std::to_string(first_nodes) + ",\"secondNodes\":" + std::to_string(second_nodes) +
      ",\"initialNodes\":" + std::to_string(initial_nodes) + ",\"outerNodes\":" + std::to_string(path.Nodes()) +
      ",\"stop\":\"" + Sc820StopName(path.Stop()) + "\",\"treeEmpty\":" + (empty ? "true" : "false") + "}";
}

BOOL Sc940EnumerateOwnedWindow(WNDENUMPROC callback, LPARAM parameter) {
  if (enumeration_count == 0 || enumeration_count > fixture_count) return FALSE;
  for (unsigned index = 0; index < enumeration_count; ++index) {
    DWORD owner = 0;
    if (!IsWindow(fixture_windows[index]) ||
        GetWindowThreadProcessId(fixture_windows[index], &owner) == 0 || owner != fixture_pids[index] ||
        callback(fixture_windows[index], parameter) == FALSE)
      return FALSE;
  }
  return TRUE;
}

struct FixtureReady { DWORD pid; UINT_PTR window; };

int Fixture(const wchar_t *mapping_name, const wchar_t *event_name, bool binding_controls = false) {
  ScopedKernelHandle mapping(OpenFileMappingW(FILE_MAP_WRITE, FALSE, mapping_name));
  ScopedKernelHandle ready(OpenEventW(EVENT_MODIFY_STATE, FALSE, event_name));
  if (mapping.value == nullptr || ready.value == nullptr) return 2;
  auto *shared = static_cast<FixtureReady *>(MapViewOfFile(mapping.value, FILE_MAP_WRITE, 0, 0, sizeof(FixtureReady)));
  if (shared == nullptr) return 3;
  WNDCLASSW wc{};
  wc.lpfnWndProc = DefWindowProcW;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"Sc940OwnedFixture";
  RegisterClassW(&wc);
  HWND window = CreateWindowExW(0, wc.lpszClassName, L"RCA fixture", WS_OVERLAPPEDWINDOW,
                                0, 0, 320, 200, nullptr, nullptr, wc.hInstance, nullptr);
  if (window == nullptr) { UnmapViewOfFile(shared); return 4; }
  if(binding_controls)for(int i=0;i<3;++i){
    HWND child=CreateWindowExW(0,L"BUTTON",i==2?L"Fixture unique":L"Fixture duplicate",WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,
      20,20+40*i,150,25,window,reinterpret_cast<HMENU>(static_cast<INT_PTR>(i==2?902:901)),wc.hInstance,nullptr);
    if(child==nullptr){UnmapViewOfFile(shared);DestroyWindow(window);return 5;}
  }
  ShowWindow(window, SW_SHOWNOACTIVATE);
  shared->pid = GetCurrentProcessId();
  shared->window = reinterpret_cast<UINT_PTR>(window);
  SetEvent(ready.value);
  UnmapViewOfFile(shared);
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  DestroyWindow(window);
  return 0;
}

sprint_coder::computer_use::FrameId Id(std::uint8_t byte) {
  sprint_coder::computer_use::FrameId id;
  id.bytes.fill(byte);
  return id;
}

void SeedOwnedValidationIdentity(WindowsSession *session) {
  ScopedKernelHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                                          FALSE, fixture_pids[0]));
  LockedWindowsExecutable image;
  std::string started;
  Require(process.value != nullptr && OpenLockedProcessExecutable(process.value, &image) &&
              ReadProcessStartIdentity(process.value, &started) &&
              WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT, "validation_owned_identity");
  std::wstring process_path;
  Require(ReadProcessPath(process.value, &process_path) && SameWindowsPath(process_path, image.identity.path),
          "validation_fixture_process_path_matches_held");
  session->pid = fixture_pids[0];
  session->window = session->active_window = fixture_windows[0];
  session->app_identity = image.identity.identity_digest;
  session->process_start = started;
  session->canonical_path = image.identity.path;
  session->window_identity = Sha256String("computer-window-identity-v1\n" + session->app_identity + "\n" +
      started + "\n" + std::to_string(reinterpret_cast<UINT_PTR>(session->window)));
  session->active_window_identity = session->window_identity;
  session->executable_volume_serial = image.identity.file_identity.volume_serial;
  session->executable_file_id = image.identity.file_identity.file_id;
  session->executable_digest = image.identity.executable_digest;
  session->signer_digest = image.identity.signer_digest;
  session->policy_language = image.identity.policy_language;
  session->eligibility_basis = sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
  session->process_handle = process.release();
  session->executable_file = image.file;
  image.file = INVALID_HANDLE_VALUE;
}

struct ValidationProbeResult {
  bool available = false, matches = false;
  std::uint64_t calls = 0, successes = 0;
  double elapsed_ms = 0;
};

struct UiaReadResult {
  bool first = false;
  bool second = false;
  bool empty = false;
  std::uint64_t first_nodes = 0;
  std::uint64_t second_nodes = 0;
  std::uint64_t initial_nodes = 0;
  std::uint64_t outer_nodes = 0;
  std::string stop;
};

struct RcaRun {
  ScopedKernelHandle entered{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle release{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle adopting{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle finished{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle epilogue_entered{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle epilogue_release{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle epilogue_thread;
  WindowsSession validation_probe_session;
  WindowsSession rejudge_probe_session;
  ScopedKernelHandle rejudge_comparison_file;
  ScopedKernelHandle resume_comparison_file;
  ScopedKernelHandle job;
  std::array<ScopedKernelHandle, 3> children;
  ScopedKernelHandle server{INVALID_HANDLE_VALUE};
  ScopedKernelHandle client{INVALID_HANDLE_VALUE};
  std::thread serving;
  std::thread receiving;
  std::thread watchdog;
  std::mutex replies_mutex;
  std::condition_variable replies_ready;
  std::unordered_map<unsigned, Frame> replies;
  std::unordered_map<unsigned, unsigned> reply_counts;
  std::atomic<bool> watchdog_fired{false};
  std::atomic<bool> serve_ok{false};
  bool cleaned = false;
  bool child_exited = false;
  bool worker_idle = false;
  bool fixture_launch_path_canonicalized = false;

  RcaRun() {
    Require(entered.value && release.value && adopting.value && finished.value && epilogue_entered.value &&
                epilogue_release.value, "event_creation");
    gate_entered = entered.value;
    gate_release = release.value;
    adoption_entered = adopting.value;
    {
      std::lock_guard lock(start_epilogue_mutex);
      start_epilogue_entered = epilogue_entered.value;
      start_epilogue_release = epilogue_release.value;
      start_epilogue_thread_owner = &epilogue_thread;
      start_epilogue_capture_failed = false;
    }
    job.value = CreateJobObjectW(nullptr, nullptr);
    Require(job.value != nullptr, "job_creation");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    Require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE,
            "job_limits");
    Require(SetHandleInformation(job.value, HANDLE_FLAG_INHERIT, 0) != FALSE, "job_not_inherited");
    watchdog = std::thread([this] {
      if (WaitForSingleObject(finished.value, 60'000) == WAIT_OBJECT_0) return;
      watchdog_fired.store(true);
      SetEvent(release.value);
      SetEvent(epilogue_release.value);
      if (job.value != nullptr) TerminateJobObject(job.value, 90);
      // The outer test must fail instead of hanging in join if a real OS call did not return.
      if (WaitForSingleObject(finished.value, 2'000) != WAIT_OBJECT_0)
        TerminateProcess(GetCurrentProcess(), 90);
    });
  }

  void StartFixture(bool canonical_executable = false, bool binding_controls = false) {
    Require(fixture_count < fixture_pids.size(), "fixture_limit");
    const unsigned index = fixture_count;
    ScopedKernelHandle &child = children[index];
    const std::wstring suffix = std::to_wstring(GetCurrentProcessId()) + L"-" +
                                std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(index);
    const std::wstring mapping_name = L"Local\\sc940-map-" + suffix;
    const std::wstring event_name = L"Local\\sc940-ready-" + suffix;
    ScopedKernelHandle mapping(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
                                                  sizeof(FixtureReady), mapping_name.c_str()));
    ScopedKernelHandle ready(CreateEventW(nullptr, TRUE, FALSE, event_name.c_str()));
    Require(mapping.value && ready.value, "fixture_channels");
    std::vector<wchar_t> executable(32768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
    Require(length > 0 && length < executable.size(), "own_executable");
    std::wstring fixture_executable(executable.data(), length);
    if (canonical_executable) {
      // TEMP may use an 8.3 alias. Identity tests need the same path spelling that a native
      // session records; a path mismatch would reject before the intended FileId fault gate.
      LockedWindowsExecutable image;
      Require(OpenLockedWindowsExecutable(fixture_executable, &image), "validation_fixture_executable");
      fixture_launch_path_canonicalized = !SameWindowsPath(fixture_executable, image.identity.path);
      fixture_executable = image.identity.path;
    }
    std::wstring command = L"\"" + fixture_executable + L"\" fixture \"" +
                           mapping_name + L"\" \"" + event_name + L"\"";
    if(binding_controls)command+=L" bindings";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    Require(CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                            nullptr, nullptr, &startup, &process) != FALSE, "fixture_start");
    child.value = process.hProcess;
    ScopedKernelHandle thread(process.hThread);
    Require(AssignProcessToJobObject(job.value, child.value) != FALSE, "fixture_job_assignment");
    Require(ResumeThread(thread.value) != static_cast<DWORD>(-1), "fixture_resume");
    Require(WaitForSingleObject(ready.value, 15'000) == WAIT_OBJECT_0, "fixture_ready");
    auto *shared = static_cast<const FixtureReady *>(MapViewOfFile(mapping.value, FILE_MAP_READ, 0, 0, sizeof(FixtureReady)));
    Require(shared != nullptr, "fixture_ready_mapping");
    const FixtureReady found = *shared;
    UnmapViewOfFile(shared);
    Require(found.pid == process.dwProcessId && found.window != 0, "fixture_ready_binding");
    fixture_pids[index] = found.pid;
    fixture_windows[index] = reinterpret_cast<HWND>(found.window);
    ++fixture_count;
    enumeration_count = fixture_count;
    Require(WaitForSingleObject(child.value, 0) == WAIT_TIMEOUT, "fixture_stays_alive");
  }

  void AttachOwnedSibling(DWORD pid, HWND window, const std::string &created, const std::wstring &path) {
    ScopedKernelHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | PROCESS_TERMINATE,
                                          FALSE, pid));
    LockedWindowsExecutable expected, actual;
    std::string started;
    DWORD owner = 0;
    Require(process.value != nullptr && OpenLockedWindowsExecutable(path, &expected) &&
                OpenLockedProcessExecutable(process.value, &actual) &&
                SameWindowsFileIdentity(expected.identity.file_identity, actual.identity.file_identity) &&
                ReadProcessStartIdentity(process.value, &started) && started == created &&
                IsWindow(window) && GetWindowThreadProcessId(window, &owner) != 0 && owner == pid &&
                WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT, "owned_sibling_binding");
    children[0].value = process.release();
    fixture_pids[0] = pid;
    fixture_windows[0] = window;
    fixture_count = enumeration_count = 1;
  }

  void PrepareValidationProbe() {
    SeedOwnedValidationIdentity(&validation_probe_session);
    validation_probe_source = &validation_probe_session;
  }

  void StartPipe(bool same_epoch_close, bool seed_control = true, bool seed_validation_handles = false) {
    SECURITY_ATTRIBUTES security{};
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    Require(BuildCurrentUserPipeSecurity(&security, &descriptor), "pipe_security");
    const std::wstring name = L"\\\\.\\pipe\\sprint-coder-computer-use-rca-" +
                              std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, 65536, 65536, 0, &security);
    LocalFree(descriptor);
    Require(server.value != INVALID_HANDLE_VALUE, "pipe_creation");
    struct Connection {
      HANDLE pipe;
      ScopedKernelHandle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
      OVERLAPPED operation{};
      bool pending = false;
      explicit Connection(HANDLE value) : pipe(value) {
        Require(event.value != nullptr, "connection_event");
        operation.hEvent = event.value;
      }
      ~Connection() {
        if (!pending) return;
        // Keep OVERLAPPED and its event alive until cancellation itself has completed.
        CancelIoEx(pipe, &operation);
        DWORD transferred = 0;
        GetOverlappedResult(pipe, &operation, &transferred, TRUE);
      }
    } connection(server.value);
    const BOOL immediate = ConnectNamedPipe(server.value, &connection.operation);
    const DWORD connect_error = immediate ? ERROR_SUCCESS : GetLastError();
    connection.pending = !immediate && connect_error == ERROR_IO_PENDING;
    Require(immediate || connect_error == ERROR_IO_PENDING || connect_error == ERROR_PIPE_CONNECTED, "pipe_listening");
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                               FILE_FLAG_OVERLAPPED, nullptr);
    Require(client.value != INVALID_HANDLE_VALUE, "pipe_client");
    if (connection.pending) {
      DWORD transferred = 0;
      Require(WaitForSingleObject(connection.event.value, 5000) == WAIT_OBJECT_0 &&
                  GetOverlappedResult(server.value, &connection.operation, &transferred, FALSE), "pipe_connected");
      connection.pending = false;
    }
    ULONG peer = 0;
    Require(GetNamedPipeClientProcessId(server.value, &peer) && peer == GetCurrentProcessId(), "pipe_peer");

    // This is a control session for real Cancel/Close receipts, not a claim that start/grants passed.
    if (seed_control) {
      WindowsSession session;
      session.session_id = "sc940-control";
      session.cancel_epoch = 1;
      session.has_observation = true;
      session.observation_revision = 1;
      const auto inserted = sessions.emplace(FrameIdKey(Id(7)), std::move(session));
      Require(inserted.second, "control_session_seed");
      if (seed_validation_handles) {
        SeedOwnedValidationIdentity(&inserted.first->second);
        validation_source_process.store(inserted.first->second.process_handle);
        validation_source_file.store(inserted.first->second.executable_file);
      }
    }
    // The close-only same-epoch case proves max(cancelEpoch) is not an invalidation serial.
    cancellation_epoch.store(same_epoch_close ? 2 : 1);
    windows_v2_main_pid = GetCurrentProcessId();
    serving = std::thread([this] {
      rca_consumer_thread_id.store(GetCurrentThreadId());
      const HRESULT apartment = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
      if (SUCCEEDED(apartment)) {
        // Match ServeMain's client-side warmup before accepting any target operation.
        WarmWindowsV1Automation();
        // No capture/input capability is needed for this protocol and measurement-only seam.
        serve_ok.store(ServePipe(server.value, BackendProbe{}));
        CoUninitialize();
      }
    });
    receiving = std::thread([this] {
      Frame frame;
      while (ReadFrame(client.value, &frame)) {
        {
          std::lock_guard<std::mutex> lock(replies_mutex);
          ++reply_counts[frame.header.request_id.bytes[0]];
          replies.emplace(frame.header.request_id.bytes[0], std::move(frame));
        }
        replies_ready.notify_all();
        frame = {};
      }
    });
  }

  void Send(MessageType type, std::uint8_t id, std::string_view metadata, std::uint8_t session_byte = 7) {
    FrameHeader header;
    header.message_type = static_cast<std::uint16_t>(type);
    header.request_id = Id(id);
    header.session_id = Id(session_byte);
    if (type == MessageType::kCancel) header.cancel_id = Id(9);
    Require(WriteFrame(client.value, header, metadata), "frame_write");
  }

  bool Wait(unsigned id, DWORD milliseconds) {
    std::unique_lock<std::mutex> lock(replies_mutex);
    return replies_ready.wait_for(lock, std::chrono::milliseconds(milliseconds), [&] { return replies.contains(id); });
  }

  bool Receipt(unsigned id, MessageType type, std::string_view expected, std::uint64_t epoch,
               std::uint8_t session_byte = 7, std::string_view session_name = "sc940-control",
               std::uint64_t expected_attempts = 0) {
    std::lock_guard<std::mutex> lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    const std::string body(frame.metadata.begin(), frame.metadata.end());
    std::string result, session;
    std::uint64_t actual_epoch = 0, attempts = 1;
    bool drained = false;
    return frame.header.message_type == static_cast<std::uint16_t>(type) && frame.binary.empty() &&
           frame.header.request_id.bytes == Id(static_cast<std::uint8_t>(id)).bytes &&
           frame.header.session_id.bytes == Id(session_byte).bytes &&
           ReadJsonString(body, "result", &result) && result == expected &&
           ReadJsonString(body, "sessionId", &session) && session == session_name &&
           ReadJsonUint64(body, "cancelEpoch", &actual_epoch) && actual_epoch == epoch &&
           ReadJsonUint64(body, "inputAttemptCount", &attempts) && attempts == expected_attempts &&
           ReadOptionalJsonBoolean(body, "drained", &drained) && drained;
  }

  bool ProbeReply(unsigned id, MessageType type) {
    std::lock_guard<std::mutex> lock(replies_mutex);
    const auto found = replies.find(id);
    return found != replies.end() && found->second.header.message_type == static_cast<std::uint16_t>(type) &&
           found->second.header.request_id.bytes == Id(static_cast<std::uint8_t>(id)).bytes &&
           found->second.header.session_id.bytes == Id(7).bytes && found->second.binary.empty();
  }

  bool Error(unsigned id, std::string_view code, std::uint8_t session_byte = 7) {
    std::lock_guard<std::mutex> lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    const std::string body(frame.metadata.begin(), frame.metadata.end());
    std::string actual;
    bool accepted = true;
    return frame.header.message_type == static_cast<std::uint16_t>(MessageType::kError) &&
           frame.header.request_id.bytes == Id(static_cast<std::uint8_t>(id)).bytes &&
           frame.header.session_id.bytes == Id(session_byte).bytes && frame.binary.empty() &&
           ReadJsonString(body, "code", &actual) && actual == code &&
           ReadOptionalJsonBoolean(body, "accepted", &accepted) && !accepted;
  }

  bool ListTargets(unsigned id, std::uint64_t *generation, std::string *rows, bool *truncated) {
    std::lock_guard<std::mutex> lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    const std::string body(frame.metadata.begin(), frame.metadata.end());
    const std::string_view prefix = "\"targets\":[";
    const std::size_t begin = body.find(prefix);
    if (frame.header.message_type != static_cast<std::uint16_t>(MessageType::kProbeResult) ||
        frame.header.request_id.bytes != Id(static_cast<std::uint8_t>(id)).bytes ||
        frame.header.session_id.bytes != Id(7).bytes || !frame.binary.empty() ||
        body.size() > kMaxMetadataBytes || begin == std::string::npos || !body.ends_with("]}") ||
        !ReadJsonUint64(body, "generation", generation) ||
        !ReadOptionalJsonBoolean(body, "truncated", truncated))
      return false;
    *rows = body.substr(begin + prefix.size(), body.size() - begin - prefix.size() - 2);
    return true;
  }

  bool ProbeBody(unsigned id, std::string *body, std::uint8_t session_byte = 7) {
    std::lock_guard lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    if (frame.header.message_type != static_cast<std::uint16_t>(MessageType::kProbeResult) ||
        frame.header.request_id.bytes != Id(static_cast<std::uint8_t>(id)).bytes ||
        frame.header.session_id.bytes != Id(session_byte).bytes || !frame.binary.empty()) return false;
    body->assign(frame.metadata.begin(), frame.metadata.end());
    return true;
  }

  bool PreflightDenied(unsigned id) {
    std::lock_guard<std::mutex> lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    const std::string body(frame.metadata.begin(), frame.metadata.end());
    std::string decision, reason;
    std::uint64_t attempts = 1;
    return frame.header.message_type == static_cast<std::uint16_t>(MessageType::kPreflightResult) &&
           frame.header.request_id.bytes == Id(static_cast<std::uint8_t>(id)).bytes &&
           frame.header.session_id.bytes == Id(7).bytes && frame.binary.empty() &&
           ReadJsonString(body, "decision", &decision) && decision == "denied" &&
           ReadJsonString(body, "reasonCode", &reason) && reason == "native_session_identity_changed" &&
           ReadJsonUint64(body, "inputAttemptCount", &attempts) && attempts == 0 &&
           body.find("\"ticket\":null") != std::string::npos;
  }

  bool WaitWorkerIdle(DWORD milliseconds) {
    const ULONGLONG deadline = GetTickCount64() + milliseconds;
    while (WindowsTargetListWorkerRunning().load(std::memory_order_acquire) && GetTickCount64() < deadline)
      Sleep(1);
    return !WindowsTargetListWorkerRunning().load(std::memory_order_acquire);
  }

  bool WaitUiaWorkerIdle(DWORD milliseconds) {
    const ULONGLONG deadline = GetTickCount64() + milliseconds;
    while (WindowsUiaReadWorkerRunning().load(std::memory_order_acquire) && GetTickCount64() < deadline)
      Sleep(1);
    return !WindowsUiaReadWorkerRunning().load(std::memory_order_acquire);
  }

  unsigned ReplyCount(unsigned id) {
    std::lock_guard lock(replies_mutex);
    return reply_counts[id];
  }

  HANDLE StartWorkerThread() {
    std::lock_guard lock(start_epilogue_mutex);
    return start_epilogue_capture_failed ? nullptr : epilogue_thread.value;
  }

  bool UiaReply(unsigned id, UiaReadResult *output) {
    std::lock_guard lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    const std::string body(frame.metadata.begin(), frame.metadata.end());
    return frame.header.message_type == static_cast<std::uint16_t>(MessageType::kProbeResult) &&
           frame.header.request_id.bytes == Id(static_cast<std::uint8_t>(id)).bytes &&
           frame.header.session_id.bytes == Id(7).bytes && frame.binary.empty() && body.size() < 512 &&
           ReadOptionalJsonBoolean(body, "firstOk", &output->first) &&
           ReadOptionalJsonBoolean(body, "secondOk", &output->second) &&
           ReadOptionalJsonBoolean(body, "treeEmpty", &output->empty) &&
           ReadJsonUint64(body, "firstNodes", &output->first_nodes) &&
           ReadJsonUint64(body, "secondNodes", &output->second_nodes) &&
           ReadJsonUint64(body, "initialNodes", &output->initial_nodes) &&
           ReadJsonUint64(body, "outerNodes", &output->outer_nodes) &&
           ReadJsonString(body, "stop", &output->stop);
  }

  bool ValidationReply(unsigned id, ValidationProbeResult *output) {
    std::string body;
    bool identity_only = false;
    return ProbeBody(id, &body) && body.size() < 512 &&
        ReadOptionalJsonBoolean(body, "identityOnly", &identity_only) && identity_only &&
        ReadOptionalJsonBoolean(body, "available", &output->available) &&
        ReadOptionalJsonBoolean(body, "matches", &output->matches) &&
        ReadJsonUint64(body, "calls", &output->calls) && ReadJsonUint64(body, "successes", &output->successes) &&
        ReadJsonDouble(body, "elapsedMs", &output->elapsed_ms);
  }

  void Cleanup() {
    if (cleaned) return;
    cleaned = true;
    SetEvent(release.value);
    HANDLE old_start_thread = nullptr;
    bool capture_failed = false;
    {
      std::lock_guard lock(start_epilogue_mutex);
      hold_start_epilogue.store(false);
      start_epilogue_thread_owner = nullptr;
      old_start_thread = epilogue_thread.value;
      capture_failed = start_epilogue_capture_failed;
      SetEvent(epilogue_release.value);
    }
    if (old_start_thread != nullptr && WaitForSingleObject(old_start_thread, 5000) != WAIT_OBJECT_0) {
      // Do not destroy the events or the duplicated handle while the worker can still use them.
      // Fail the owned test process, as the existing watchdog does, instead of racing teardown.
      watchdog_fired.store(true);
      if (job.value != nullptr) TerminateJobObject(job.value, 90);
      TerminateProcess(GetCurrentProcess(), 90);
      std::terminate();
    }
    if (client.value != INVALID_HANDLE_VALUE) CancelIoEx(client.value, nullptr);
    if (server.value != INVALID_HANDLE_VALUE) { CancelIoEx(server.value, nullptr); DisconnectNamedPipe(server.value); }
    if (serving.joinable()) serving.join();
    if (receiving.joinable()) receiving.join();
    // The detached production worker must release its slot/resources before our fixture is killed.
    worker_idle = WaitWorkerIdle(15'000) && !capture_failed;
    worker_idle = WaitUiaWorkerIdle(15'000) && worker_idle;
    if (resume_diagnostic_active.load()) {
      if (!worker_idle || !WaitAllResumeThreads()) {
        watchdog_fired.store(true);
        if (job.value != nullptr) TerminateJobObject(job.value, 90);
        TerminateProcess(GetCurrentProcess(), 90);
        std::terminate();
      }
      worker_idle = CloseResumeThreadEvidence() && worker_idle;
    }
    ReleaseWindowsSessionResources(&validation_probe_session);
    validation_probe_source = nullptr;
    rejudge_probe_source.store(nullptr, std::memory_order_release);
    ReleaseWindowsSessionResources(&rejudge_probe_session);
    if (rejudge_comparison_file.value != nullptr) CloseHandle(rejudge_comparison_file.release());
    rejudge_other_file = INVALID_HANDLE_VALUE;
    if (resume_comparison_file.value != nullptr) CloseHandle(resume_comparison_file.release());
    resume_other_file = INVALID_HANDLE_VALUE;
    validation_case_active.store(false);
    if (job.value != nullptr) TerminateJobObject(job.value, 0);
    child_exited = true;
    for (auto &child : children)
      if (child.value != nullptr) {
        if (WaitForSingleObject(child.value, 0) == WAIT_TIMEOUT) TerminateProcess(child.value, 0);
        child_exited = WaitForSingleObject(child.value, 5000) == WAIT_OBJECT_0 && child_exited;
      }
    for (auto &entry : sessions) ReleaseWindowsSessionResources(&entry.second);
    sessions.clear();
    SetEvent(finished.value);
    if (watchdog.joinable()) watchdog.join();
  }
  ~RcaRun() { Cleanup(); }
};

bool WaitStopSerial(std::uint64_t before, DWORD milliseconds) {
  const ULONGLONG deadline = GetTickCount64() + milliseconds;
  while (WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) == before &&
         GetTickCount64() < deadline)
    Sleep(1);
  return WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) != before;
}

void AssertBusyRefusals(RcaRun &run) {
  const unsigned measured = measurement_calls.load();
  run.Send(MessageType::kProbe, 5, "{\"operation\":\"list_targets\"}");
  Require(run.Wait(5, 1000) && run.Error(5, "list_targets_unavailable"), "busy_list_refused");
  // API 3 parses/adopts the start owner before the busy check. Supply a syntactically valid
  // request so this still proves the occupied worker refuses target I/O, not just malformed input.
  const std::string busy_start = "{\"operation\":\"start_session\",\"sessionId\":\"sc940-control\","
      "\"pid\":1,\"windowId\":\"1\",\"cancelEpoch\":0,\"appIdentityDigest\":\"" + std::string(64, 'a') +
      "\",\"windowIdentityDigest\":\"" + std::string(64, 'b') + "\",\"canonicalPath\":\"C:/unread-fixture.exe\","
      "\"executableDigest\":\"" + std::string(64, 'c') + "\",\"expectedBoundsX\":0,\"expectedBoundsY\":0,"
      "\"expectedBoundsWidth\":1,\"expectedBoundsHeight\":1}";
  run.Send(MessageType::kProbe, 6, busy_start);
  Require(run.Wait(6, 1000) && run.Error(6, "session_target_rejected"), "busy_start_refused");
  WindowsSession unmeasured;
  RECT bounds{};
  std::string reason;
  Require(!ValidateWindowsSession(unmeasured, &bounds, &reason) && reason == "session_identity_changed",
          "busy_validation_refused");
  const std::string preflight = "{\"requestId\":\"busy-preflight\",\"actionDigest\":\"" +
      std::string(64, 'a') + "\",\"cancelEpoch\":1,\"observationRevision\":1,\"type\":\"invoke\",\"targetId\":\"fixture\"}";
  run.Send(MessageType::kPreflight, 8, preflight);
  Require(run.Wait(8, 1000) && run.PreflightDenied(8), "busy_preflight_refused");
  run.Send(MessageType::kProbe, 9, "{\"operation\":\"pick_application\"}");
  Require(run.Wait(9, 1000) && run.Error(9, "picker_unavailable"), "busy_picker_refused");
  const std::string busy_discovery = "{\"operation\":\"list_windows_cancellable\",\"discoveryId\":\"busy-discovery\","
      "\"canonicalPath\":\"C:/unread-fixture.exe\",\"identityDigest\":\"" + std::string(64, 'a') +
      "\",\"executableDigest\":\"" + std::string(64, 'c') + "\",\"signerDigest\":\"\"}";
  run.Send(MessageType::kProbe, 10, busy_discovery);
  Require(run.Wait(10, 1000) && run.Error(10, "profile_identity_invalid"), "busy_windows_refused");
  Require(measurement_calls.load() == measured && synchronous_session_probes.load() == 0,
          "busy_paths_read_no_target");
  Require(WindowsTargetListWorkerRunning().load(), "busy_worker_slot_retained");
}

bool HasContextCandidate() {
  auto &control = WindowsTargetListControl();
  std::lock_guard lock(control.stop_mutex);
  return control.context_candidate != nullptr;
}

struct ListedStart {
  std::uint64_t generation = 0, ruleset = 0, pid = 0;
  std::string window, app, window_identity, executable, path, signer, mode;
  double x = 0, y = 0, width = 0, height = 0;
  std::string Metadata(std::uint64_t epoch, const std::string &session_id = "sc940-new") const {
    return "{\"operation\":\"start_session\",\"eligibilityBasis\":\"v2-denylist\",\"sessionId\":\"" + JsonEscape(session_id) + "\","
        "\"profileRevision\":1,\"cancelEpoch\":" + std::to_string(epoch) + ",\"pid\":" + std::to_string(pid) +
        ",\"windowId\":\"" + window + "\",\"appIdentityDigest\":\"" + app +
        "\",\"windowIdentityDigest\":\"" + window_identity + "\",\"canonicalPath\":\"" + JsonEscape(path) +
        "\",\"executableDigest\":\"" + executable + "\",\"signerDigest\":null,\"expectedBoundsX\":" + std::to_string(x) +
        ",\"expectedBoundsY\":" + std::to_string(y) + ",\"expectedBoundsWidth\":" + std::to_string(width) +
        ",\"expectedBoundsHeight\":" + std::to_string(height) + ",\"targetGeneration\":" + std::to_string(generation) +
        ",\"denyRulesetVersion\":" + std::to_string(ruleset) + "}";
  }
};

ListedStart ReadListedStart(RcaRun &run, std::uint8_t request) {
  run.Send(MessageType::kProbe, request, "{\"operation\":\"list_targets\"}");
  ListedStart result;
  std::string rows, envelope, kind;
  bool truncated = true;
  Require(run.Wait(request, 7000) && run.ListTargets(request, &result.generation, &rows, &truncated) &&
              run.ProbeBody(request, &envelope) && !truncated && run.WaitWorkerIdle(1000), "start_real_list_reply");
  Require(ReadJsonUint64(envelope, "rulesetVersion", &result.ruleset) &&
              ReadJsonString(rows, "kind", &kind) && kind == "upper" &&
              ReadJsonString(rows, "maximumMode", &result.mode) && result.mode == "observe_only" &&
              ReadJsonUint64(rows, "pid", &result.pid) && result.pid == fixture_pids[0] &&
              ReadJsonString(rows, "windowId", &result.window) &&
              result.window == std::to_string(reinterpret_cast<UINT_PTR>(fixture_windows[0])) &&
              ReadJsonString(rows, "appIdentityDigest", &result.app) &&
              ReadJsonString(rows, "windowIdentityDigest", &result.window_identity) &&
              ReadJsonString(rows, "executableDigest", &result.executable) &&
              ReadJsonString(rows, "executablePath", &result.path) &&
              rows.find("\"signerDigest\":null") != std::string::npos,
          "start_unsigned_gui_list_identity");
  const auto begin = rows.find("\"bounds\":{");
  const auto end = rows.find('}', begin);
  Require(begin != std::string::npos && end != std::string::npos, "start_list_bounds_present");
  const std::string bounds = rows.substr(begin, end - begin + 1);
  Require(ReadJsonDouble(bounds, "x", &result.x) && ReadJsonDouble(bounds, "y", &result.y) &&
              ReadJsonDouble(bounds, "width", &result.width) && ReadJsonDouble(bounds, "height", &result.height) &&
              result.width > 0 && result.height > 0, "start_list_bounds_valid");
  return result;
}

void AssertStarted(RcaRun &run, std::uint8_t request, const ListedStart &listed, std::uint64_t epoch,
                   std::uint8_t session_byte = 8, std::string_view session_name = "sc940-new") {
  std::string body, app, window, mode, session_id;
  std::uint64_t actual_epoch = 0, attempts = 1;
  Require(run.Wait(request, 10'000) && run.ProbeBody(request, &body, session_byte) &&
              ReadJsonString(body, "sessionId", &session_id) && session_id == session_name &&
              ReadJsonString(body, "appIdentityDigest", &app) && app == listed.app &&
              ReadJsonString(body, "windowIdentityDigest", &window) && window == listed.window_identity &&
              ReadJsonString(body, "maximumMode", &mode) && mode == "observe_only" &&
              ReadJsonUint64(body, "cancelEpoch", &actual_epoch) && actual_epoch == epoch &&
              ReadJsonUint64(body, "inputAttemptCount", &attempts) && attempts == 0,
          "start_new_session_success");
  Require(!WindowsTargetListWorkerRunning().load(), "start_success_releases_busy_immediately");
  const auto found = sessions.find(FrameIdKey(Id(session_byte)));
  Require(found != sessions.end() && found->second.pid == fixture_pids[0] &&
              found->second.window == fixture_windows[0] && found->second.app_identity == listed.app &&
              found->second.maximum_mode == "observe_only" && GetProcessId(found->second.process_handle) == listed.pid &&
              !ticket_states.contains(FrameIdKey(Id(session_byte))), "start_only_consumer_adopts_session");
  RECT bounds{};
  std::string reason;
  const unsigned before = synchronous_session_probes.load();
  Require(ValidateWindowsSession(found->second, &bounds, &reason) && synchronous_session_probes.load() == before + 1 &&
              std::abs(bounds.left - listed.x) <= 1 && std::abs(bounds.top - listed.y) <= 1 &&
              std::abs(bounds.right - bounds.left - listed.width) <= 1 &&
              std::abs(bounds.bottom - bounds.top - listed.height) <= 1, "start_immediate_real_validation");
}

void CloseStarted(RcaRun &run, std::uint8_t cancel_request, std::uint8_t close_request, std::uint64_t epoch,
                  std::uint8_t session_byte = 8, std::string_view session_name = "sc940-new") {
  run.Send(MessageType::kCancel, cancel_request, "{\"cancelEpoch\":" + std::to_string(epoch) + "}", session_byte);
  run.Send(MessageType::kProbe, close_request,
           "{\"operation\":\"close_session\",\"cancelEpoch\":" + std::to_string(epoch + 1) + "}", session_byte);
  Require(run.Wait(cancel_request, 1000) && run.Receipt(cancel_request, MessageType::kDispatchResult, "canceled", epoch, session_byte, session_name) &&
              run.Wait(close_request, 1000) && run.Receipt(close_request, MessageType::kProbeResult, "closed", epoch + 1, session_byte, session_name),
          "start_real_session_drained");
  Require(!sessions.contains(FrameIdKey(Id(session_byte))), "start_closed_session_removed");
}

int DiagnoseStart(std::wstring_view scenario, DWORD pid, HWND window, const std::string &created,
                  const std::wstring &fixture_path, bool focus_control_ready) {
  const bool healthy = scenario == L"start-healthy";
  const bool cancel = scenario == L"start-open-cancel";
  const bool queued = scenario == L"start-prequeued-close";
  const bool ready = scenario == L"start-ready-close";
  const bool adopt = scenario == L"start-adopt-close";
  const char *label = healthy ? "start-healthy" : cancel ? "start-open-cancel" : queued ? "start-prequeued-close" :
      ready ? "start-ready-close" : adopt ? "start-adopt-close" : "start-open-close";
  RcaRun run;
  ULONGLONG stop_ms = 0;
  bool stop_proven = false, late_cleanup = false, environment_failure = false;
  try {
    Require(ConfigurePerMonitorDpiAwareness(), "start_dpi_awareness");
    run.AttachOwnedSibling(pid, window, created, fixture_path);
    const auto require_foreground = [&] {
      const HWND foreground = GetForegroundWindow();
      const bool available = !IsIconic(window) && (ready
          ? focus_control_ready && foreground != nullptr && foreground != window && !IsNativeTakeoverWindow(foreground)
          : foreground == window);
      if (!available) environment_failure = true;
      Require(available, "start_owned_foreground_unavailable");
    };
    if (healthy || ready || adopt) require_foreground();
    run.StartPipe(false, cancel);
    run.Send(MessageType::kHandshake, 1, "{\"protocolVersion\":1,\"apiVersion\":3}");
    Require(run.Wait(1, 5000) && run.ProbeReply(1, MessageType::kHandshakeResult), "start_handshake");
    const ListedStart listed = ReadListedStart(run, 30);
    Require(windows_v2_main_pid == GetCurrentProcessId() && !sessions.contains(FrameIdKey(Id(8))) &&
                (cancel || sessions.empty()), "start_real_client_empty_session");
    hold_point.store(healthy ? HoldPoint::kNone : queued ? HoldPoint::kConsumer : ready ? HoldPoint::kStartReady :
                     adopt ? HoldPoint::kStartAdopt : HoldPoint::kStartOpen);
    hold_start_epilogue.store(healthy);
    run.Send(MessageType::kProbe, 2, listed.Metadata(1), 8);
    if (healthy) {
      AssertStarted(run, 2, listed, 1);
      Require(WaitForSingleObject(run.epilogue_entered.value, 5000) == WAIT_OBJECT_0, "start_old_worker_epilogue");
      Require(run.StartWorkerThread() != nullptr, "start_old_worker_thread_captured");
      // Keep the old successful worker alive while a new list owns the same single-flight slot.
      held_measure_pid = pid;
      hold_point.store(HoldPoint::kMeasure);
      run.Send(MessageType::kProbe, 31, "{\"operation\":\"list_targets\"}");
      Require(WaitForSingleObject(run.entered.value, 5000) == WAIT_OBJECT_0 && WindowsTargetListWorkerRunning().load(),
              "start_next_worker_claimed_slot");
      hold_start_epilogue.store(false);
      SetEvent(run.epilogue_release.value);
      Require(WaitForSingleObject(run.StartWorkerThread(), 5000) == WAIT_OBJECT_0, "start_old_worker_exited");
      Require(WindowsTargetListWorkerRunning().load(), "start_old_worker_does_not_release_next_slot");
      hold_point.store(HoldPoint::kNone);
      SetEvent(run.release.value);
      Require(run.Wait(31, 7000) && run.ProbeReply(31, MessageType::kProbeResult) && run.WaitWorkerIdle(1000),
              "start_next_worker_completes");
      CloseStarted(run, 22, 23, 2);
    } else {
      Require(WaitForSingleObject(run.entered.value, 10'000) == WAIT_OBJECT_0 &&
                  WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT &&
                  WindowsTargetListWorkerRunning().load() == !queued, "start_fault_gate_entered");
      if (cancel) {
        const unsigned opens = start_open_calls.load(), measures = measurement_calls.load();
        const unsigned workers = start_worker_attempts.load();
        const std::uint64_t serial = WindowsTargetListControl().stop_serial.load();
        const ULONGLONG sent = GetTickCount64();
        // Same first Stop as the be6 RCA: a valid Cancel of the seeded control session.
        run.Send(MessageType::kCancel, 4, "{\"cancelEpoch\":2}");
        Require(WaitStopSerial(serial, 1000), "start_cancel_reader_progress");
        Require(run.Wait(2, 1000) && run.Error(2, "session_start_canceled", 8) &&
                    run.Wait(4, 1000) && run.Receipt(4, MessageType::kDispatchResult, "canceled", 2),
                "start_valid_cancel_receipt_before_release");
        // API 3 keeps each SID/header pair immutable. First prove alias rejection, then use
        // a genuinely fresh lifetime with the new epoch/serial to test the occupied input lane.
        run.Send(MessageType::kProbe, 6, listed.Metadata(2), 9);
        Require(run.Wait(6, 1000) && run.Error(6, "session_id_reuse", 9), "start_sid_alias_refused");
        run.Send(MessageType::kProbe, 11, listed.Metadata(2, "sc940-busy"), 9);
        run.Send(MessageType::kProbe, 7, "{\"operation\":\"list_targets\"}");
        Require(run.Wait(11, 1000) && run.Error(11, "session_start_canceled", 9) &&
                    run.Wait(7, 1000) && run.Error(7, "list_targets_unavailable"), "start_fresh_busy_requests_refused");
        {
          std::lock_guard lock(WindowsTargetListControl().stop_mutex);
          const auto owner = WindowsStarts().input_owner;
          Require(owner != nullptr && owner->session_key == FrameIdKey(Id(8)) &&
                      owner->pending_requests.load() != 0, "start_old_worker_retains_input_lane");
        }
        run.Send(MessageType::kCancel, 3, "{\"cancelEpoch\":2}", 8);
        Require(run.Wait(3, 1000) && run.Error(3, "invalid_cancel", 8), "start_uncreated_cancel_bounded");
        run.Send(MessageType::kProbe, 5, "{\"operation\":\"close_session\",\"cancelEpoch\":3}");
        Require(run.Wait(5, 1000) && run.Receipt(5, MessageType::kProbeResult, "closed", 3),
                "start_control_receipts_before_release");
        stop_ms = GetTickCount64() - sent;
        Require(start_open_calls.load() == opens && start_worker_attempts.load() == workers && measurement_calls.load() == measures &&
                    WindowsTargetListWorkerRunning().load(), "start_busy_starts_no_worker");
      } else {
        const std::uint64_t serial = WindowsTargetListControl().stop_serial.load();
        const ULONGLONG sent = GetTickCount64();
        run.Send(MessageType::kProbe, 3, "{\"operation\":\"close_session\",\"cancelEpoch\":2}", 8);
        Require(WaitStopSerial(serial, 1000), "start_close_reader_progress");
        if (queued || ready || adopt) {
          hold_point.store(HoldPoint::kNone);
          SetEvent(run.release.value);
        }
        Require(run.Wait(2, 1000) && run.Error(2, "session_start_canceled", 8) &&
                    run.Wait(3, 1000) && run.Error(3, "native_close_unconfirmed", 8), "start_uncreated_close_bounded");
        stop_ms = GetTickCount64() - sent;
        Require(cancellation_epoch.load() == 1, "start_close_uses_serial_not_epoch");
      }
      Require(stop_ms < 1000 && !sessions.contains(FrameIdKey(Id(8))) &&
                  !ticket_states.contains(FrameIdKey(Id(8))) && start_focus_calls.load() == 0 &&
                  windows_v2_list_generation == listed.generation, "start_stop_prevents_adoption_and_focus");
      stop_proven = true;
      if (!queued && !ready && !adopt)
        Require(WindowsTargetListWorkerRunning().load() && WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT,
                "start_response_precedes_open_release");
      hold_point.store(HoldPoint::kNone);
      SetEvent(run.release.value);
      Require(run.WaitWorkerIdle(15'000) && start_open_calls.load() == (queued ? 0u : 1u) &&
                  start_worker_attempts.load() == (queued ? 0u : 1u) &&
                  start_open_successes.load() == (queued ? 0u : 1u) && !sessions.contains(FrameIdKey(Id(8))) &&
                  windows_v2_list_generation == listed.generation, "start_late_open_cleaned_without_adoption");
      late_cleanup = true;
      if (cancel) {
        require_foreground();
        const ListedStart fresh = ReadListedStart(run, 20);
        run.Send(MessageType::kProbe, 25, fresh.Metadata(4), 8);
        Require(run.Wait(25, 1000) && run.Error(25, "session_id_reuse", 8), "start_retired_lifetime_refused");
        run.Send(MessageType::kProbe, 21, fresh.Metadata(4, "sc940-retry"), 10);
        AssertStarted(run, 21, fresh, 4, 10, "sc940-retry");
        Require(start_open_calls.load() == 2 && start_worker_attempts.load() == 2, "start_explicit_retry_has_one_new_worker");
        CloseStarted(run, 22, 23, 5, 10, "sc940-retry");
      }
    }
    Require(start_focus_calls.load() == 0 && !wrong_measurement.load() && !gate_timed_out.load(), "start_no_input_or_foreign_target");
    run.Cleanup();
    Require(run.child_exited && run.worker_idle && !run.watchdog_fired.load(), "start_cleanup_completed");
    std::cout << "{\"case\":\"" << label << "\",\"stopMs\":" << stop_ms
              << ",\"stopProof\":" << (stop_proven ? "true" : "false")
              << ",\"lateCleanupVerified\":" << (late_cleanup ? "true" : "false")
              << ",\"healthyStartVerified\":" << (healthy || cancel ? "true" : "false")
              << ",\"inputAttempts\":0,\"lateAdoptionDiscarded\":" << (healthy ? "false" : "true")
              << ",\"slotHandoffVerified\":" << (healthy ? "true" : "false")
              << ",\"childExited\":true,\"threadsJoined\":true"
              << ",\"workerIdle\":true,\"watchdogFired\":false}\n";
    return 0;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"case\":\"" << label << "\",\"failure\":\"" << error.what()
              << "\",\"environmentFailure\":" << (environment_failure ? "true" : "false")
              << ",\"stopProof\":" << (stop_proven ? "true" : "false")
              << ",\"lateCleanupVerified\":" << (late_cleanup ? "true" : "false")
              << ",\"stopMs\":" << stop_ms << ",\"inputAttempts\":" << start_focus_calls.load()
              << ",\"childExited\":" << (run.child_exited ? "true" : "false")
              << ",\"workerIdle\":" << (run.worker_idle ? "true" : "false") << "}\n";
    return 1;
  }
}

struct RejudgeStateView {
  std::uint64_t active = 0, next = 0;
  DWORD thread = 0;
  bool queued = false;
};
RejudgeStateView RejudgeState() {
  auto &state = WindowsV2RejudgeControl();
  std::lock_guard lock(state.mutex);
  return {state.active_job_id, state.next_job_id,
          state.cancellation_thread == nullptr ? 0 : GetThreadId(state.cancellation_thread), state.queued != nullptr};
}
std::shared_ptr<WindowsV2RejudgePending> RejudgePending() {
  std::lock_guard lock(rejudge_pending_mutex);
  return rejudge_last_pending;
}
bool WaitRejudgeRetired(unsigned count) {
  const ULONGLONG deadline = GetTickCount64() + 15'000;
  while (rejudge_retired_jobs.load() != count && GetTickCount64() < deadline) Sleep(1);
  return rejudge_retired_jobs.load() == count && !WindowsTargetListWorkerRunning().load();
}
void SendRejudgeProbe(RcaRun &run, std::uint8_t request, std::string_view mode = "normal") {
  // Each explicit diagnostic request binds a fresh component snapshot to its actual input epoch.
  // This is not a resume of the unrelated receipt-control session.
  run.Send(MessageType::kProbe, request, "{\"operation\":\"sc940_rejudge_probe\",\"mode\":\"" +
      std::string(mode) + "\",\"epoch\":" + std::to_string(cancellation_epoch.load()) + "}");
}
bool RejudgeReply(RcaRun &run, unsigned id, bool expected, unsigned expected_successes = 0) {
  std::string body;
  bool component = false, judged = false;
  std::uint64_t attempts = 1, successes = 0;
  return run.ProbeBody(id, &body) && body.size() < 512 &&
      ReadOptionalJsonBoolean(body, "componentOnly", &component) && component &&
      ReadOptionalJsonBoolean(body, "rejudgeOk", &judged) && judged == expected &&
      body.find(expected ? "\"notWeb\":false" : "\"notWeb\":null") != std::string::npos &&
      ReadJsonUint64(body, "successes", &successes) && successes == expected_successes &&
      ReadJsonUint64(body, "inputAttemptCount", &attempts) && attempts == 0;
}

// Component integration only: measured identity is never admitted as a public control session.
int DiagnoseRejudge(std::wstring_view scenario, DWORD pid, HWND window, const std::string &created,
                    const std::wstring &fixture_path) {
  const bool cancel = scenario == L"rejudge-cancel";
  const bool queued = scenario == L"rejudge-prequeued-close";
  const bool repeat = scenario == L"rejudge-repeat";
  const bool cold = scenario == L"rejudge-cold-context-close";
  const std::string label(scenario.begin(), scenario.end());
  RcaRun run;
  ULONGLONG stop_ms = 0, close_ms = 0;
  std::uint64_t old_job = 0, next_job = 0;
  try {
    run.AttachOwnedSibling(pid, window, created, fixture_path);
    // The unrelated zero-input control seed exists only for real Cancel/Close receipts.
    run.StartPipe(false);
    run.Send(MessageType::kHandshake, 1, "{\"protocolVersion\":1,\"apiVersion\":3}");
    Require(run.Wait(1, 5000) && run.ProbeReply(1, MessageType::kHandshakeResult), "rejudge_handshake");
    const ListedStart listed = ReadListedStart(run, 10);
    Require(WindowsV2FactsContextCache().has_value() &&
                WindowsV2FactsContextCache()->lineage_root_pid == GetCurrentProcessId() &&
                windows_v2_main_pid == GetCurrentProcessId(), "rejudge_real_context_ready");
    SeedOwnedValidationIdentity(&run.rejudge_probe_session);
    auto &snapshot = run.rejudge_probe_session;
    snapshot.session_id = "sc940-rejudge-component";
    snapshot.cancel_epoch = 1;
    snapshot.maximum_mode = listed.mode;
    Require(snapshot.pid == listed.pid && snapshot.app_identity == listed.app &&
                snapshot.window_identity == listed.window_identity && snapshot.process_start == created &&
                snapshot.executable_digest == listed.executable && snapshot.signer_digest.empty() &&
                snapshot.maximum_mode == "observe_only" && !snapshot.not_web_file.has_value(),
            "rejudge_snapshot_from_real_upper_row");
    rejudge_probe_source.store(&snapshot, std::memory_order_release);
    LockedWindowsExecutable other;
    Require(OpenLockedProcessExecutable(GetCurrentProcess(), &other) &&
                !SameWindowsFileIdentity(other.identity.file_identity,
                    WindowsFileIdentity{snapshot.executable_volume_serial, snapshot.executable_file_id}),
            "rejudge_owned_different_file");
    run.rejudge_comparison_file.value = other.file;
    other.file = INVALID_HANDLE_VALUE;
    rejudge_other_file = run.rejudge_comparison_file.value;
    SendRejudgeProbe(run, 20);
    Require(run.Wait(20, 15'000) && RejudgeReply(run, 20, true, 1) &&
                rejudge_file_reads.load() == 1 && rejudge_file_successes.load() == 1 &&
                WaitRejudgeRetired(1), "rejudge_real_baseline_passes_without_foreground");
    const auto baseline = RejudgeState();
    Require(baseline.active == 0 && baseline.thread == 0 && !baseline.queued && rejudge_workers.load() == 1,
            "rejudge_baseline_job_cleaned");
    if (repeat) {
      SendRejudgeProbe(run, 21, "repeat");
      Require(run.Wait(21, 15'000) && RejudgeReply(run, 21, true, 3) &&
                  rejudge_file_reads.load() == 4 && rejudge_file_successes.load() == 4 &&
                  WaitRejudgeRetired(4), "rejudge_repeated_measurement_not_cached");
      std::uint8_t request = 30;
      for (const char *mode : {"mode_mismatch", "app_mismatch", "start_mismatch", "file_mismatch", "read_failure"}) {
        SendRejudgeProbe(run, request, mode);
        Require(run.Wait(request, 15'000) && RejudgeReply(run, request, false), "rejudge_real_negative_refused");
        ++request;
      }
      Require(rejudge_file_reads.load() == 6 && rejudge_file_successes.load() == 5 && WaitRejudgeRetired(9),
              "rejudge_real_file_mismatch_and_read_failure");
      SendRejudgeProbe(run, 40);
      Require(run.Wait(40, 15'000) && RejudgeReply(run, 40, true, 1) && WaitRejudgeRetired(10),
              "rejudge_negative_not_cached");
    } else {
      if (cold) {
        std::lock_guard lock(WindowsTargetListControl().stop_mutex);
        WindowsV2FactsContextCache().reset();
        rejudge_hold_context.store(true);
      } else if (queued) hold_point.store(HoldPoint::kConsumer);
      else rejudge_hold_call.store(2);
      SendRejudgeProbe(run, 2);
      Require(WaitForSingleObject(run.entered.value, 15'000) == WAIT_OBJECT_0 &&
                  WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT,
              "rejudge_actual_worker_or_prequeued_gate_entered");
      const auto active = RejudgeState();
      if (queued) {
        Require(active.active == 0 && active.next == baseline.next && !active.queued &&
                    rejudge_file_reads.load() == 1 && !WindowsTargetListWorkerRunning().load(),
                "rejudge_prequeued_has_no_new_job");
      } else {
        old_job = active.active;
        Require(old_job != 0 && !active.queued && active.thread == rejudge_thread_id.load() &&
                    WindowsTargetListWorkerRunning().load() && rejudge_file_successes.load() == 1 &&
                    rejudge_file_reads.load() == (cold ? 1u : 2u), "rejudge_real_worker_held");
      }
      if (cancel) {
        const std::uint64_t serial = WindowsTargetListControl().stop_serial.load();
        const ULONGLONG sent = GetTickCount64();
        run.Send(MessageType::kCancel, 3, "{\"cancelEpoch\":2}");
        Require(WaitStopSerial(serial, 1000) && run.Wait(2, 1000) && RejudgeReply(run, 2, false) &&
                    run.Wait(3, 1000) && run.Receipt(3, MessageType::kDispatchResult, "canceled", 2),
                "rejudge_cancel_alone_before_close");
        stop_ms = GetTickCount64() - sent;
        Require(stop_ms < 1000 && WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT &&
                    rejudge_file_successes.load() == 1, "rejudge_cancel_receipt_before_real_read_release");
        SendRejudgeProbe(run, 6);
        Require(run.Wait(6, 1000) && RejudgeReply(run, 6, false), "rejudge_fresh_busy_refused");
        const auto busy = RejudgeState();
        Require(busy.active == old_job && busy.next == active.next && busy.thread == active.thread &&
                    !busy.queued && rejudge_workers.load() == 1 && rejudge_file_reads.load() == 2,
                "rejudge_busy_adds_no_job");
      }
      const auto serial = WindowsTargetListControl().stop_serial.load();
      const ULONGLONG sent = GetTickCount64();
      run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":" +
          std::to_string(cancel ? 3 : 2) + "}");
      Require(WaitStopSerial(serial, 1000), "rejudge_close_reader_progress");
      if (queued) {
        Require(cancellation_epoch.load() == 1, "rejudge_prequeued_close_uses_serial");
        hold_point.store(HoldPoint::kNone);
        SetEvent(run.release.value);
      }
      Require(run.Wait(2, 1000) && RejudgeReply(run, 2, false) && run.Wait(4, 1000) &&
                  run.Receipt(4, MessageType::kProbeResult, "closed", cancel ? 3 : 2), "rejudge_close_receipt");
      close_ms = GetTickCount64() - sent;
      Require(close_ms < 1000 && sessions.empty() && ticket_states.empty(), "rejudge_control_closed_before_release");
      if (!queued) {
        Require(WindowsTargetListWorkerRunning().load() && WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT &&
                    rejudge_file_successes.load() == 1, "rejudge_worker_remains_held_after_close");
        // Response already rejected: its local Session copy is gone. The worker must own its file.
        ReleaseWindowsSessionResources(&snapshot);
        Require(snapshot.executable_file == INVALID_HANDLE_VALUE && snapshot.process_handle == nullptr,
                "rejudge_original_snapshot_handles_closed");
        if (cold) Require(!WindowsV2FactsContextCache().has_value(), "rejudge_canceled_context_not_adopted");
        rejudge_hold_call.store(0);
        rejudge_hold_context.store(false);
        SetEvent(run.release.value);
        Require(WaitRejudgeRetired(2) && run.WaitWorkerIdle(1000), "rejudge_late_worker_cleanup");
        const auto pending = RejudgePending();
        Require(pending != nullptr && pending->job_id == old_job, "rejudge_old_pending_identified");
        {
          std::unique_lock lock(pending->mutex);
          Require(pending->ready.wait_for(lock, std::chrono::seconds(1), [&] { return pending->done; }) &&
                      pending->abandoned.load() && !pending->result.matches && !pending->result.context.has_value(),
                  "rejudge_late_result_publication_discards_abandoned_job");
        }
        if (cold) {
          Require(!WindowsV2FactsContextCache().has_value() && rejudge_context_calls.load() == 1 &&
                      rejudge_file_reads.load() == 1, "rejudge_late_context_not_adopted");
        } else {
          Require(rejudge_file_reads.load() == 2 && rejudge_file_successes.load() == 2,
                  "rejudge_duplicate_read_succeeds_after_source_close_without_adoption");
        }
        SeedOwnedValidationIdentity(&snapshot);
      } else Require(WaitRejudgeRetired(1) && RejudgeState().next == baseline.next, "rejudge_prequeued_starts_no_job");
      if (cancel) {
        ResetEvent(run.entered.value);
        ResetEvent(run.release.value);
        rejudge_hold_call.store(3);
        SendRejudgeProbe(run, 21);
        Require(WaitForSingleObject(run.entered.value, 15'000) == WAIT_OBJECT_0, "rejudge_fresh_job_held");
        const auto fresh = RejudgeState();
        next_job = fresh.active;
        const unsigned attempts = rejudge_cancel_attempts.load();
        Require(next_job != 0 && next_job != old_job && fresh.thread == active.thread &&
                    attempts > 0 && rejudge_last_cancel_id.load() == old_job, "rejudge_reused_physical_worker");
        CancelWindowsV2RejudgeJob(old_job);
        const auto unchanged = RejudgeState();
        Require(rejudge_cancel_attempts.load() == attempts && unchanged.active == next_job &&
                    unchanged.thread == fresh.thread && WindowsTargetListWorkerRunning().load() &&
                    WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT, "rejudge_old_id_cannot_cancel_new_job");
        rejudge_hold_call.store(0);
        SetEvent(run.release.value);
        Require(run.Wait(21, 15'000) && RejudgeReply(run, 21, true, 1) && WaitRejudgeRetired(3),
                "rejudge_explicit_fresh_component_retry");
      } else {
        SendRejudgeProbe(run, 21);
        Require(run.Wait(21, 15'000) && RejudgeReply(run, 21, true, 1) && WaitRejudgeRetired(queued ? 2 : 3),
                "rejudge_explicit_fresh_component_retry");
        if (cold) Require(WindowsV2FactsContextCache().has_value() && rejudge_context_calls.load() == 2,
                          "rejudge_only_fresh_retry_adopts_context");
      }
    }
    if (repeat) {
      run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":2}");
      Require(run.Wait(4, 1000) && run.Receipt(4, MessageType::kProbeResult, "closed", 2), "rejudge_repeat_control_close");
    }
    run.Send(MessageType::kProbe, 5, "{\"operation\":\"close_session\",\"cancelEpoch\":4}", 9);
    Require(run.Wait(5, 1000) && run.Error(5, "native_close_unconfirmed", 9), "rejudge_unknown_close_not_success");
    Require(snapshot.input_api_attempts->load() == 0 && snapshot.maximum_mode == listed.mode &&
                !snapshot.v2_input_not_web.has_value() && start_worker_attempts.load() == 0 && start_focus_calls.load() == 0 &&
                synchronous_session_probes.load() == 0 && ticket_states.empty() && sessions.empty() &&
                rejudge_workers.load() == 1 && RejudgeState().active == 0 && RejudgeState().thread == 0 &&
                !wrong_measurement.load() && !gate_timed_out.load(), "rejudge_component_never_admits_or_inputs");
    run.Cleanup();
    Require(run.child_exited && run.worker_idle && !run.watchdog_fired.load() &&
                snapshot.process_handle == nullptr && snapshot.executable_file == INVALID_HANDLE_VALUE,
            "rejudge_owned_cleanup");
    std::cout << "{\"case\":\"" << label << "\",\"componentIntegrationOnly\":true,\"realListMode\":\"observe_only\""
              << ",\"realBaselineJudgement\":true,\"stopMs\":" << stop_ms << ",\"closeMs\":" << close_ms
              << ",\"fileReads\":" << rejudge_file_reads.load() << ",\"fileReadSuccesses\":" << rejudge_file_successes.load()
              << ",\"retiredJobs\":" << rejudge_retired_jobs.load() << ",\"workerThreads\":" << rejudge_workers.load()
              << ",\"contextCalls\":" << rejudge_context_calls.load() << ",\"cancelAttempts\":" << rejudge_cancel_attempts.load()
              << ",\"oldJobId\":" << old_job << ",\"nextJobId\":" << next_job
              << ",\"lateResultAppliedToSession\":false,\"unknownCloseRejected\":true,\"inputAttempts\":0"
              << ",\"foregroundRequired\":false,\"healthyStartVerified\":false,\"controlSeedIsDiagnostic\":true"
              << ",\"freshRetryIsComponentOnly\":true,\"workerJoined\":false,\"joinedThreads\":\"pipe-reader-watchdog\""
              << ",\"childExited\":true,\"threadsJoined\":true,\"workerIdle\":true,\"watchdogFired\":false}\n";
    return 0;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"case\":\"" << label << "\",\"failure\":\"" << error.what() << "\"}\n";
    return 1;
  }
}

std::string ResumeMetadata(const ListedStart &listed, std::uint64_t epoch, bool explicit_resume = true,
                           bool omit_generation = false, bool stale_generation = false) {
  std::string metadata = listed.Metadata(epoch);
  const auto begin = metadata.find(",\"targetGeneration\":");
  const auto end = metadata.find(',', begin + 1);
  Require(begin != std::string::npos && end != std::string::npos, "resume_generation_field");
  if (omit_generation) metadata.erase(begin, end - begin);
  else if (stale_generation) metadata.replace(begin, end - begin, ",\"targetGeneration\":0");
  metadata.pop_back();
  if (explicit_resume) metadata += ",\"resume\":true";
  metadata += '}';
  return metadata;
}
void SeedResumeSession(const ListedStart &listed, const std::string &created) {
  const auto inserted = sessions.try_emplace(FrameIdKey(Id(7)));
  Require(inserted.second, "resume_single_diagnostic_session");
  auto &session = inserted.first->second;
  SeedOwnedValidationIdentity(&session);
  session.session_id = "sc940-new";
  // This is an explicit fresh diagnostic binding, never a successful public restart or grant.
  session.cancel_epoch = cancellation_epoch.load();
  session.maximum_mode = listed.mode;
  Require(session.pid == listed.pid && session.app_identity == listed.app &&
              session.window_identity == listed.window_identity && session.process_start == created &&
              session.executable_digest == listed.executable && session.signer_digest.empty() &&
              session.maximum_mode == "observe_only" && !session.not_web_file.has_value() &&
              !session.has_observation && ticket_states.empty(), "resume_seed_is_real_row_and_handles");
  resume_source_process.store(session.process_handle);
  resume_source_file.store(session.executable_file);
}
void SendResumeComponent(RcaRun &run, const ListedStart &listed, std::uint8_t request,
                         std::string_view mode = "normal") {
  run.Send(MessageType::kProbe, request, "{\"operation\":\"sc940_resume_component\",\"mode\":\"" +
      std::string(mode) + "\",\"denyRulesetVersion\":" + std::to_string(listed.ruleset) + "}");
}
bool ResumeComponentReply(RcaRun &run, unsigned request, bool before, bool after, unsigned completed) {
  std::string body;
  bool component = false, actual_before = false, actual_after = false;
  std::uint64_t actual_completed = 0;
  return run.ProbeBody(request, &body) && body.size() < 512 &&
      ReadOptionalJsonBoolean(body, "componentOnly", &component) && component &&
      ReadOptionalJsonBoolean(body, "beforeOk", &actual_before) && actual_before == before &&
      ReadOptionalJsonBoolean(body, "afterOk", &actual_after) && actual_after == after &&
      ReadJsonUint64(body, "completed", &actual_completed) && actual_completed == completed;
}
bool ResumeSucceeded(RcaRun &run, unsigned request, const ListedStart &listed) {
  std::string body, id, app, mode;
  std::uint64_t epoch = 0, attempts = 1;
  return run.ProbeBody(request, &body) && ReadJsonString(body, "sessionId", &id) && id == "sc940-new" &&
      ReadJsonString(body, "appIdentityDigest", &app) && app == listed.app &&
      ReadJsonString(body, "maximumMode", &mode) && mode == listed.mode &&
      ReadJsonUint64(body, "cancelEpoch", &epoch) && epoch == cancellation_epoch.load() &&
      ReadJsonUint64(body, "inputAttemptCount", &attempts) && attempts == 0 &&
      !WindowsTargetListWorkerRunning().load();
}

// All sessions here are diagnostic bindings from actual owned rows/handles. Only resume-live-*
// traverses the real foreground/resolver path; neither family establishes public Start or grants.
int DiagnoseResume(std::wstring_view scenario, DWORD pid, HWND window, const std::string &created,
                   const std::wstring &fixture_path, bool focus_control_ready) {
  const bool live = scenario.starts_with(L"resume-live-");
  const bool normal = scenario == L"resume-live-normal";
  const bool focus_stop = scenario == L"resume-live-focus-stop";
  const bool component_after = scenario.starts_with(L"resume-after-component-");
  const bool after = component_after || scenario.starts_with(L"resume-live-after-");
  const bool cancel = scenario.ends_with(L"-cancel") || focus_stop;
  const bool queued = scenario == L"resume-prequeued-close";
  const bool cold = scenario == L"resume-cold-context-close";
  const bool repeat = scenario == L"resume-components";
  const std::string label(scenario.begin(), scenario.end());
  RcaRun run;
  ULONGLONG stop_ms = 0, close_ms = 0;
  unsigned expected_input_attempts = focus_stop ? 1 : 0;
  bool late_rejected = false;
  try {
    run.AttachOwnedSibling(pid, window, created, fixture_path);
    if (live) Require(focus_stop ? (focus_control_ready && !IsIconic(window) && GetForegroundWindow() != window)
                                : GetForegroundWindow() == window, "resume_environment_foreground_required");
    run.StartPipe(false, false);
    run.Send(MessageType::kHandshake, 1, "{\"protocolVersion\":1,\"apiVersion\":3}");
    Require(run.Wait(1, 5000) && run.ProbeReply(1, MessageType::kHandshakeResult), "resume_handshake");
    const ListedStart listed = ReadListedStart(run, 10);
    Require(WindowsV2FactsContextCache().has_value() &&
                WindowsV2FactsContextCache()->lineage_root_pid == GetCurrentProcessId(), "resume_real_context_ready");
    SeedResumeSession(listed, created);
    resume_diagnostic_active.store(true);
    resume_no_focus.store(!live);
    LockedWindowsExecutable other;
    Require(OpenLockedProcessExecutable(GetCurrentProcess(), &other) &&
                !SameWindowsFileIdentity(other.identity.file_identity,
                    {sessions.at(FrameIdKey(Id(7))).executable_volume_serial,
                     sessions.at(FrameIdKey(Id(7))).executable_file_id}), "resume_real_other_image");
    run.resume_comparison_file.value = other.file;
    other.file = INVALID_HANDLE_VALUE;
    resume_other_file = run.resume_comparison_file.value;
    run.Send(MessageType::kProbe, 20, "{\"operation\":\"sc940_resume_baseline\",\"denyRulesetVersion\":" +
        std::to_string(listed.ruleset) + "}");
    std::string baseline;
    bool component = false, identity = false, admission = false;
    Require(run.Wait(20, 15'000) && run.ProbeBody(20, &baseline) &&
                ReadOptionalJsonBoolean(baseline, "componentOnly", &component) && component &&
                ReadOptionalJsonBoolean(baseline, "identityMatches", &identity) && identity &&
                ReadOptionalJsonBoolean(baseline, "admissionMatches", &admission) && admission,
            "resume_real_identity_admission_baseline");
    if (normal) {
      run.Send(MessageType::kProbe, 21, ResumeMetadata(listed, 1, true, true));
      Require(run.Wait(21, 15'000) && ResumeSucceeded(run, 21, listed) && WaitAllResumeThreads() &&
                  resume_before_jobs.load() == 1 && resume_after_jobs.load() == 1 && resume_after_reads.load() == 1,
              "resume_live_success_without_generation");
      run.Send(MessageType::kProbe, 22, ResumeMetadata(listed, 1, false, false, true));
      Require(run.Wait(22, 15'000) && ResumeSucceeded(run, 22, listed) && WaitAllResumeThreads() &&
                  resume_before_jobs.load() == 2 && resume_after_jobs.load() == 2 && resume_after_reads.load() == 2 &&
                  resume_ticket_invalidations.load() == 4, "refocus_live_success_with_stale_generation");
      std::string mismatch = ResumeMetadata(listed, 1);
      const auto id = mismatch.find("\"sessionId\":\"sc940-new\"");
      Require(id != std::string::npos, "resume_binding_negative_field");
      mismatch.replace(id, std::string("\"sessionId\":\"sc940-new\"").size(), "\"sessionId\":\"different\"");
      run.Send(MessageType::kProbe, 23, mismatch);
      // The header/metadata ID pair is immutable in API 3. A different owner is rejected
      // before the existing session's tickets or measurement state can be touched.
      Require(run.Wait(23, 15'000) && run.Error(23, "session_id_reuse") && WaitAllResumeThreads() &&
                  resume_ticket_invalidations.load() == 4 && resume_after_jobs.load() == 2,
              "resume_sid_alias_refused_without_ticket_mutation");
      mismatch = ResumeMetadata(listed, 1);
      const auto digest = mismatch.find(listed.app);
      Require(digest != std::string::npos, "resume_app_negative_field");
      mismatch.replace(digest, listed.app.size(), std::string(64, '0'));
      run.Send(MessageType::kProbe, 24, mismatch);
      Require(run.Wait(24, 15'000) && run.Error(24, "session_target_rejected") && WaitAllResumeThreads() &&
                  resume_ticket_invalidations.load() == 5 && resume_after_jobs.load() == 2,
              "resume_refused_attempt_also_invalidates_ticket");
    } else if (repeat) {
      SendResumeComponent(run, listed, 21, "repeat");
      Require(run.Wait(21, 15'000) && ResumeComponentReply(run, 21, true, true, 3) && WaitAllResumeThreads() &&
                  resume_before_jobs.load() == 3 && resume_before_calls.load() == 3 &&
                  resume_before_file_reads.load() == 3 && resume_after_jobs.load() == 3 &&
                  resume_after_reads.load() == 3 && resume_after_successes.load() == 3 &&
                  resume_pin_checks.load() == 3, "resume_both_phases_remeasure_with_continuous_source_pin");
      std::uint8_t request = 30;
      for (const char *mode : {"before_app", "before_window", "before_ruleset", "after_digest", "after_signer",
                               "after_language", "after_file", "after_read_failure"}) {
        const bool before_failure = std::string_view(mode).starts_with("before_");
        const unsigned reads = resume_after_reads.load();
        const unsigned successes = resume_after_successes.load();
        SendResumeComponent(run, listed, request, mode);
        Require(run.Wait(request, 15'000) && ResumeComponentReply(run, request, !before_failure, false, 0) &&
                    WaitAllResumeThreads(), "resume_binding_or_real_read_failure_refused");
        Require(resume_after_reads.load() == reads + (before_failure ? 0u : 1u) &&
                    resume_after_successes.load() == successes + (before_failure || std::string_view(mode) == "after_read_failure" ? 0u : 1u),
                "resume_negative_keeps_actual_second_phase_read");
        ++request;
      }
      SendResumeComponent(run, listed, 40);
      Require(run.Wait(40, 15'000) && ResumeComponentReply(run, 40, true, true, 1) && WaitAllResumeThreads(),
              "resume_negative_result_not_cached");
      // Ticket lifecycle unit fixture only: no preflight, dispatch, grant, or input is performed.
      // Keep the exact same binding and clock for the post-rejection Consume, so neither epoch nor
      // expiry can explain why the old ticket becomes unusable.
      const std::string key = FrameIdKey(Id(7));
      const auto epoch = cancellation_epoch.load();
      const unsigned workers = resume_workers.load();
      auto &owner = sessions.at(key);
      const auto binding = WindowsTicketBinding(owner, "resume-ticket-unit", std::string(64, 'a'),
                                                std::string(64, 'b'), epoch, 1);
      const std::string token(64, 'c');
      constexpr std::uint64_t now = 100;
      sprint_coder::computer_use::NativeOrdinaryTicketSlot positive;
      Require(positive.Issue(token, binding, now, sprint_coder::computer_use::kNativeOrdinaryTicketTtlNs) &&
                  positive.Consume(token, binding, now), "resume_ticket_unit_positive_control");
      auto &ticket = ticket_states[key];
      ticket.generation = 1;
      Require(ticket.slot.Issue(token, binding, now, sprint_coder::computer_use::kNativeOrdinaryTicketTtlNs) &&
                  ticket.slot.occupied(), "resume_ticket_unit_seeded");
      run.Send(MessageType::kProbe, 41, ResumeMetadata(listed, epoch + 1));
      Require(run.Wait(41, 1000) && run.Error(41, "session_start_canceled") &&
                  cancellation_epoch.load() == epoch && owner.cancel_epoch == epoch &&
                  resume_workers.load() == workers && !ticket.slot.occupied() && ticket.generation == 2 &&
                  !ticket.slot.Consume(token, binding, now), "resume_future_epoch_refusal_burns_old_ticket");
      ForgetWindowsTicket(key);
    } else {
      if (cold) {
        std::lock_guard lock(WindowsTargetListControl().stop_mutex);
        WindowsV2FactsContextCache().reset();
        resume_hold_context.store(true);
      } else if (queued) hold_point.store(HoldPoint::kConsumer);
      else if (after) resume_hold_after.store(true);
      else if (focus_stop) resume_hold_focus_unit.store(true);
      else resume_hold_before.store(true);
      if (component_after) SendResumeComponent(run, listed, 2);
      else run.Send(MessageType::kProbe, 2, ResumeMetadata(listed, 1));
      Require(WaitForSingleObject(run.entered.value, 15'000) == WAIT_OBJECT_0 &&
                  WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT, "resume_fault_gate_entered");
      const auto pending = ResumeHeldPending();
      const auto attempts = sessions.at(FrameIdKey(Id(7))).input_api_attempts;
      const unsigned workers = resume_workers.load();
      if (queued) Require(workers == 0 && !WindowsTargetListWorkerRunning().load(), "resume_prequeued_no_job");
      else if (focus_stop) Require(workers == 1 && resume_focus_attempts.load() == 1 && attempts->load() == 1,
                                  "resume_first_real_focus_unit_complete");
      else Require(pending != nullptr && WindowsTargetListWorkerRunning().load() &&
                       workers == (after ? 2u : 1u), "resume_actual_phase_worker_held");
      const auto response_refused = [&] {
        return component_after ? ResumeComponentReply(run, 2, true, false, 0) : run.Error(2, "session_start_canceled");
      };
      if (cancel) {
        const auto serial = WindowsTargetListControl().stop_serial.load();
        const ULONGLONG sent = GetTickCount64();
        run.Send(MessageType::kCancel, 3, "{\"cancelEpoch\":2}");
        Require(WaitStopSerial(serial, 1000), "resume_cancel_reader_progress");
        if (focus_stop) { resume_hold_focus_unit.store(false); SetEvent(run.release.value); }
        Require(run.Wait(2, 1000) && response_refused() && run.Wait(3, 1000) &&
                    run.Receipt(3, MessageType::kDispatchResult, "canceled", 2, 7, "sc940-new", expected_input_attempts),
                "resume_cancel_alone_drains_before_close");
        stop_ms = GetTickCount64() - sent;
        Require(stop_ms < 1000, "resume_cancel_receipt_budget");
        if (!after && !focus_stop) {
          SendResumeComponent(run, listed, 6);
          Require(run.Wait(6, 1000) && ResumeComponentReply(run, 6, false, false, 0) &&
                      resume_workers.load() == workers && WindowsTargetListWorkerRunning().load(), "resume_busy_starts_no_extra_job");
        }
      }
      const auto serial = WindowsTargetListControl().stop_serial.load();
      const ULONGLONG sent = GetTickCount64();
      run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":" + std::to_string(cancel ? 3 : 2) + "}");
      Require(WaitStopSerial(serial, 1000), "resume_close_reader_progress");
      if (queued) {
        Require(cancellation_epoch.load() == 1 && resume_workers.load() == 0, "resume_prequeued_close_uses_enqueue_serial");
        hold_point.store(HoldPoint::kNone);
        SetEvent(run.release.value);
      }
      Require(run.Wait(2, 1000) && response_refused() && run.Wait(4, 1000) &&
                  run.Receipt(4, MessageType::kProbeResult, "closed", cancel ? 3 : 2, 7, "sc940-new", expected_input_attempts),
              "resume_close_receipt");
      close_ms = GetTickCount64() - sent;
      Require(close_ms < 1000 && sessions.empty() && ticket_states.empty() && attempts->load() == expected_input_attempts,
              "resume_original_session_closed");
      if (!queued && !focus_stop) {
        Require(WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT && WindowsTargetListWorkerRunning().load(),
                "resume_receipts_precede_worker_release");
        const unsigned reads = resume_after_successes.load();
        if (cold) Require(!WindowsV2FactsContextCache().has_value(), "resume_cold_context_not_adopted");
        resume_hold_before.store(false); resume_hold_after.store(false); resume_hold_context.store(false);
        SetEvent(run.release.value);
        Require(WaitResumeThread(pending) && WaitAllResumeThreads() && run.WaitWorkerIdle(1000), "resume_worker_actually_exited_after_close");
        {
          std::lock_guard lock(pending->mutex);
          Require(pending->done && pending->abandoned.load() && pending->thread.value == nullptr &&
                      !pending->result.succeeded && !pending->result.context.has_value(), "resume_late_result_discarded");
        }
        if (after) Require(resume_after_successes.load() == reads + 1, "resume_dup_real_read_after_original_close");
        else Require(resume_before_successes.load() == 1, "resume_real_open_completed_after_close");
        if (cold) Require(!WindowsV2FactsContextCache().has_value() && resume_context_calls.load() == 1,
                          "resume_late_cold_context_discarded");
        late_rejected = true;
      } else Require(WaitAllResumeThreads() && (!focus_stop || resume_after_jobs.load() == 0), "resume_consumer_gate_cleanup");
      if (!live) {
        SeedResumeSession(listed, created);
        if (cancel && !after) {
          ResetEvent(run.entered.value); ResetEvent(run.release.value);
          resume_hold_before.store(true);
          SendResumeComponent(run, listed, 21);
          Require(WaitForSingleObject(run.entered.value, 15'000) == WAIT_OBJECT_0, "resume_retry_worker_held");
          const auto next = ResumeHeldPending();
          const unsigned cancels = resume_cancel_attempts.load();
          Require(next != nullptr && next != pending && WaitResumeThread(pending, 0), "resume_old_thread_really_finished");
          CancelWindowsExistingStartJob(pending);
          Require(resume_cancel_attempts.load() == cancels && WindowsTargetListWorkerRunning().load() &&
                      WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT, "resume_old_pending_cannot_cancel_new_job");
          resume_hold_before.store(false); SetEvent(run.release.value);
        } else SendResumeComponent(run, listed, 21);
        Require(run.Wait(21, 15'000) && ResumeComponentReply(run, 21, true, true, 1) && WaitAllResumeThreads(),
                "resume_explicit_fresh_component_retry");
        if (cold) Require(WindowsV2FactsContextCache().has_value() && resume_context_calls.load() == 2,
                          "resume_only_fresh_retry_adopts_context");
      }
      Require(run.ReplyCount(2) == 1, "resume_late_phase_never_replies_success");
    }
    if (sessions.contains(FrameIdKey(Id(7)))) {
      const auto epoch = cancellation_epoch.load() + 1;
      run.Send(MessageType::kProbe, 50, "{\"operation\":\"close_session\",\"cancelEpoch\":" + std::to_string(epoch) + "}");
      Require(run.Wait(50, 1000) && run.Receipt(50, MessageType::kProbeResult, "closed", epoch, 7, "sc940-new"), "resume_final_diagnostic_close");
    }
    Require(WaitAllResumeThreads() && run.WaitWorkerIdle(1000) && sessions.empty() && ticket_states.empty() &&
                resume_before_calls.load() == resume_before_jobs.load() && resume_after_reads.load() == resume_after_jobs.load() &&
                resume_workers.load() == resume_before_jobs.load() + resume_after_jobs.load() &&
                (!live ? resume_resolve_attempts.load() == 0 && resume_focus_attempts.load() == 0 : true) &&
                (!focus_stop || (resume_focus_attempts.load() == 1 && resume_focus_setup_minimized.load())) && !wrong_measurement.load() && !gate_timed_out.load(),
            "resume_phases_threads_and_no_unexpected_input");
    const unsigned workers = resume_workers.load();
    run.Cleanup();
    Require(run.child_exited && run.worker_idle && !run.watchdog_fired.load(), "resume_owned_cleanup");
    std::cout << "{\"case\":\"" << label << "\",\"componentIntegrationOnly\":" << (live ? "false" : "true")
              << ",\"realIdentityAdmissionBaseline\":true,\"realListMode\":\"observe_only\",\"stopMs\":" << stop_ms
              << ",\"closeMs\":" << close_ms << ",\"beforeJobs\":" << resume_before_jobs.load() << ",\"afterJobs\":" << resume_after_jobs.load()
              << ",\"beforeFileReads\":" << resume_before_file_reads.load() << ",\"afterFileReads\":" << resume_after_reads.load()
              << ",\"workerThreads\":" << workers << ",\"workerThreadsExited\":true,\"threadHandlesClosed\":true"
              << ",\"workerThreadsJoined\":false,\"joinedThreads\":\"pipe-reader-watchdog\""
              << ",\"sourcePinChecks\":" << resume_pin_checks.load() << ",\"lateResultRejected\":" << (late_rejected ? "true" : "false")
              << ",\"resolveAttempts\":" << resume_resolve_attempts.load() << ",\"focusApiAttempts\":" << resume_focus_attempts.load()
              << ",\"inputAttempts\":" << expected_input_attempts << ",\"foregroundRequired\":" << (live ? "true" : "false")
              << ",\"healthyResumeRefocusVerified\":" << (normal ? "true" : "false")
              << ",\"focusSetupMinimizedAfterValidation\":" << (resume_focus_setup_minimized.load() ? "true" : "false")
              << ",\"minimizedClientBoundsAvailable\":" << (resume_minimized_client_bounds.load() ? "true" : "false")
              << ",\"publicStartOrGrantVerified\":false,\"ticketLifecycleUnitFixture\":" << (repeat ? "true" : "false")
              << ",\"preflightOrDispatchVerified\":false,\"seedIsDiagnostic\":true,\"childExited\":true"
              << ",\"threadsJoined\":true,\"workerIdle\":true,\"watchdogFired\":false}\n";
    return 0;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"case\":\"" << label << "\",\"failure\":\"" << error.what()
              << "\",\"resolveAttempts\":" << resume_resolve_attempts.load()
              << ",\"focusApiAttempts\":" << resume_focus_attempts.load() << "}\n";
    return 1;
  }
}

// The GUI target and real pipe client are siblings. W8 therefore measures their true relationship,
// rather than accepting a forged lineage root or a special acceptance-mode/signature exemption.
int CoordinateStart(std::wstring_view scenario, const std::wstring &fixture_path) {
  RcaRun run;
  try {
    Require(ConfigurePerMonitorDpiAwareness(), "start_coordinator_dpi");
    ScopedKernelHandle child_token;
    if (IsProcessElevated(GetCurrentProcessId())) {
      ScopedKernelHandle own;
      Require(OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &own.value), "start_own_token");
      BYTE administrators[SECURITY_MAX_SID_SIZE];
      DWORD sid_size = sizeof(administrators);
      SID_AND_ATTRIBUTES deny{};
      Require(CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, administrators, &sid_size), "start_admin_sid");
      deny.Sid = administrators;
      Require(CreateRestrictedToken(own.value, LUA_TOKEN | DISABLE_MAX_PRIVILEGE, 1, &deny, 0, nullptr, 0, nullptr,
                                    &child_token.value), "start_restricted_child_token");
      PSID medium = nullptr;
      Require(ConvertStringSidToSidW(L"S-1-16-8192", &medium), "start_medium_sid");
      TOKEN_MANDATORY_LABEL label{};
      label.Label.Attributes = SE_GROUP_INTEGRITY;
      label.Label.Sid = medium;
      const BOOL lowered = SetTokenInformation(child_token.value, TokenIntegrityLevel, &label,
                                               sizeof(label) + GetLengthSid(medium));
      LocalFree(medium);
      TOKEN_ELEVATION elevation{};
      DWORD bytes = 0;
      Require(lowered && GetTokenInformation(child_token.value, TokenElevation, &elevation, sizeof(elevation), &bytes) &&
                  elevation.TokenIsElevated == 0, "start_target_token_not_elevated");
    }
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = scenario.starts_with(L"rejudge-") ||
        (scenario.starts_with(L"resume-") && !scenario.starts_with(L"resume-live-"))
        ? SW_SHOWNOACTIVATE : SW_SHOWNORMAL;
    PROCESS_INFORMATION fixture{};
    std::wstring command = L"\"" + fixture_path + L"\"";
    const BOOL created = child_token.value != nullptr
        ? CreateProcessAsUserW(child_token.value, nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                               nullptr, nullptr, &startup, &fixture)
        : CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                         nullptr, nullptr, &startup, &fixture);
    Require(created, "start_gui_fixture_created");
    run.children[0].value = fixture.hProcess;
    ScopedKernelHandle fixture_thread(fixture.hThread);
    Require(AssignProcessToJobObject(run.job.value, fixture.hProcess) &&
                ResumeThread(fixture.hThread) != static_cast<DWORD>(-1), "start_gui_fixture_owned");
    Require(WaitForInputIdle(fixture.hProcess, 10'000) == 0, "start_gui_fixture_ready");
    struct WindowSearch { DWORD pid; HWND found = nullptr; } search{fixture.dwProcessId};
    for (unsigned attempt = 0; attempt < 200 && search.found == nullptr; ++attempt) {
      EnumThreadWindows(fixture.dwThreadId, [](HWND window, LPARAM parameter) -> BOOL {
        auto *value = reinterpret_cast<WindowSearch *>(parameter);
        DWORD owner = 0;
        if (IsWindowVisible(window) && GetWindow(window, GW_OWNER) == nullptr &&
            GetWindowThreadProcessId(window, &owner) != 0 && owner == value->pid) { value->found = window; return FALSE; }
        return TRUE;
      }, reinterpret_cast<LPARAM>(&search));
      if (search.found == nullptr) Sleep(10);
    }
    Require(search.found != nullptr && !IsProcessElevated(fixture.dwProcessId), "start_gui_fixture_window");
    bool focus_control_ready = true;
    if (scenario == L"start-ready-close" || scenario == L"resume-live-focus-stop") {
      // A second owned GUI window gives begin_focus real work to refuse; no synthetic key is sent.
      PROCESS_INFORMATION foreground{};
      command = L"\"" + fixture_path + L"\"";
      const BOOL opened = child_token.value != nullptr
          ? CreateProcessAsUserW(child_token.value, nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                                 nullptr, nullptr, &startup, &foreground)
          : CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                           nullptr, nullptr, &startup, &foreground);
      Require(opened, "start_focus_control_created");
      run.children[2].value = foreground.hProcess;
      ScopedKernelHandle foreground_thread(foreground.hThread);
      Require(AssignProcessToJobObject(run.job.value, foreground.hProcess) &&
                  ResumeThread(foreground.hThread) != static_cast<DWORD>(-1) &&
                  WaitForInputIdle(foreground.hProcess, 10'000) == 0, "start_focus_control_owned");
      DWORD foreground_pid = 0;
      focus_control_ready = GetWindowThreadProcessId(GetForegroundWindow(), &foreground_pid) != 0 &&
                            foreground_pid == foreground.dwProcessId;
    }
    std::string started;
    Require(ReadProcessStartIdentity(fixture.hProcess, &started), "start_gui_creation_identity");
    std::vector<wchar_t> executable(32768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
    Require(length > 0 && length < executable.size(), "start_coordinator_image");
    const std::wstring start_wide(started.begin(), started.end());
    command = L"\"" + std::wstring(executable.data(), length) + L"\" start-client " + std::wstring(scenario) + L" " +
        std::to_wstring(fixture.dwProcessId) + L" " + std::to_wstring(reinterpret_cast<UINT_PTR>(search.found)) +
        L" " + start_wide + L" \"" + fixture_path + L"\" " + (focus_control_ready ? L"1" : L"0");
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    ScopedKernelHandle output_read, output_write;
    Require(CreatePipe(&output_read.value, &output_write.value, &security, 4096) &&
                SetHandleInformation(output_read.value, HANDLE_FLAG_INHERIT, 0), "start_client_output_pipe");
    ScopedKernelHandle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                         &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    Require(input.value != INVALID_HANDLE_VALUE, "start_client_stdin");
    startup = {};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = input.value;
    startup.hStdOutput = startup.hStdError = output_write.value;
    PROCESS_INFORMATION client{};
    Require(CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW,
                            nullptr, nullptr, &startup, &client), "start_sibling_client_created");
    run.children[1].value = client.hProcess;
    ScopedKernelHandle client_thread(client.hThread);
    Require(AssignProcessToJobObject(run.job.value, client.hProcess) &&
                ResumeThread(client.hThread) != static_cast<DWORD>(-1), "start_sibling_client_owned");
    CloseHandle(output_write.release());
    Require(WaitForSingleObject(client.hProcess, 45'000) == WAIT_OBJECT_0, "start_sibling_client_finished");
    DWORD code = 1;
    Require(GetExitCodeProcess(client.hProcess, &code), "start_sibling_client_exit");
    std::string output;
    std::array<char, 1024> chunk{};
    DWORD read = 0;
    while (ReadFile(output_read.value, chunk.data(), static_cast<DWORD>(chunk.size()), &read, nullptr) && read > 0) {
      output.append(chunk.data(), read);
      Require(output.size() <= 4096, "start_client_metadata_bound");
    }
    run.Cleanup();
    Require(run.child_exited && !run.watchdog_fired.load() &&
                (output.starts_with("{\"case\":\"start-") || output.starts_with("{\"case\":\"rejudge-") ||
                 output.starts_with("{\"case\":\"resume-") ||
                 output.starts_with("{\"failure\":\"")),
            "start_coordinator_cleanup");
    std::cout << output;
    return code == 0 ? 0 : 1;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"failure\":\"" << error.what() << "\"}\n";
    return 1;
  }
}

struct ValidationStateView {
  std::uint64_t active = 0, next = 0;
  DWORD thread = 0;
  bool queued = false, started = false;
};
ValidationStateView ValidationState() {
  auto &state = WindowsValidationControl();
  std::lock_guard lock(state.mutex);
  return {state.active_job_id, state.next_job_id,
          state.cancellation_thread == nullptr ? 0 : GetThreadId(state.cancellation_thread),
          state.queued != nullptr, state.worker_started};
}
std::shared_ptr<WindowsValidationPending> ValidationPending(bool first) {
  std::lock_guard lock(validation_pending_mutex);
  return first ? validation_first_pending : validation_last_pending;
}
bool WaitValidationDone(const std::shared_ptr<WindowsValidationPending> &pending, DWORD milliseconds) {
  if (pending == nullptr) return false;
  const ULONGLONG deadline = GetTickCount64() + milliseconds;
  do {
    {
      std::lock_guard lock(pending->mutex);
      if (pending->done) return true;
    }
    Sleep(1);
  } while (GetTickCount64() < deadline);
  return false;
}
ValidationProbeResult RunValidationProbe(RcaRun &run, std::uint8_t request, std::string_view mode) {
  run.Send(MessageType::kProbe, request,
      "{\"operation\":\"sc940_validation_probe\",\"mode\":\"" + std::string(mode) + "\"}");
  ValidationProbeResult result;
  Require(run.Wait(request, 5000) && run.ValidationReply(request, &result), "validation_probe_reply");
  return result;
}

int DiagnoseValidation(std::wstring_view scenario) {
  const bool cancel = scenario == L"validation-cancel";
  const bool queued = scenario == L"validation-prequeued-close";
  const bool repeat = scenario == L"validation-repeat";
  const char *label = cancel ? "validation-cancel" : queued ? "validation-prequeued-close" :
      repeat ? "validation-repeat" : "validation-close";
  RcaRun run;
  ULONGLONG stop_ms = 0, close_ms = 0;
  double repeat_ms = 0;
  unsigned repeat_calls = 0;
  std::uint64_t first_job = 0, next_job = 0;
  try {
    validation_case_active.store(true);
    run.StartFixture(true);
    run.PrepareValidationProbe();
    run.StartPipe(false, !repeat, !repeat);
    run.Send(MessageType::kHandshake, 1, "{\"protocolVersion\":1,\"apiVersion\":3}");
    Require(run.Wait(1, 5000) && run.ProbeReply(1, MessageType::kHandshakeResult), "validation_handshake");
    if (repeat) {
      const ValidationProbeResult result = RunValidationProbe(run, 2, "repeat");
      Require(result.available && result.matches && result.calls == 16 && result.successes == 16 &&
                  validation_file_reads.load() == 16 && validation_file_successes.load() == 16 &&
                  validation_retired_jobs.load() == 16, "validation_every_call_reads_identity");
      repeat_ms = result.elapsed_ms;
      repeat_calls = 16;
      std::uint8_t request = 10;
      for (const char *mode : {"start_mismatch", "path_mismatch", "file_mismatch", "read_failure"}) {
        const ValidationProbeResult refused = RunValidationProbe(run, request++, mode);
        Require(refused.available && !refused.matches && refused.successes == 0,
                "validation_bad_identity_or_real_read_failure_refused");
      }
      Require(validation_file_reads.load() == 18 && validation_file_successes.load() == 17 &&
                  validation_retired_jobs.load() == 20, "validation_failure_calls_are_real");
      const ValidationProbeResult fresh = RunValidationProbe(run, 20, "normal");
      Require(fresh.available && fresh.matches && validation_file_reads.load() == 19 &&
                  validation_file_successes.load() == 18, "validation_failure_not_cached");
    } else {
      validation_gate_read.store(1);
      hold_point.store(queued ? HoldPoint::kConsumer : HoldPoint::kNone);
      // The be6 path: a real preflight reaches actual Validate with owned process/exe handles.
      const std::string preflight = "{\"requestId\":\"held-file-rca\",\"actionDigest\":\"" + std::string(64, 'a') +
          "\",\"cancelEpoch\":1,\"observationRevision\":1,\"type\":\"invoke\",\"targetId\":\"fixture\"}";
      run.Send(MessageType::kPreflight, 2, preflight);
      Require(WaitForSingleObject(run.entered.value, 10'000) == WAIT_OBJECT_0 &&
                  WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT, "validation_fault_gate_entered");
      const ValidationStateView before = ValidationState();
      if (queued) {
        Require(!before.started && before.active == 0 && !before.queued && validation_file_reads.load() == 0 &&
                    !WindowsTargetListWorkerRunning().load(), "validation_queued_frame_has_no_worker");
      } else {
        const auto pending = ValidationPending(true);
        Require(pending != nullptr, "validation_first_job_recorded");
        first_job = pending->job_id;
        Require(before.started && before.active == first_job && !before.queued &&
                    before.thread == validation_thread_id.load() && validation_workers.load() == 1 &&
                    validation_file_reads.load() == 1 && validation_file_successes.load() == 0 &&
                    WindowsTargetListWorkerRunning().load(), "validation_owned_duplicate_held");
      }
      if (cancel) {
        const std::uint64_t serial = WindowsTargetListControl().stop_serial.load();
        const ULONGLONG sent = GetTickCount64();
        run.Send(MessageType::kCancel, 3, "{\"cancelEpoch\":2}");
        Require(WaitStopSerial(serial, 1000) && run.Wait(2, 1000) && run.PreflightDenied(2) &&
                    run.Wait(3, 1000) && run.Receipt(3, MessageType::kDispatchResult, "canceled", 2),
                "validation_cancel_alone_drains_before_close");
        stop_ms = GetTickCount64() - sent;
        Require(stop_ms < 1000 && validation_file_successes.load() == 0 &&
                    WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT,
                "validation_cancel_ack_while_real_read_held");
        const ValidationProbeResult busy = RunValidationProbe(run, 6, "normal");
        const ValidationStateView after = ValidationState();
        Require(!busy.available && !busy.matches && after.active == first_job && after.next == before.next &&
                    !after.queued && after.thread == before.thread && validation_file_reads.load() == 1 &&
                    validation_workers.load() == 1, "validation_fresh_busy_request_enqueues_nothing");
      }
      // For Close-only and prequeued Close no Cancel frame has been sent.
      const std::uint64_t serial = WindowsTargetListControl().stop_serial.load();
      const ULONGLONG close_sent = GetTickCount64();
      run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":" +
          std::to_string(cancel ? 3 : 2) + "}");
      Require(WaitStopSerial(serial, 1000), "validation_close_reader_progress");
      if (queued) {
        Require(cancellation_epoch.load() == 1 && validation_workers.load() == 0, "validation_close_prequeued_serial_only");
        hold_point.store(HoldPoint::kNone);
        SetEvent(run.release.value);
      }
      Require(run.Wait(2, 1000) && run.PreflightDenied(2) && run.Wait(4, 1000) &&
                  run.Receipt(4, MessageType::kProbeResult, "closed", cancel ? 3 : 2), "validation_close_drains");
      close_ms = GetTickCount64() - close_sent;
      Require(close_ms < 1000 && !sessions.contains(FrameIdKey(Id(7))) &&
                  !ticket_states.contains(FrameIdKey(Id(7))), "validation_original_session_closed_without_ticket");
      if (!queued) {
        Require(validation_file_successes.load() == 0 && WindowsTargetListWorkerRunning().load() &&
                    WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT,
                "validation_close_precedes_duplicate_read_release");
        validation_gate_read.store(0);
        SetEvent(run.release.value);
        const auto pending = ValidationPending(true);
        Require(run.WaitWorkerIdle(15'000) && WaitValidationDone(pending, 1000), "validation_old_job_drained");
        {
          std::lock_guard lock(pending->mutex);
          Require(pending->abandoned.load() && !pending->result.identity_matches,
                  "validation_late_result_not_adopted");
        }
        Require(validation_file_reads.load() == 1 && validation_file_successes.load() == 1 &&
                    validation_retired_jobs.load() == 1 && validation_last_retired_id.load() == first_job &&
                    run.ReplyCount(2) == 1, "validation_real_duplicate_read_after_close");
      } else {
        Require(!ValidationState().started && validation_file_reads.load() == 0 &&
                    validation_workers.load() == 0, "validation_prequeued_close_creates_no_job");
      }
      if (cancel) {
        ResetEvent(run.entered.value);
        ResetEvent(run.release.value);
        validation_gate_read.store(2);
        run.Send(MessageType::kProbe, 20, "{\"operation\":\"sc940_validation_probe\",\"mode\":\"normal\"}");
        Require(WaitForSingleObject(run.entered.value, 5000) == WAIT_OBJECT_0, "validation_next_job_held");
        const auto next = ValidationPending(false);
        Require(next != nullptr && next->job_id != first_job, "validation_next_job_has_new_id");
        next_job = next->job_id;
        const ValidationStateView active = ValidationState();
        const unsigned attempts = validation_cancel_attempts.load();
        Require(active.active == next_job && active.thread == before.thread && !active.queued &&
                    attempts > 0 && validation_last_cancel_id.load() == first_job &&
                    WindowsTargetListWorkerRunning().load(), "validation_same_physical_thread_new_job");
        CancelWindowsValidationJob(first_job);
        const ValidationStateView unchanged = ValidationState();
        Require(validation_cancel_attempts.load() == attempts && unchanged.active == next_job &&
                    unchanged.thread == active.thread && WindowsTargetListWorkerRunning().load() &&
                    WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT,
                "validation_old_id_cannot_cancel_next_job");
        validation_gate_read.store(0);
        SetEvent(run.release.value);
        ValidationProbeResult fresh;
        Require(run.Wait(20, 5000) && run.ValidationReply(20, &fresh) && fresh.available && fresh.matches &&
                    WaitValidationDone(next, 1000) && validation_file_successes.load() == 2,
                "validation_explicit_retry_survives_old_cancel");
        const ValidationProbeResult repeated = RunValidationProbe(run, 21, "repeat");
        Require(repeated.available && repeated.matches && repeated.successes == 16 &&
                    validation_file_reads.load() == 18 && validation_file_successes.load() == 18 &&
                    validation_retired_jobs.load() == 18, "validation_reused_worker_never_caches");
        repeat_ms = repeated.elapsed_ms;
        repeat_calls = 16;
      } else {
        validation_gate_read.store(0);
        const ValidationProbeResult fresh = RunValidationProbe(run, 20, "normal");
        Require(fresh.available && fresh.matches && validation_file_successes.load() == (queued ? 1u : 2u),
                "validation_fresh_read_after_cleanup");
      }
    }
    const ValidationStateView idle = ValidationState();
    Require(run.WaitWorkerIdle(1000) && idle.active == 0 && !idle.queued && idle.thread == 0 && idle.started &&
                validation_workers.load() == 1 && !wrong_measurement.load() && !gate_timed_out.load(),
            "validation_jobs_and_duplicate_cleanup_complete");
    run.Cleanup();
    Require(run.child_exited && run.worker_idle && !run.watchdog_fired.load(), "validation_fixture_cleanup");
    // The reusable native thread is intentionally idle until helper exit. threadsJoined refers
    // only to this harness's pipe/reader/watchdog threads, not that persistent native worker.
    std::cout << "{\"case\":\"" << label << "\",\"stopMs\":" << stop_ms << ",\"closeMs\":" << close_ms
              << ",\"primitiveCostOnly\":true,\"stopPath\":\"" << (repeat ? "none" : "preflight_validate")
              << "\",\"inputLatencyMeasured\":false,\"repeatCalls\":" << repeat_calls
              << ",\"repeatMs\":" << repeat_ms << ",\"fileReads\":" << validation_file_reads.load()
              << ",\"fileReadSuccesses\":" << validation_file_successes.load()
              << ",\"validationWorkerThreads\":" << validation_workers.load()
              << ",\"validationRetiredJobs\":" << validation_retired_jobs.load()
              << ",\"instrumentedPrimitiveTiming\":true"
              << ",\"fixtureLaunchPathCanonicalized\":" << (run.fixture_launch_path_canonicalized ? "true" : "false")
              << ",\"fixtureProcessPathMatchesHeld\":true"
              << ",\"cancelAttempts\":" << validation_cancel_attempts.load() << ",\"firstJobId\":" << first_job
              << ",\"reusedJobId\":" << next_job << ",\"validationJobDrained\":true,\"duplicateCleanupObserved\":true"
              << ",\"validationWorkerJoined\":false,\"joinedThreads\":\"pipe-reader-watchdog\",\"inputAttempts\":0"
              << ",\"childExited\":true,\"threadsJoined\":true,\"workerIdle\":true,\"watchdogFired\":false}\n";
    return 0;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"case\":\"" << label << "\",\"failure\":\"" << error.what() << "\"}\n";
    return 1;
  }
}

int DiagnoseClassificationDetails(std::wstring_view scenario){
  const std::string label(scenario.begin(),scenario.end());
  classification_detail=label.substr(std::string("classification-detail-").size());
  const bool queued=classification_detail.starts_with("prequeued-");
  const bool same_epoch=classification_detail=="prequeued-same-epoch-close";
  const bool stopping=classification_detail.ends_with("-cancel")||classification_detail.ends_with("-close");
  const bool cancel=classification_detail.ends_with("-cancel");
  const bool internal=classification_detail=="release-cancel"||classification_detail=="apartment-close";
  const bool secure=classification_detail=="partial-result"||internal;
  const bool complete=classification_detail=="signature-result"||classification_detail=="healthy-consecutive";
  const char* kind=classification_detail.starts_with("signature-")||classification_detail=="name-cancel"||classification_detail=="parent-cancel"?"point":"focused";
  RcaRun run;ULONGLONG stop_ms=0;
  try {
    run.StartFixture();
    if(secure)Require(SetWindowTextW(fixture_windows[0],L"password fixture")!=FALSE,"owned_secure_caption_set");
    run.StartPipe(same_epoch);
    run.Send(MessageType::kHandshake,1,"{\"protocolVersion\":1,\"apiVersion\":3}");
    Require(run.Wait(1,5000)&&run.ProbeReply(1,MessageType::kHandshakeResult),"detail_handshake");
    classification_contact_held=true;
    if(queued)hold_point=HoldPoint::kConsumer;
    run.Send(MessageType::kProbe,2,std::string("{\"operation\":\"sc820_classification_probe\",\"kind\":\"")+kind+"\",\"frameFallback\":true,\"fresh\":true}");
    if(stopping){
      Require(WaitForSingleObject(run.entered.value,5000)==WAIT_OBJECT_0,"detail_gate_entered");
      if(!queued) {
        Require(classification_contacts==1&&classification_returns==1&&classification_gate_calls==1,"noncontact_gate_reached");
      }
      if(internal||classification_detail.starts_with("success-"))Require(!run.Wait(2,50),"result_waits_for_cleanup");
      const auto before=WindowsTargetListControl().stop_serial.load();const auto started=GetTickCount64();
      if(cancel)run.Send(MessageType::kCancel,3,"{\"cancelEpoch\":2}");
      else run.Send(MessageType::kProbe,3,"{\"operation\":\"close_session\",\"cancelEpoch\":2}");
      Require(WaitStopSerial(before,1000),"detail_reader_latched");
      if(queued){Require(uia_read_worker_starts==0&&classification_contacts==0,"prequeued_no_worker");hold_point=HoldPoint::kNone;SetEvent(run.release.value);}
      Require(run.Wait(3,1000)&&run.Receipt(3,cancel?MessageType::kDispatchResult:MessageType::kProbeResult,cancel?"canceled":"closed",2),"detail_stop_receipt");
      stop_ms=GetTickCount64()-started;Require(stop_ms<1000,"detail_stop_budget");
      if(same_epoch)Require(cancellation_epoch.load()==2,"same_epoch_close_kept_global_epoch");
      if(!queued)Require(WindowsUiaReadWorkerRunning().load()&&classification_apartments==0&&WaitForSingleObject(run.release.value,0)==WAIT_TIMEOUT,"detail_worker_still_held");
    }
    std::string body;bool incomplete=false,empty=false,is_secure=false,canceled=false,timed=false,rejected=false;
    Require(run.Wait(2,5000)&&run.ProbeBody(2,&body)&&ReadOptionalJsonBoolean(body,"incomplete",&incomplete)&&
      ReadOptionalJsonBoolean(body,"signatureEmpty",&empty)&&ReadOptionalJsonBoolean(body,"secure",&is_secure)&&
      ReadOptionalJsonBoolean(body,"canceled",&canceled)&&ReadOptionalJsonBoolean(body,"timedOut",&timed)&&
      ReadOptionalJsonBoolean(body,"rejected",&rejected),"detail_result_shape");
    const auto original=body;
    if(stopping)Require(incomplete&&empty&&!is_secure&&rejected&&(internal?timed&&!canceled:canceled&&!timed),"detail_stopped_result_and_first_reason");
    else if(classification_detail=="partial-result")Require(incomplete&&is_secure&&timed&&rejected,"partial_secure_risk_preserved");
    else if(complete)Require(!incomplete&&!is_secure&&!rejected&&(classification_detail=="signature-result"?timed&&empty:!timed),"complete_risk_preserved");
    else Require(incomplete&&empty&&timed&&rejected,"exception_fail_closed");
    if(stopping&&!queued){SetEvent(run.release.value);Require(run.WaitUiaWorkerIdle(5000),"detail_worker_drained");Require(run.ReplyCount(2)==1&&run.ProbeBody(2,&body)&&body==original,"detail_no_late_publication");}
    if(classification_detail=="healthy-consecutive"){
      Require(classification_apartments==1&&!WindowsUiaReadWorkerRunning().load(),"cleanup_before_first_result");
      run.Send(MessageType::kProbe,4,"{\"operation\":\"sc820_classification_probe\",\"kind\":\"focused\",\"fresh\":true}");
      Require(run.Wait(4,5000)&&run.ProbeBody(4,&body)&&ReadOptionalJsonBoolean(body,"incomplete",&incomplete)&&!incomplete&&
                  classification_apartments==2&&uia_read_worker_starts==2,"consecutive_measurement_not_busy");
    }
    const unsigned measurements=queued?0:classification_detail=="healthy-consecutive"?2:1;
    Require(classification_release_calls==5*measurements&&classification_release_returns==classification_release_calls&&
                classification_apartments==measurements&&!classification_bad_cleanup.load(),"com_and_apartment_references_released_once");
    Require(classification_bstr_allocs==measurements&&classification_bstr_frees==classification_bstr_allocs,"name_bstr_released_once");
    if(classification_detail=="signature-exception")Require(classification_hash_faults==1&&classification_array_allocs==1&&classification_array_unlocks==1&&classification_array_frees==1,"locked_safearray_released_on_exception");
    {std::lock_guard lock(classification_resource_mutex);Require(classification_bstrs.empty()&&classification_arrays.empty(),"tracked_value_resources_empty");}
    if(!stopping||cancel){run.Send(MessageType::kProbe,7,"{\"operation\":\"close_session\",\"cancelEpoch\":3}");Require(run.Wait(7,1000)&&run.Receipt(7,MessageType::kProbeResult,"closed",3),"detail_final_close");}
    classification_contact_held=false;run.Cleanup();
    Require(run.child_exited&&run.worker_idle&&!run.watchdog_fired.load()&&!gate_timed_out.load(),"detail_final_cleanup");
    std::cout<<"{\"case\":\""<<label<<"\",\"controlledOwnedUia\":true,\"normalPointFocusAcceptance\":false,\"stopMs\":"<<stop_ms
      <<",\"resourceCleanupVerified\":true,\"resultPolicyVerified\":true,\"inputAttempts\":0,\"childExited\":true,\"workerIdle\":true,\"watchdogFired\":false}\n";return 0;
  }catch(const std::exception& error){run.Cleanup();std::cout<<"{\"failure\":\""<<error.what()<<"\"}\n";return 1;}
}

// Direct resolver calls are worker-only controls. The public dispatch path must release the consumer.
int DiagnoseSemanticStall(std::wstring_view scenario){
  const bool dispatch=scenario.starts_with(L"semantic-stall-dispatch-");
  const bool cancel=scenario.ends_with(L"-cancel");const bool timeout=scenario.ends_with(L"-timeout");const std::string label(scenario.begin(),scenario.end());RcaRun run;
  try {
    run.StartFixture();run.StartPipe(false);
    run.Send(MessageType::kHandshake,1,"{\"protocolVersion\":1,\"apiVersion\":3}");Require(run.Wait(1,5000)&&run.ProbeReply(1,MessageType::kHandshakeResult),"semantic_stall_handshake");
    classification_contact_held=true;
    run.Send(MessageType::kProbe,2,std::string("{\"operation\":\"sc820_semantic_stall_probe\",\"kind\":\"")+(dispatch?"dispatch":"search")+"\"}");
    Require(WaitForSingleObject(run.entered.value,5000)==WAIT_OBJECT_0&&classification_contacts==1&&classification_returns==0,"semantic_stall_contact_held");
    const auto before=WindowsTargetListControl().stop_serial.load();const auto started=GetTickCount64();
    if(!timeout){
      if(cancel)run.Send(MessageType::kCancel,3,"{\"cancelEpoch\":2}");else run.Send(MessageType::kProbe,3,"{\"operation\":\"close_session\",\"cancelEpoch\":2}");
      Require(WaitStopSerial(before,1000),"semantic_stall_reader_latched");
    }
    if(dispatch){
      if(!timeout)Require(run.Wait(3,1000)&&run.Receipt(3,cancel?MessageType::kDispatchResult:MessageType::kProbeResult,cancel?"canceled":"closed",2),"semantic_dispatch_receipt_before_release");
      Require(run.Wait(2,1000)&&classification_returns==0&&WindowsUiaReadWorkerRunning().load(),"semantic_dispatch_releases_consumer_keeps_worker");
    }else Require(!run.Wait(3,1100)&&!run.Wait(2,0)&&classification_returns==0,"worker_only_resolver_control_still_blocked");
    const auto held_ms=GetTickCount64()-(timeout?classification_contact_started.load():started);
    Require((dispatch?(held_ms<1000&&(!timeout||held_ms>=400)):held_ms>=1100)&&WaitForSingleObject(run.release.value,0)==WAIT_TIMEOUT,"semantic_stall_duration");
    if(!dispatch)SetEvent(run.release.value);
    if(timeout)run.Send(MessageType::kProbe,3,"{\"operation\":\"close_session\",\"cancelEpoch\":2}");
    Require(run.Wait(3,5000)&&run.Receipt(3,cancel?MessageType::kDispatchResult:MessageType::kProbeResult,cancel?"canceled":"closed",2),"semantic_stop_receipt");
    std::string body,reason;bool ok=true,accepted=true;std::uint64_t attempts=1;
    Require(run.Wait(2,5000)&&run.ProbeBody(2,&body)&&ReadOptionalJsonBoolean(body,"ok",&ok)&&!ok&&ReadOptionalJsonBoolean(body,"accepted",&accepted)&&!accepted&&
      ReadJsonUint64(body,"inputAttempts",&attempts)&&attempts==0&&ReadJsonString(body,"reason",&reason)&&reason==(dispatch&&!timeout?"semantic_action_failed":"accessibility_timeout"),"semantic_stall_refusal_without_input");
    if(dispatch){SetEvent(run.release.value);Require(run.WaitUiaWorkerIdle(5000)&&run.ReplyCount(2)==1,"semantic_dispatch_late_result_discarded");}
    Require(classification_returns==1&&!gate_timed_out.load(),"semantic_stall_contact_returned");
    if(cancel){run.Send(MessageType::kProbe,4,"{\"operation\":\"close_session\",\"cancelEpoch\":3}");Require(run.Wait(4,1000)&&run.Receipt(4,MessageType::kProbeResult,"closed",3),"semantic_stall_final_close");}
    classification_contact_held=false;run.Cleanup();Require(run.child_exited&&run.worker_idle&&!run.watchdog_fired.load(),"semantic_stall_cleanup");
    std::cout<<"{\"case\":\""<<label<<"\",\"baselineStallReproduced\":"<<(dispatch?"false":"true")<<",\"workerOnlyControl\":"<<(dispatch?"false":"true")<<",\"syntheticContactStall\":true,\"actualUiaLatencyMeasured\":false,\"heldMs\":"<<held_ms<<",\"readerLatched\":"<<(timeout?"false":"true")<<",\"receiptBeforeRelease\":"<<(dispatch?"true":"false")<<",\"receiptAfterRelease\":true,\"inputAttempts\":0,\"childExited\":true,\"workerIdle\":true,\"watchdogFired\":false}\n";return 0;
  }catch(const std::exception& error){run.Cleanup();std::cout<<"{\"failure\":\""<<error.what()<<"\"}\n";return 1;}
}

int DiagnoseBindingDetails(std::wstring_view scenario){
  const std::string label(scenario.begin(),scenario.end());
  classification_detail="binding-"+label.substr(std::string("binding-detail-").size());
  const bool cancel=scenario.ends_with(L"-cancel"),close=scenario.ends_with(L"-close"),stopping=cancel||close;
  const bool signature=classification_detail=="binding-runtime-close"||classification_detail=="binding-hash-exception"||classification_detail=="binding-apartment-close";
  const char* kind=signature?"signature":"bindings";RcaRun run;ULONGLONG stop_ms=0;
  try {
    run.StartFixture(false,true);run.StartPipe(false);
    run.Send(MessageType::kHandshake,1,"{\"protocolVersion\":1,\"apiVersion\":3}");Require(run.Wait(1,5000),"binding_detail_handshake");
    classification_contact_held=true;
    run.Send(MessageType::kProbe,2,std::string("{\"operation\":\"sc820_binding_probe\",\"kind\":\"")+kind+"\",\"sentinel\":true}");
    if(stopping){
      Require(WaitForSingleObject(run.entered.value,5000)==WAIT_OBJECT_0&&classification_contacts==1&&classification_returns==1&&classification_gate_calls==1,"binding_detail_noncontact_held");
      Require(!run.Wait(2,50),"binding_detail_result_not_published_while_held");
      const auto before=WindowsTargetListControl().stop_serial.load();const auto started=GetTickCount64();
      if(cancel)run.Send(MessageType::kCancel,3,"{\"cancelEpoch\":2}");else run.Send(MessageType::kProbe,3,"{\"operation\":\"close_session\",\"cancelEpoch\":2}");
      Require(WaitStopSerial(before,1000)&&run.Wait(3,1000)&&run.Receipt(3,cancel?MessageType::kDispatchResult:MessageType::kProbeResult,cancel?"canceled":"closed",2),"binding_detail_stop_receipt");
      stop_ms=GetTickCount64()-started;
      Require(stop_ms<1000&&WindowsUiaReadWorkerRunning().load()&&classification_apartments==0,"binding_detail_worker_retained");
    }
    std::string body;bool ok=true,empty=true,canceled=false,unchanged=false;
    Require(run.Wait(2,5000)&&run.ProbeBody(2,&body)&&ReadOptionalJsonBoolean(body,"ok",&ok)&&!ok&&ReadOptionalJsonBoolean(body,"empty",&empty)&&!empty&&ReadOptionalJsonBoolean(body,"outputUnchanged",&unchanged)&&unchanged&&ReadOptionalJsonBoolean(body,"canceled",&canceled)&&canceled==stopping,"binding_detail_refusal");
    const auto original=body;
    if(stopping){SetEvent(run.release.value);Require(run.WaitUiaWorkerIdle(5000),"binding_detail_drained");}
    Require(run.ReplyCount(2)==1&&run.ProbeBody(2,&body)&&body==original,"binding_detail_no_late_reply");
    Require(binding_acquired_refs>=2&&classification_release_calls==binding_acquired_refs&&classification_release_returns==binding_acquired_refs&&classification_apartments==1&&!classification_bad_cleanup.load(),"binding_detail_com_cleanup_once");
    Require((signature||classification_bstr_allocs>0)&&classification_bstr_allocs==classification_bstr_frees&&classification_array_allocs==classification_array_frees,"binding_detail_values_freed");
    if(classification_detail=="binding-hash-exception")Require(classification_hash_faults==1&&classification_array_unlocks==1&&classification_array_frees==1,"binding_detail_locked_array_cleanup");
    {std::lock_guard lock(classification_resource_mutex);Require(classification_bstrs.empty()&&classification_arrays.empty(),"binding_detail_no_value_residue");}
    if(!close){run.Send(MessageType::kProbe,4,"{\"operation\":\"close_session\",\"cancelEpoch\":3}");Require(run.Wait(4,1000)&&run.Receipt(4,MessageType::kProbeResult,"closed",3),"binding_detail_final_close");}
    classification_contact_held=false;run.Cleanup();Require(run.child_exited&&run.worker_idle&&!run.watchdog_fired.load()&&!gate_timed_out.load(),"binding_detail_cleanup");
    std::cout<<"{\"case\":\""<<label<<"\",\"ownedHwndContact\":true,\"normalUiaAcceptance\":false,\"stopMs\":"<<stop_ms<<",\"resourceCleanupVerified\":true,\"failureOutputUnchanged\":true,\"inputAttempts\":0,\"childExited\":true,\"workerIdle\":true,\"watchdogFired\":false}\n";return 0;
  }catch(const std::exception& error){run.Cleanup();std::cout<<"{\"failure\":\""<<error.what()<<"\"}\n";return 1;}
}

int DiagnoseBindingHealthy(){
  RcaRun run;
  try {
    run.StartFixture(false,true);run.StartPipe(false);
    run.Send(MessageType::kHandshake,1,"{\"protocolVersion\":1,\"apiVersion\":3}");Require(run.Wait(1,5000),"binding_healthy_handshake");
    classification_contact_held=true;classification_detail="binding-healthy";
    run.Send(MessageType::kProbe,2,"{\"operation\":\"sc820_binding_healthy_probe\"}");
    std::string body,failure;bool equivalent=false,duplicate=false;std::uint64_t nodes=0;
    Require(run.Wait(2,15000)&&run.ProbeBody(2,&body),"binding_healthy_reply");
    if(ReadJsonString(body,"code",&failure))throw std::runtime_error(failure);
    Require(ReadOptionalJsonBoolean(body,"equivalent",&equivalent)&&equivalent&&
      ReadOptionalJsonBoolean(body,"duplicateOmitted",&duplicate)&&duplicate&&ReadJsonUint64(body,"nodes",&nodes)&&nodes>=3,"binding_healthy_result");
    Require(uia_read_worker_starts==4&&classification_apartments==4&&!WindowsUiaReadWorkerRunning().load(),"binding_healthy_sequential_apartments");
    run.Send(MessageType::kProbe,3,"{\"operation\":\"close_session\",\"cancelEpoch\":2}");Require(run.Wait(3,1000)&&run.Receipt(3,MessageType::kProbeResult,"closed",2),"binding_healthy_close");
    classification_contact_held=false;run.Cleanup();Require(run.child_exited&&run.worker_idle&&!run.watchdog_fired.load(),"binding_healthy_cleanup");
    std::cout<<"{\"case\":\"binding-healthy\",\"ownedHwndContact\":true,\"normalFocusAcceptance\":false,\"equivalentValues\":true,\"duplicateOmitted\":true,\"uniquePreserved\":true,\"oldOutputReplaced\":true,\"nodes\":"<<nodes<<",\"sequentialWorkers\":4,\"inputAttempts\":0,\"childExited\":true,\"workerIdle\":true,\"watchdogFired\":false}\n";return 0;
  }catch(const std::exception& error){run.Cleanup();std::cout<<"{\"failure\":\""<<error.what()<<"\"}\n";return 1;}
}

int DiagnoseObserveSignatureStop(std::wstring_view scenario){
  const bool cancel=scenario.ends_with(L"-cancel");const std::string label(scenario.begin(),scenario.end());RcaRun run;
  try {
    run.StartFixture();run.StartPipe(false);
    run.Send(MessageType::kHandshake,1,"{\"protocolVersion\":1,\"apiVersion\":3}");Require(run.Wait(1,5000),"observe_signature_handshake");
    classification_contact_held=true;
    run.Send(MessageType::kProbe,2,"{\"operation\":\"sc820_observe_signature_probe\"}");
    Require(WaitForSingleObject(run.entered.value,5000)==WAIT_OBJECT_0&&classification_contacts==1&&classification_returns==0,"observe_signature_contact_held");
    const auto before=WindowsTargetListControl().stop_serial.load();const auto started=GetTickCount64();
    Require(started-classification_contact_started.load()<300,"observe_signature_stop_before_deadline");
    if(cancel)run.Send(MessageType::kCancel,3,"{\"cancelEpoch\":2}");else run.Send(MessageType::kProbe,3,"{\"operation\":\"close_session\",\"cancelEpoch\":2}");
    Require(WaitStopSerial(before,1000)&&GetTickCount64()-classification_contact_started.load()<470,"observe_signature_reader_latched");
    Require(run.Wait(3,1000)&&run.Receipt(3,cancel?MessageType::kDispatchResult:MessageType::kProbeResult,cancel?"canceled":"closed",2),"observe_signature_stop_receipt");
    const auto stop_ms=GetTickCount64()-started;
    std::string body,reason;bool ok=true,empty=false;
    Require(run.Wait(2,1000)&&run.ProbeBody(2,&body)&&ReadOptionalJsonBoolean(body,"ok",&ok)&&!ok&&ReadOptionalJsonBoolean(body,"empty",&empty)&&empty&&ReadJsonString(body,"reason",&reason)&&reason=="observation_stale","observe_signature_stale_result");
    Require(stop_ms<1000&&observe_after_signature_calls==0&&classification_returns==0&&WindowsUiaReadWorkerRunning().load(),"observe_signature_no_capture_while_worker_held");
    if(cancel){run.Send(MessageType::kProbe,4,"{\"operation\":\"close_session\",\"cancelEpoch\":3}");Require(run.Wait(4,1000)&&run.Receipt(4,MessageType::kProbeResult,"closed",3),"observe_signature_final_close");}
    SetEvent(run.release.value);Require(run.WaitUiaWorkerIdle(5000)&&classification_returns==1&&observe_after_signature_calls==0&&run.ReplyCount(2)==1,"observe_signature_late_cleanup");
    classification_contact_held=false;run.Cleanup();Require(run.child_exited&&run.worker_idle&&!run.watchdog_fired.load()&&!gate_timed_out.load(),"observe_signature_cleanup");
    std::cout<<"{\"case\":\""<<label<<"\",\"observePrerequisitesControlled\":true,\"normalUiaAcceptance\":false,\"stopMs\":"<<stop_ms<<",\"downstreamCaptureCalls\":0,\"inputAttempts\":0,\"childExited\":true,\"workerIdle\":true,\"watchdogFired\":false}\n";return 0;
  }catch(const std::exception& error){run.Cleanup();std::cout<<"{\"failure\":\""<<error.what()<<"\"}\n";return 1;}
}

int DiagnoseBindingStall(std::wstring_view scenario) {
  const bool signature=scenario.starts_with(L"binding-read-signature-");
  const bool cancel=scenario.ends_with(L"-cancel");
  const bool timeout=scenario.ends_with(L"-timeout");
  const bool queued=scenario.find(L"-prequeued-")!=std::wstring_view::npos;
  const bool same_epoch=scenario.ends_with(L"-same-epoch-close");
  const char* kind=signature?"signature":"bindings";
  const std::string label(scenario.begin(),scenario.end());
  RcaRun run;
  try {
    run.StartFixture();run.StartPipe(same_epoch);
    run.Send(MessageType::kHandshake,1,"{\"protocolVersion\":1,\"apiVersion\":3}");
    Require(run.Wait(1,5000)&&run.ProbeReply(1,MessageType::kHandshakeResult),"binding_handshake");
    classification_contact_held=true;
    if(queued)hold_point=HoldPoint::kConsumer;
    run.Send(MessageType::kProbe,2,std::string("{\"operation\":\"sc820_binding_probe\",\"kind\":\"")+kind+"\",\"fresh\":true}");
    Require(WaitForSingleObject(run.entered.value,5000)==WAIT_OBJECT_0,"binding_contact_entered");
    Require(classification_contacts==(queued?0:1)&&classification_returns==0,"binding_contact_held");
    const auto before=WindowsTargetListControl().stop_serial.load();const auto started=GetTickCount64();
    if(!timeout){
      if(!queued)Require(started-classification_contact_started.load()<300,"binding_stop_before_deadline");
      if(cancel)run.Send(MessageType::kCancel,3,"{\"cancelEpoch\":2}");
      else run.Send(MessageType::kProbe,3,"{\"operation\":\"close_session\",\"cancelEpoch\":2}");
      Require(WaitStopSerial(before,1000),"binding_reader_latched");
      if(!queued)Require(GetTickCount64()-classification_contact_started.load()<470,"binding_stop_latched_before_deadline");
      else {Require(uia_read_worker_starts==0&&classification_contacts==0,"binding_prequeued_no_worker");hold_point=HoldPoint::kNone;SetEvent(run.release.value);}
      Require(run.Wait(3,1000)&&run.Receipt(3,cancel?MessageType::kDispatchResult:MessageType::kProbeResult,cancel?"canceled":"closed",2),"binding_receipt_before_release");
    }
    Require(run.Wait(2,1000),"binding_response_before_release");
    const auto held_ms=GetTickCount64()-(timeout?classification_contact_started.load():started);
    if(queued)Require(held_ms<1000&&classification_contacts==0&&uia_read_worker_starts==0&&!WindowsUiaReadWorkerRunning().load(),"binding_prequeued_refused_without_worker");
    else Require(held_ms<1000&&(!timeout||held_ms>=400)&&classification_returns==0&&WindowsUiaReadWorkerRunning().load()&&uia_read_worker_starts==1&&WaitForSingleObject(run.release.value,0)==WAIT_TIMEOUT,"binding_worker_retained_before_release");
    if(same_epoch)Require(cancellation_epoch.load()==2,"binding_same_global_epoch_preserved");
    std::string body;bool ok=true,empty=false,canceled=false,timed=false;
    Require(run.ProbeBody(2,&body)&&ReadOptionalJsonBoolean(body,"ok",&ok)&&!ok&&ReadOptionalJsonBoolean(body,"empty",&empty)&&empty&&
      ReadOptionalJsonBoolean(body,"canceled",&canceled)&&canceled==!timeout&&ReadOptionalJsonBoolean(body,"timedOut",&timed)&&timed==timeout,"binding_refusal_and_stop_reason");
    const auto original=body;
    if(!queued){run.Send(MessageType::kProbe,5,std::string("{\"operation\":\"sc820_binding_probe\",\"kind\":\"")+kind+"\",\"fresh\":true}");
    Require(run.Wait(5,1000)&&run.ProbeBody(5,&body)&&ReadOptionalJsonBoolean(body,"ok",&ok)&&!ok&&uia_read_worker_starts==1&&classification_contacts==1,"binding_busy_does_not_spawn");}
    if(timeout){run.Send(MessageType::kProbe,3,"{\"operation\":\"close_session\",\"cancelEpoch\":2}");Require(run.Wait(3,1000)&&run.Receipt(3,MessageType::kProbeResult,"closed",2),"binding_timeout_final_close");}
    if(cancel){run.Send(MessageType::kProbe,4,"{\"operation\":\"close_session\",\"cancelEpoch\":3}");Require(run.Wait(4,1000)&&run.Receipt(4,MessageType::kProbeResult,"closed",3),"binding_final_close");}
    SetEvent(run.release.value);Require(run.WaitUiaWorkerIdle(5000)&&classification_returns==(queued?0:1)&&!gate_timed_out.load(),"binding_worker_retired");
    Require(run.ReplyCount(2)==1&&run.ProbeBody(2,&body)&&body==original,"binding_no_late_reply");
    classification_contact_held=false;
    if(!queued){run.Send(MessageType::kProbe,6,"{\"operation\":\"sc820_binding_probe\",\"kind\":\"recovery\",\"fresh\":true}");
    bool recovered=false;Require(run.Wait(6,1000)&&run.ProbeBody(6,&body)&&ReadOptionalJsonBoolean(body,"recovered",&recovered)&&recovered&&uia_read_worker_starts==2,"binding_slot_recovered");}
    run.Cleanup();Require(run.child_exited&&run.worker_idle&&!run.watchdog_fired.load(),"binding_final_cleanup");
    std::cout<<"{\"case\":\""<<label<<"\",\"syntheticContactStall\":"<<(queued?"false":"true")<<",\"normalUiaAcceptance\":false,\"heldMs\":"<<held_ms<<",\"readerLatched\":"<<(timeout?"false":"true")<<",\"responseBeforeRelease\":"<<(queued?"false":"true")<<",\"contactDeadline\":"<<(timeout?"true":"false")<<",\"prequeued\":"<<(queued?"true":"false")<<",\"slotRecovered\":"<<(queued?"false":"true")<<",\"inputAttempts\":0,\"childExited\":true,\"workerIdle\":true,\"watchdogFired\":false}\n";
    return 0;
  }catch(const std::exception& error){run.Cleanup();std::cout<<"{\"failure\":\""<<error.what()<<"\"}\n";return 1;}
}

int DiagnoseClassificationStall(std::wstring_view scenario) {
  const bool focused = scenario.starts_with(L"classification-focused-");
  const bool cancel = scenario.ends_with(L"-cancel");
  const bool timeout = scenario.ends_with(L"-timeout");
  const char *kind = focused ? "focused" : "point";
  const std::string label = std::string("classification-") + kind + (timeout ? "-timeout" : cancel ? "-cancel" : "-close");
  RcaRun run;
  try {
    run.StartFixture();
    run.StartPipe(false);
    run.Send(MessageType::kHandshake, 1, "{\"protocolVersion\":1,\"apiVersion\":3}");
    Require(run.Wait(1, 5000) && run.ProbeReply(1, MessageType::kHandshakeResult), "classification_handshake");
    classification_contact_held.store(true);
    run.Send(MessageType::kProbe, 2, std::string("{\"operation\":\"sc820_classification_probe\",\"kind\":\"") + kind + "\"}");
    Require(WaitForSingleObject(run.entered.value, 5000) == WAIT_OBJECT_0, "classification_gate_entered");
    Require(classification_contacts.load() == 1 && classification_returns.load() == 0, "classification_contact_pending");
    ULONGLONG held_ms=0;
    if(timeout) {
      Require(run.Wait(2,1000),"classification_contact_deadline_response");
      held_ms=GetTickCount64()-classification_contact_started.load();
      Require(held_ms>=400&&held_ms<1000&&classification_returns.load()==0&&WindowsUiaReadWorkerRunning().load()&&
                  WaitForSingleObject(run.release.value,0)==WAIT_TIMEOUT,"classification_contact_deadline_before_release");
    } else {
      const auto before = WindowsTargetListControl().stop_serial.load();
      const ULONGLONG started = GetTickCount64();
      Require(started-classification_contact_started.load()<300,"classification_stop_sent_before_contact_deadline");
      if (cancel) run.Send(MessageType::kCancel, 3, "{\"cancelEpoch\":2}");
      else run.Send(MessageType::kProbe, 3, "{\"operation\":\"close_session\",\"cancelEpoch\":2}");
      Require(WaitStopSerial(before, 1000), "classification_stop_reader_progress");
      Require(GetTickCount64()-classification_contact_started.load()<470,"classification_stop_latched_before_contact_deadline");
      Require(run.Wait(3, 1000), "classification_stop_receipt_before_release");
      held_ms = GetTickCount64() - started;
      Require(held_ms<1000 && classification_returns.load() == 0 && WindowsUiaReadWorkerRunning().load() &&
                  uia_read_worker_starts.load()==1 && WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT,
              "classification_stop_keeps_held_worker");
      Require(run.Wait(2, 1000), "classification_result_before_release");
    }
    std::string body;
    bool incomplete = false, empty = false, canceled = false, timed=false;
    Require(run.ProbeBody(2, &body) && ReadOptionalJsonBoolean(body, "incomplete", &incomplete) && incomplete &&
                ReadOptionalJsonBoolean(body, "signatureEmpty", &empty) && empty &&
                ReadOptionalJsonBoolean(body,"canceled",&canceled) && canceled==!timeout &&
                ReadOptionalJsonBoolean(body,"timedOut",&timed) && timed==timeout, "classification_stop_and_deadline_causes_distinct");
    const std::string original_body=body;
    run.Send(MessageType::kProbe,5,std::string("{\"operation\":\"sc820_classification_probe\",\"kind\":\"")+kind+"\",\"fresh\":true}");
    bool busy_timeout=false;
    Require(run.Wait(5,1000)&&run.ProbeBody(5,&body)&&ReadOptionalJsonBoolean(body,"timedOut",&busy_timeout)&&busy_timeout &&
                classification_contacts.load()==1&&uia_read_worker_starts.load()==1,"classification_busy_does_not_spawn");
    if(timeout)run.Send(MessageType::kProbe,3,"{\"operation\":\"close_session\",\"cancelEpoch\":2}");
    Require(run.Wait(3, 5000) && run.Receipt(3, cancel ? MessageType::kDispatchResult : MessageType::kProbeResult,
                cancel ? "canceled" : "closed", 2), "classification_late_stop_receipt");
    if (cancel) {
      run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":3}");
      Require(run.Wait(4, 5000) && run.Receipt(4, MessageType::kProbeResult, "closed", 3), "classification_final_close");
    }
    SetEvent(run.release.value);
    Require(run.WaitUiaWorkerIdle(5000),"classification_worker_drained");
    Require(classification_returns.load() == 1 && !gate_timed_out.load(), "classification_contact_released");
    Require(run.ReplyCount(2)==1&&run.ProbeBody(2,&body)&&body==original_body,"classification_late_result_discarded");
    classification_contact_held.store(false);
    run.Send(MessageType::kProbe,6,"{\"operation\":\"sc820_classification_probe\",\"kind\":\"recovery\",\"fresh\":true}");
    bool recovered=false;
    Require(run.Wait(6,1000)&&run.ProbeBody(6,&body)&&ReadOptionalJsonBoolean(body,"recovered",&recovered)&&recovered &&
                uia_read_worker_starts.load()==2&&!WindowsUiaReadWorkerRunning().load(),"classification_slot_recovered");
    run.Cleanup();
    Require(run.child_exited && run.worker_idle && !run.watchdog_fired.load(), "classification_cleanup");
    std::cout << "{\"case\":\"" << label << "\",\"syntheticContactStall\":true,\"actualUiaLatencyMeasured\":false"
              << ",\"readerLatched\":"<<(timeout?"false":"true")<<",\"receiptBeforeRelease\":true,\"heldMs\":" << held_ms
              << ",\"lateReceiptConfirmed\":true,\"canceledByStop\":"<<(timeout?"false":"true")<<",\"contactDeadline\":"<<(timeout?"true":"false")<<",\"lateResultDiscarded\":true,\"slotRecovered\":true,\"inputAttempts\":0,\"childExited\":true,\"threadsJoined\":true"
              << ",\"workerIdle\":true,\"watchdogFired\":false}\n";
    return 0;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"failure\":\"" << error.what() << "\"}\n";
    return 1;
  }
}

int DiagnoseUia(std::wstring_view scenario) {
  const bool timeout = scenario == L"uia-contact-timeout";
  const bool cancel = scenario == L"uia-cancel";
  const bool close = scenario == L"uia-close";
  const bool queued = scenario == L"uia-prequeued-close";
  const bool twice = scenario == L"uia-two-reads";
  const bool deadline = scenario == L"uia-shared-deadline";
  const char *label = timeout ? "uia-contact-timeout" : cancel ? "uia-cancel" : close ? "uia-close" :
      queued ? "uia-prequeued-close" : twice ? "uia-two-reads" : "uia-shared-deadline";
  RcaRun run;
  ULONGLONG response_ms = 0, stop_ms = 0;
  try {
    run.StartFixture();
    run.StartPipe(false);
    run.Send(MessageType::kHandshake, 1, "{\"protocolVersion\":1,\"apiVersion\":3}");
    Require(run.Wait(1, 5000) && run.ProbeReply(1, MessageType::kHandshakeResult), "uia_handshake");
    uia_hold_contact.store(deadline ? 2 : timeout || cancel || close ? 1 : 0);
    hold_point.store(queued ? HoldPoint::kConsumer : HoldPoint::kNone);
    const std::string mode = twice ? "twice" : deadline ? "deadline" : "single";
    const ULONGLONG started = GetTickCount64();
    run.Send(MessageType::kProbe, 2, "{\"operation\":\"sc820_read_probe\",\"mode\":\"" + mode + "\"}");
    bool stopped = false;
    const auto stop_control = [&](bool cancel_first, bool release_consumer) {
      const std::uint64_t before = WindowsTargetListControl().stop_serial.load();
      const ULONGLONG sent = GetTickCount64();
      if (cancel_first)
        run.Send(MessageType::kCancel, 3, "{\"cancelEpoch\":2}");
      else
        run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":2}");
      Require(WaitStopSerial(before, 1000), "uia_stop_reader_progress");
      if (release_consumer) {
        Require(!WindowsUiaReadWorkerRunning().load() && uia_contacts.load() == 0 &&
                    cancellation_epoch.load() == 1,
                "uia_prequeued_stop_before_worker");
        hold_point.store(HoldPoint::kNone);
        SetEvent(run.release.value);
      }
      if (cancel_first) {
        Require(run.Wait(3, 1000) && run.Receipt(3, MessageType::kDispatchResult, "canceled", 2),
                "uia_cancel_receipt");
        // Cancel alone must free the consumer; Close cannot mask a missed cancellation.
        run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":3}");
      }
      Require(run.Wait(4, 1000) && run.Receipt(4, MessageType::kProbeResult, "closed", cancel_first ? 3 : 2),
              "uia_close_receipt");
      stop_ms = GetTickCount64() - sent;
      Require(stop_ms < 1000, "uia_stop_ack_budget");
      stopped = true;
    };
    if (!twice) {
      Require(WaitForSingleObject(run.entered.value, 5000) == WAIT_OBJECT_0, "uia_gate_entered");
      Require(WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT, "uia_gate_held");
      Require(WindowsUiaReadWorkerRunning().load() == !queued, "uia_worker_ownership");
    }
    if (cancel || close || queued) stop_control(cancel, queued);
    UiaReadResult result;
    Require(run.Wait(2, twice ? 7000 : 1000) && run.UiaReply(2, &result), "uia_read_response");
    response_ms = GetTickCount64() - started;
    if (twice) {
      Require(result.first && result.second && result.stop == "none" && result.first_nodes > 0 &&
                  result.second_nodes > 0 && result.initial_nodes == 17 &&
                  result.outer_nodes == 17 + result.first_nodes + result.second_nodes,
              "uia_outer_nodes_accumulate_once");
    } else if (deadline) {
      Require(result.first && !result.second && result.empty && result.stop == "budget" &&
                  result.first_nodes > 0 && result.second_nodes == 0 &&
                  result.outer_nodes == 17 + result.first_nodes && response_ms >= 1450 &&
                  response_ms < 2200 && GetTickCount64() - uia_held_since.load() <
                      static_cast<ULONGLONG>(kWindowsV1UiaSlowContact.count()),
              "uia_second_read_uses_remaining_outer_deadline");
    } else {
      Require(!result.first && result.empty && result.first_nodes == 0 && result.outer_nodes == 0 &&
                  result.stop == (timeout ? "timeout" : "canceled"), "uia_outer_stop_propagated");
      if (timeout)
        Require(response_ms >= static_cast<ULONGLONG>(kWindowsV1UiaSlowContact.count()) &&
                    GetTickCount64() - uia_held_since.load() < 1000, "uia_contact_deadline_bounded");
    }
    if (queued) {
      Require(uia_contacts.load() == 0 && !WindowsUiaReadWorkerRunning().load(),
              "uia_prequeued_close_created_no_worker");
    } else if (!twice) {
      Require(WindowsUiaReadWorkerRunning().load() &&
                  WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT &&
                  WaitForSingleObject(run.children[0].value, 0) == WAIT_TIMEOUT,
              "uia_response_precedes_gate_release");
      if (timeout) {
        const unsigned before = uia_contacts.load();
        run.Send(MessageType::kProbe, 6, "{\"operation\":\"sc820_read_probe\",\"mode\":\"single\"}");
        UiaReadResult busy;
        Require(run.Wait(6, 1000) && run.UiaReply(6, &busy) && !busy.first && busy.empty &&
                    busy.first_nodes == 0 && uia_contacts.load() == before &&
                    WindowsUiaReadWorkerRunning().load(), "uia_busy_read_does_not_spawn");
      }
      uia_hold_contact.store(0);
      SetEvent(run.release.value);
    }
    Require(run.WaitUiaWorkerIdle(15'000), "uia_late_worker_drained");
    const unsigned completed = queued ? 0 : twice || deadline ? 2 : 1;
    Require(uia_contacts.load() == completed && uia_completed_contacts.load() == completed &&
                uia_successful_contacts.load() == completed && uia_nonnull_roots.load() == completed &&
                uia_released_roots.load() == completed, "uia_real_contact_and_root_cleanup");
    UiaReadResult after;
    Require(run.ReplyCount(2) == 1 && run.UiaReply(2, &after) && after.first == result.first &&
                after.second == result.second && after.outer_nodes == result.outer_nodes && after.stop == result.stop,
            "uia_late_result_not_published");
    if (timeout) {
      run.Send(MessageType::kProbe, 20, "{\"operation\":\"sc820_read_probe\",\"mode\":\"single\"}");
      UiaReadResult fresh;
      Require(run.Wait(20, 7000) && run.UiaReply(20, &fresh) && fresh.first && !fresh.empty &&
                  fresh.stop == "none" && fresh.first_nodes > 0 && fresh.outer_nodes == fresh.first_nodes &&
                  run.WaitUiaWorkerIdle(1000) && uia_contacts.load() == completed + 1 &&
                  uia_released_roots.load() == completed + 1, "uia_explicit_retry_recovers");
    }
    if (!stopped) stop_control(true, false);
    Require(!wrong_measurement.load() && !gate_timed_out.load(), "uia_owned_contact_only");
    run.Cleanup();
    Require(run.child_exited && run.worker_idle && !run.watchdog_fired.load(), "uia_cleanup_completed");
    std::cout << "{\"case\":\"" << label << "\",\"responseMs\":" << response_ms << ",\"stopMs\":" << stop_ms
              << ",\"outerStop\":\"" << result.stop << "\",\"outerNodes\":" << result.outer_nodes
              << ",\"lateResultDiscarded\":true,\"realContactCleanup\":true,\"inputAttempts\":0"
              << ",\"childExited\":true,\"threadsJoined\":true,\"workerIdle\":true,\"watchdogFired\":false}\n";
    return 0;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"failure\":\"" << error.what() << "\"}\n";
    return 1;
  }
}

int Diagnose(std::wstring_view scenario) {
  const bool healthy = scenario == L"healthy";
  const bool deadline = scenario == L"deadline";
  const bool deadline_race = scenario == L"deadline-stop-race";
  const bool two_fixtures = deadline || deadline_race;
  const bool cold_deadline = scenario == L"cold-context-deadline";
  const bool context = scenario == L"context-cancel" || cold_deadline;
  const bool queued = scenario == L"queued-stop";
  const bool completion_race = scenario == L"completion-race";
  const bool same_epoch_close = scenario == L"measure-same-epoch-close";
  const bool close_only = scenario == L"measure-close" || same_epoch_close;
  const char *label = healthy ? "healthy" : deadline ? "deadline" :
      deadline_race ? "deadline-stop-race" : cold_deadline ? "cold-context-deadline" :
      context ? "context-cancel" : queued ? "queued-stop" : completion_race ? "completion-race" :
      same_epoch_close ? "measure-same-epoch-close" : close_only ? "measure-close" : "measure-cancel";
  RcaRun run;
  ULONGLONG stop_ms = 0, list_ms = 0;
  bool busy_checked = false;
  bool generation_unchanged = false;
  bool partial_preserved = false;
  bool cold_context_reused = false;
  try {
    run.StartFixture();
    if (two_fixtures) run.StartFixture();
    run.StartPipe(same_epoch_close);
    run.Send(MessageType::kHandshake, 1, "{\"protocolVersion\":1,\"apiVersion\":3}");
    Require(run.Wait(1, 5000) && run.ProbeReply(1, MessageType::kHandshakeResult), "handshake");
    Require(!WindowsV2FactsContextCache().has_value(), "initial_context_empty");
    std::string completed_row;
    if (two_fixtures) {
      // A's real row is the control. No verdict or eligibility is invented for our own child.
      enumeration_count = 1;
      hold_point.store(HoldPoint::kNone);
      run.Send(MessageType::kProbe, 30, "{\"operation\":\"list_targets\"}");
      std::uint64_t baseline_generation = 0;
      bool truncated = true;
      Require(run.Wait(30, 7000) && run.ListTargets(30, &baseline_generation, &completed_row, &truncated) &&
                  !truncated && !completed_row.empty(), "completed_fixture_baseline");
      Require(run.WaitWorkerIdle(1000) && WindowsV2FactsContextCache().has_value() &&
                  measurement_calls.load() == 1, "baseline_context_committed");
      enumeration_count = 2;
    }
    held_measure_pid = fixture_pids[two_fixtures ? 1 : 0];
    hold_point.store(healthy ? HoldPoint::kNone : context ? HoldPoint::kContext :
                     queued ? HoldPoint::kConsumer : completion_race ? HoldPoint::kCompletion : HoldPoint::kMeasure);
    hold_deadline_adoption.store(deadline_race);
    const std::uint64_t generation_before = windows_v2_list_generation;
    const ULONGLONG list_started = GetTickCount64();
    run.Send(MessageType::kProbe, 2, "{\"operation\":\"list_targets\"}");
    ULONGLONG gate_started = 0;
    if (healthy) {
      Require(run.Wait(2, 7000) && run.ProbeReply(2, MessageType::kProbeResult), "healthy_list");
      Require(run.WaitWorkerIdle(1000), "healthy_worker_idle");
      Require(measurement_calls.load() == 1 && WindowsV2FactsContextCache().has_value(), "healthy_context_committed");
      Require(windows_v2_list_generation == generation_before + 1, "healthy_generation_committed");
    } else {
      Require(WaitForSingleObject(run.entered.value, 15'000) == WAIT_OBJECT_0, "fault_gate_entered");
      gate_started = GetTickCount64();
      Require(WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT, "fault_gate_stays_closed");
      Require(WindowsTargetListWorkerRunning().load() == !queued, "worker_ownership_at_gate");
    }
    if (deadline) {
      std::uint64_t partial_generation = 0;
      std::string partial_rows;
      bool truncated = false;
      Require(run.Wait(2, static_cast<DWORD>(kWindowsListTargetsBudgetMs + 1000)) &&
                  run.ListTargets(2, &partial_generation, &partial_rows, &truncated), "deadline_partial_list");
      list_ms = GetTickCount64() - list_started;
      Require(list_ms >= kWindowsListTargetsBudgetMs && list_ms <= kWindowsListTargetsBudgetMs + 1500,
              "deadline_bounded");
      Require(truncated && partial_generation == generation_before + 1 &&
                  partial_rows == completed_row + "," + std::string(kWindowsV2UnresolvableRow) &&
                  measurement_calls.load() == 3, "completed_row_preserved_unfinished_anonymous");
      partial_preserved = true;
      Require(WindowsTargetListWorkerRunning().load(), "deadline_keeps_the_worker_slot");
      AssertBusyRefusals(run);
      busy_checked = true;
    } else if (deadline_race) {
      // B remains held. Stop wins after the consumer's deadline but before its adoption lock.
      Require(WaitForSingleObject(run.adopting.value, static_cast<DWORD>(kWindowsListTargetsBudgetMs + 1000)) ==
                  WAIT_OBJECT_0, "deadline_adoption_gate_entered");
      list_ms = GetTickCount64() - list_started;
      Require(list_ms >= kWindowsListTargetsBudgetMs && !run.Wait(2, 0) &&
                  WindowsTargetListWorkerRunning().load() &&
                  WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT, "deadline_adoption_still_held");
    } else if (cold_deadline) {
      Require(run.Wait(2, static_cast<DWORD>(kWindowsListTargetsBudgetMs + 1000)) &&
                  run.Error(2, "list_targets_unavailable"), "cold_context_initial_deadline");
      list_ms = GetTickCount64() - list_started;
      Require(list_ms >= kWindowsListTargetsBudgetMs && list_ms <= kWindowsListTargetsBudgetMs + 1500 &&
                  windows_v2_list_generation == generation_before && !WindowsV2FactsContextCache().has_value() &&
                  context_factory_calls.load() == 1 && measurement_calls.load() == 0,
              "cold_context_initial_unadopted");
      generation_unchanged = true;
      // The context itself takes more than six seconds, with no Stop and no second worker.
      while (GetTickCount64() < gate_started + 7000) Sleep(10);
      Require(WindowsTargetListWorkerRunning().load() && !HasContextCandidate(), "cold_context_keeps_single_worker");
      hold_point.store(HoldPoint::kNone);
      SetEvent(run.release.value);
      Require(run.WaitWorkerIdle(15'000) && !WindowsV2FactsContextCache().has_value() &&
                  HasContextCandidate() && windows_v2_list_generation == generation_before &&
                  context_factory_calls.load() == 1 && measurement_calls.load() == 0,
              "late_context_is_candidate_only");
      run.Send(MessageType::kProbe, 20, "{\"operation\":\"list_targets\"}");
      Require(run.Wait(20, 7000) && run.ProbeReply(20, MessageType::kProbeResult) && run.WaitWorkerIdle(1000) &&
                  WindowsV2FactsContextCache().has_value() && !HasContextCandidate() &&
                  context_factory_calls.load() == 1 && windows_v2_list_generation == generation_before + 1,
              "explicit_retry_reuses_late_context");
      cold_context_reused = true;
    }
    for (const auto &child : run.children)
      if (child.value != nullptr)
        Require(WaitForSingleObject(child.value, 0) == WAIT_TIMEOUT, "fixture_alive_before_stop");
    const std::uint64_t serial_before = WindowsTargetListControl().stop_serial.load();
    const ULONGLONG stop_started = GetTickCount64();
    const std::uint64_t close_epoch = close_only ? 2 : 3;
    if (close_only) {
      run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":2}");
      Require(WaitStopSerial(serial_before, 1000), "close_reader_invalidated");
    } else {
      run.Send(MessageType::kCancel, 3, "{\"cancelEpoch\":2}");
      Require(WaitStopSerial(serial_before, 1000), "cancel_reader_invalidated");
      run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":3}");
    }
    if (queued) {
      Require(!WindowsTargetListWorkerRunning().load() && measurement_calls.load() == 0,
              "queued_stop_has_no_worker");
    }
    if (queued || deadline_race) {
      hold_point.store(HoldPoint::kNone);
      hold_deadline_adoption.store(false);
      SetEvent(run.release.value);
    }
    if (!close_only)
      Require(run.Wait(3, 1000) && run.Receipt(3, MessageType::kDispatchResult, "canceled", 2),
              "cancel_receipt_within_budget");
    Require(run.Wait(4, 1000) && run.Receipt(4, MessageType::kProbeResult, "closed", close_epoch),
            "close_receipt_within_budget");
    stop_ms = GetTickCount64() - stop_started;
    Require(stop_ms < 1000, "stop_receipts_within_ack_budget");
    Require(cancellation_epoch.load() >= 2, "stop_reader_epoch_advanced");
    if (same_epoch_close) Require(cancellation_epoch.load() == 2, "same_epoch_close_used_stop_serial");
    if (scenario == L"measure-close") {
      const auto replay_serial = WindowsTargetListControl().stop_serial.load();
      run.Send(MessageType::kProbe, 21, "{\"operation\":\"close_session\",\"cancelEpoch\":3}");
      Require(run.Wait(21, 1000) && run.Receipt(21, MessageType::kProbeResult, "closed", 3),
              "close_resend_receipt");
      const auto closed = closed_sessions.find(FrameIdKey(Id(7)));
      Require(WindowsTargetListControl().stop_serial.load() > replay_serial &&
                  cancellation_epoch.load() == 2 && last_closed_cancel_epoch == 2 &&
                  closed != closed_sessions.end() && closed->second.cancel_epoch == 3,
              "close_resend_preserves_fresh_epoch_zero_start_condition");
    }
    if (!healthy && !cold_deadline) {
      if (!deadline)
        Require(run.Wait(2, 1000) && run.Error(2, "list_targets_unavailable"), "stopped_list_refused");
      const std::uint64_t expected_generation = generation_before + (deadline ? 1 : 0);
      generation_unchanged = !deadline && windows_v2_list_generation == generation_before;
      Require(windows_v2_list_generation == expected_generation &&
                  WindowsV2FactsContextCache().has_value() == two_fixtures && !HasContextCandidate(),
              "stop_does_not_adopt_late_result");
      if (!queued && !deadline_race) {
        Require(WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT && WindowsTargetListWorkerRunning().load(),
                "receipts_precede_worker_release");
      }
      hold_point.store(HoldPoint::kNone);
      SetEvent(run.release.value);
      Require(run.WaitWorkerIdle(15'000), "abandoned_worker_drained");
      Require(windows_v2_list_generation == expected_generation &&
                  WindowsV2FactsContextCache().has_value() == two_fixtures && !HasContextCandidate(),
              "late_result_and_context_discarded");
      if (queued || context) Require(measurement_calls.load() == 0, "stopped_before_measurement");
      run.Send(MessageType::kProbe, 20, "{\"operation\":\"list_targets\"}");
      Require(run.Wait(20, 7000) && run.ProbeReply(20, MessageType::kProbeResult), "fresh_list_recovers");
      Require(run.WaitWorkerIdle(1000) && WindowsV2FactsContextCache().has_value() &&
                  windows_v2_list_generation == expected_generation + 1, "fresh_candidate_committed_once");
      if (context) Require(context_factory_calls.load() == 2, "canceled_context_is_measured_again");
    }
    Require(!wrong_measurement.load() && !gate_timed_out.load(), "owned_measurement_only");
    run.Cleanup();
    Require(run.child_exited && run.worker_idle && !run.watchdog_fired.load(), "cleanup_completed");
    std::cout << "{\"case\":\"" << label << "\",\"stopSerialAdvanced\":true,\"stopMs\":" << stop_ms
              << ",\"listMs\":" << list_ms << ",\"busyChecked\":" << (busy_checked ? "true" : "false")
              << ",\"generationUnchangedOnRefusal\":" << (generation_unchanged ? "true" : "false")
              << ",\"partialPreserved\":" << (partial_preserved ? "true" : "false")
              << ",\"coldContextReused\":" << (cold_context_reused ? "true" : "false")
              << ",\"fixtureCount\":" << fixture_count
              << ",\"closeReplayChecked\":" << (scenario == L"measure-close" ? "true" : "false")
              << ",\"recovered\":true,\"inputAttempts\":0,\"childExited\":true,\"threadsJoined\":true"
              << ",\"workerIdle\":true,\"watchdogFired\":false}\n";
    return 0;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"failure\":\"" << error.what() << "\"}\n";
    return 1;
  }
}
} // namespace

int wmain(int argc, wchar_t **argv) {
  if (argc == 4 && std::wstring_view(argv[1]) == L"fixture") return Fixture(argv[2], argv[3]);
  if (argc == 5 && std::wstring_view(argv[1]) == L"fixture" && std::wstring_view(argv[4]) == L"bindings") return Fixture(argv[2],argv[3],true);
  if (argc == 4 && std::wstring_view(argv[1]) == L"start-coordinator") return CoordinateStart(argv[2], argv[3]);
  if (argc == 8 && std::wstring_view(argv[1]) == L"start-client") {
    const std::wstring started(argv[5]);
    if (std::wstring_view(argv[2]).starts_with(L"resume-"))
      return DiagnoseResume(argv[2], static_cast<DWORD>(std::stoul(argv[3])),
          reinterpret_cast<HWND>(static_cast<UINT_PTR>(std::stoull(argv[4]))),
          std::string(started.begin(), started.end()), argv[6], std::wstring_view(argv[7]) == L"1");
    if (std::wstring_view(argv[2]).starts_with(L"rejudge-"))
      return DiagnoseRejudge(argv[2], static_cast<DWORD>(std::stoul(argv[3])),
          reinterpret_cast<HWND>(static_cast<UINT_PTR>(std::stoull(argv[4]))),
          std::string(started.begin(), started.end()), argv[6]);
    return DiagnoseStart(argv[2], static_cast<DWORD>(std::stoul(argv[3])),
        reinterpret_cast<HWND>(static_cast<UINT_PTR>(std::stoull(argv[4]))),
        std::string(started.begin(), started.end()), argv[6], std::wstring_view(argv[7]) == L"1");
  }
  if (argc != 2) return 2;
  if (std::wstring_view(argv[1]).starts_with(L"semantic-stall-")) return DiagnoseSemanticStall(argv[1]);
  if (std::wstring_view(argv[1]).starts_with(L"binding-detail-")) return DiagnoseBindingDetails(argv[1]);
  if (std::wstring_view(argv[1]) == L"binding-healthy") return DiagnoseBindingHealthy();
  if (std::wstring_view(argv[1]).starts_with(L"binding-observe-")) return DiagnoseObserveSignatureStop(argv[1]);
  if (std::wstring_view(argv[1]).starts_with(L"binding-read-")) return DiagnoseBindingStall(argv[1]);
  if (std::wstring_view(argv[1]).starts_with(L"classification-detail-")) return DiagnoseClassificationDetails(argv[1]);
  if (std::wstring_view(argv[1]).starts_with(L"classification-")) return DiagnoseClassificationStall(argv[1]);
  if (std::wstring_view(argv[1]).starts_with(L"validation-")) return DiagnoseValidation(argv[1]);
  if (std::wstring_view(argv[1]).starts_with(L"uia-")) return DiagnoseUia(argv[1]);
  return Diagnose(argv[1]);
}
`;

describe('Windows target I/O RCA seam source', () => {
  it('injects bounded phase gates and enumerates only its own fixture', () => {
    const generated = instrumentedHost();
    expect(generated.split('  Sc940MeasureGate(pid);')).toHaveLength(2);
    expect(generated).not.toContain(enumeration);
    expect(generated).toContain(measurement);
    expect(generated.split('  if (!had_cached_context) Sc940ContextGate();')).toHaveLength(2);
    expect(generated.split('        Sc940CompletionGate();')).toHaveLength(2);
    expect(generated.split('    Sc940AdoptionGate();')).toHaveLength(2);
    expect(
      generated.split('    Sc940ConsumerGate(queued.frame.header.request_id.bytes[0]);'),
    ).toHaveLength(2);
    expect(generated.split('  Sc940SyncSessionProbe();')).toHaveLength(2);
    expect(
      generated.split('!Sc940ResumeOpen(work, target_process.value, &current_executable)'),
    ).toHaveLength(2);
    expect(generated.split('!Sc940ResumeResolve(')).toHaveLength(2);
    expect(generated.split('Sc940ResumePrepareFocus(input.window);')).toHaveLength(2);
    expect(generated.split('Sc940ResumeShow(')).toHaveLength(3);
    expect(generated.split('Sc940ResumeForeground(refocus_window);')).toHaveLength(2);
    expect(generated.split('operation == "sc940_resume_baseline"')).toHaveLength(2);
    expect(generated.split('!Sc940ResumeFileIdentity(work, &held)')).toHaveLength(3);
    expect(generated.split('  Sc940ResumeWorkerStarted(*work);')).toHaveLength(2);
    expect(generated.split('    Sc940ResumeContextGate(work);')).toHaveLength(2);
    expect(generated.split('Sc940ResumeInvalidateTicket(input.session_key);')).toHaveLength(4);
    expect(
      generated.split('Sc940ResumeCancelAttempt(); CancelSynchronousIo(pending->thread.value);'),
    ).toHaveLength(2);
    expect(program).toContain('WaitForSingleObject(thread, budget) == WAIT_OBJECT_0');
    expect(program).toContain('run.Error(2, "session_start_canceled")');
    expect(program).toContain('CancelWindowsExistingStartJob(pending);');
    expect(generated.split('if (!Sc820ContactGate(window)) return E_ABORT;')).toHaveLength(2);
    expect(generated.split('root->Release(); Sc820RootReleased();')).toHaveLength(2);
    expect(generated.split('operation == "sc820_read_probe"')).toHaveLength(2);
    expect(generated.split('Sc940RejudgeFileIdentity(work, &held)')).toHaveLength(2);
    expect(generated.split('operation == "sc940_rejudge_probe"')).toHaveLength(2);
    expect(program).toContain(
      'const bool read = ReadWindowsFileIdentity(work.executable.value, identity);',
    );
    expect(program).toContain('judged = RejudgeWindowsV2Session(source, &not_web, &reason);');
    expect(generated.split('  Sc940RejudgeWorkerStarted();')).toHaveLength(2);
    expect(generated.split('    Sc940RejudgeContextGate(work);')).toHaveLength(2);
    expect(generated.split('    Sc940RejudgeRetired(job_id);')).toHaveLength(2);
    expect(
      generated.split('Sc940RejudgeCancelAttempt(job_id, GetThreadId(state.cancellation_thread));'),
    ).toHaveLength(2);
    const rejudgeHook = program.slice(
      program.indexOf(
        'bool Sc940RejudgeFileIdentity(const WindowsV2RejudgeWork &work, WindowsFileIdentity *identity) {',
      ),
      program.indexOf('std::string Sc940RejudgeProbe(const std::string &metadata) {'),
    );
    expect(rejudgeHook).not.toContain('rejudge_probe_source');
    expect(rejudgeHook).not.toContain('WindowsSession');
    expect(generated).toContain(
      'const HRESULT result = automation->ElementFromHandle(window, &root);',
    );
    expect(
      generated.split('!Sc940StartOpen(target_process->value, process_executable)'),
    ).toHaveLength(2);
    expect(generated.split('    Sc940StartReadyGate();')).toHaveLength(2);
    expect(generated.split('  Sc940StartAdoptGate();')).toHaveLength(2);
    expect(generated.split('        Sc940StartEpilogueGate();')).toHaveLength(2);
    expect(generated.split('    Sc940StartWorkerAttempt();')).toHaveLength(2);
    expect(generated.split('!Sc940ValidationFileIdentity(work, &held_file_identity)')).toHaveLength(
      2,
    );
    expect(generated.split('  Sc940ValidationWorkerStarted();')).toHaveLength(2);
    expect(
      generated.split(
        'Sc940ValidationCancelAttempt(job_id, GetThreadId(state.cancellation_thread));',
      ),
    ).toHaveLength(2);
    expect(generated.split('    Sc940ValidationRetired(job_id);')).toHaveLength(2);
    expect(program).toContain(
      'const bool read = ReadWindowsFileIdentity(work.executable.value, identity);',
    );
    expect(program).toContain('const bool opened = OpenLockedProcessExecutable(process, output);');
    expect(program).toContain('windows_v2_main_pid = GetCurrentProcessId();');
    expect(program).not.toContain('keybd_event(');
    expect(program).toContain('ServePipe(server.value, BackendProbe{})');
    expect(program).not.toMatch(/#define\s+(?:CreateFileW|ReadFile|WriteFile|EnumWindows)\b/u);
  });
});

const build = compiler();
describe.skipIf(
  process.platform !== 'win32' || (build === null && process.env['CI'] === undefined),
)('Windows target I/O live seam (#940 and #820, bounded readers)', () => {
  async function runScenarios(scenarios: readonly string[]) {
    expect(build, 'MSVC is required on Windows CI').not.toBeNull();
    const root = mkdtempSync(join(tmpdir(), 'computer-use-target-io-rca-'));
    let installed: string | undefined;
    try {
      const localAppData = process.env['LOCALAPPDATA'];
      if (!localAppData)
        throw new Error('LOCALAPPDATA is required for the real V2 application root');
      const programs = join(localAppData, 'Programs');
      mkdirSync(programs, { recursive: true });
      installed = mkdtempSync(join(programs, 'sc940-start-'));
      const fixtureAppDirectory = installed;
      const fixtureDirectory = join(nativeDirectory, 'fixtures/win32-acceptance');
      const fixtureExecutable = join(installed, 'sprint-coder-computer-use-fixture.exe');
      const fixtureBuild = await run(
        build!.file,
        build!.args([
          '/nologo',
          '/std:c++20',
          '/EHsc',
          '/O2',
          '/MT',
          '/W4',
          '/GS',
          '/permissive-',
          '/utf-8',
          '/DUNICODE',
          '/D_UNICODE',
          '/DWIN32_LEAN_AND_MEAN',
          '/D_WIN32_WINNT=0x0A00',
          `/I${fixtureDirectory}`,
          join(fixtureDirectory, 'win32_acceptance_fixture.cc'),
          `/Fo:${join(root, 'start-fixture.obj')}`,
          `/Fe:${fixtureExecutable}`,
          '/link',
          '/SUBSYSTEM:WINDOWS,10.00',
          '/MANIFEST:EMBED',
          `/MANIFESTINPUT:${join(fixtureDirectory, 'win32_acceptance_fixture.manifest')}`,
          'user32.lib',
          'gdi32.lib',
          'comctl32.lib',
          'comdlg32.lib',
          'shell32.lib',
        ]),
        400_000,
        build!.verbatim,
      );
      expect(fixtureBuild.timedOut, 'GUI fixture compilation deadline').toBe(false);
      const fixtureCompileErrors = `${fixtureBuild.stdout}\n${fixtureBuild.stderr}`
        .split(/\r?\n/u)
        .filter((line) => /\berror (?:C|LNK)\d+:/u.test(line))
        .map((line) =>
          line
            .replaceAll(root, '<fixture>')
            .replaceAll(fixtureAppDirectory, '<fixture-app>')
            .replaceAll(nativeDirectory, '<native>'),
        )
        .join('\n')
        .slice(0, 8_000);
      expect(
        fixtureBuild.status,
        `Unsigned GUI fixture must compile\n${fixtureCompileErrors}`,
      ).toBe(0);
      const source = join(root, 'seam.cc');
      const binary = join(root, 'seam.exe');
      writeFileSync(join(root, 'instrumented-host.cc'), instrumentedHost());
      writeFileSync(source, program);
      const provenance = join(root, 'provenance.h');
      writeFileSync(
        provenance,
        '#pragma once\n#define SPRINT_CODER_SOURCE_COMMIT "0000000000000000000000000000000000000000"\n',
      );
      const command = build!.args([
        '/nologo',
        '/std:c++20',
        '/EHsc',
        '/W4',
        '/we4062',
        '/sdl',
        '/permissive-',
        '/utf-8',
        '/DUNICODE',
        '/D_UNICODE',
        '/DWIN32_LEAN_AND_MEAN',
        '/DNOMINMAX',
        '/D_WIN32_WINNT=0x0A00',
        '/DSPRINT_CODER_ELIGIBILITY_V2=1',
        `/FI${provenance}`,
        `/I${nativeDirectory}`,
        source,
        `/Fe:${binary}`,
        `/Fo:${binary}.obj`,
        '/link',
        '/DEBUG:NONE',
        'ole32.lib',
        'oleaut32.lib',
        'uiautomationcore.lib',
        'user32.lib',
        'dwmapi.lib',
        'd3d11.lib',
        'dxgi.lib',
        'windowscodecs.lib',
        'bcrypt.lib',
        'advapi32.lib',
        'userenv.lib',
        'crypt32.lib',
        'wintrust.lib',
        'shell32.lib',
        'runtimeobject.lib',
        'windowsapp.lib',
        'uuid.lib',
      ]);
      const compiled = await run(build!.file, command, 500_000, build!.verbatim);
      expect(compiled.timedOut, 'RCA seam compilation deadline').toBe(false);
      const compileErrors = `${compiled.stdout}\n${compiled.stderr}`
        .split(/\r?\n/u)
        .filter((line) => /\berror (?:C|LNK)\d+:/u.test(line))
        .map((line) => line.replaceAll(root, '<fixture>').replaceAll(nativeDirectory, '<native>'))
        .join('\n')
        .slice(0, 8_000);
      expect(compiled.status, `RCA seam must compile with MSVC\n${compileErrors}`).toBe(0);
      const startFailures: string[] = [];
      const validationFailures: string[] = [];
      const rejudgeFailures: string[] = [];
      const resumeFailures: string[] = [];
      for (const scenario of scenarios) {
        const result = await run(
          binary,
          scenario.startsWith('start-') ||
            scenario.startsWith('rejudge-') ||
            scenario.startsWith('resume-')
            ? ['start-coordinator', scenario, fixtureExecutable]
            : [scenario],
          70_000,
        );
        if (scenario.startsWith('resume-')) {
          const failure = /"failure":"([a-z_]+)"/u.exec(result.stdout)?.[1];
          if (result.timedOut || result.status !== 0) {
            resumeFailures.push(
              `${scenario}: ${result.timedOut ? 'outer_watchdog' : (failure ?? 'native_assertion')}`,
            );
            continue;
          }
          try {
            const metadata: unknown = JSON.parse(result.stdout.trim());
            expect(metadata).toMatchObject({
              case: scenario,
              componentIntegrationOnly: !scenario.startsWith('resume-live-'),
              realIdentityAdmissionBaseline: true,
              realListMode: 'observe_only',
              stopMs: expect.any(Number),
              closeMs: expect.any(Number),
              beforeJobs: expect.any(Number),
              afterJobs: expect.any(Number),
              workerThreadsExited: true,
              threadHandlesClosed: true,
              workerThreadsJoined: false,
              joinedThreads: 'pipe-reader-watchdog',
              inputAttempts: scenario === 'resume-live-focus-stop' ? 1 : 0,
              foregroundRequired: scenario.startsWith('resume-live-'),
              healthyResumeRefocusVerified: scenario === 'resume-live-normal',
              focusSetupMinimizedAfterValidation: scenario === 'resume-live-focus-stop',
              minimizedClientBoundsAvailable: expect.any(Boolean),
              publicStartOrGrantVerified: false,
              ticketLifecycleUnitFixture: scenario === 'resume-components',
              preflightOrDispatchVerified: false,
              seedIsDiagnostic: true,
              childExited: true,
              threadsJoined: true,
              workerIdle: true,
              watchdogFired: false,
            });
            console.log(JSON.stringify(metadata));
            console.log(
              JSON.stringify({ case: scenario, kind: 'helper_exit', helperProcessExited: true }),
            );
          } catch {
            resumeFailures.push(`${scenario}: metadata_assertion`);
          }
          continue;
        }
        if (scenario.startsWith('rejudge-')) {
          const failure = /"failure":"([a-z_]+)"/u.exec(result.stdout)?.[1];
          if (result.timedOut || result.status !== 0) {
            rejudgeFailures.push(
              `${scenario}: ${result.timedOut ? 'outer_watchdog' : (failure ?? 'native_assertion')}`,
            );
            continue;
          }
          try {
            const metadata: unknown = JSON.parse(result.stdout.trim());
            expect(metadata).toMatchObject({
              case: scenario,
              componentIntegrationOnly: true,
              realListMode: 'observe_only',
              realBaselineJudgement: true,
              stopMs: expect.any(Number),
              closeMs: expect.any(Number),
              fileReads:
                scenario === 'rejudge-repeat'
                  ? 7
                  : scenario === 'rejudge-cancel' || scenario === 'rejudge-close'
                    ? 3
                    : 2,
              fileReadSuccesses:
                scenario === 'rejudge-repeat'
                  ? 6
                  : scenario === 'rejudge-cancel' || scenario === 'rejudge-close'
                    ? 3
                    : 2,
              retiredJobs:
                scenario === 'rejudge-repeat' ? 10 : scenario === 'rejudge-prequeued-close' ? 2 : 3,
              workerThreads: 1,
              contextCalls: scenario === 'rejudge-cold-context-close' ? 2 : 0,
              lateResultAppliedToSession: false,
              unknownCloseRejected: true,
              inputAttempts: 0,
              foregroundRequired: false,
              healthyStartVerified: false,
              controlSeedIsDiagnostic: true,
              freshRetryIsComponentOnly: true,
              workerJoined: false,
              joinedThreads: 'pipe-reader-watchdog',
              childExited: true,
              threadsJoined: true,
              workerIdle: true,
              watchdogFired: false,
            });
            console.log(JSON.stringify(metadata));
            console.log(
              JSON.stringify({ case: scenario, kind: 'helper_exit', helperProcessExited: true }),
            );
          } catch {
            rejudgeFailures.push(`${scenario}: invalid_metadata`);
          }
          continue;
        }
        if (scenario.startsWith('validation-')) {
          const failure = /"failure":"([a-z_]+)"/u.exec(result.stdout)?.[1];
          if (result.timedOut) {
            validationFailures.push(`${scenario}: outer_watchdog`);
            continue;
          }
          let metadata: unknown;
          try {
            metadata = JSON.parse(result.stdout.trim());
          } catch {
            validationFailures.push(`${scenario}: invalid_metadata`);
            continue;
          }
          console.log(JSON.stringify(metadata));
          if (result.status !== 0) {
            validationFailures.push(`${scenario}: ${failure ?? 'native_assertion'}`);
            continue;
          }
          try {
            expect(metadata).toMatchObject({
              case: scenario,
              primitiveCostOnly: true,
              stopPath: scenario === 'validation-repeat' ? 'none' : 'preflight_validate',
              inputLatencyMeasured: false,
              fixtureProcessPathMatchesHeld: true,
              validationWorkerThreads: 1,
              validationRetiredJobs:
                scenario === 'validation-cancel'
                  ? 18
                  : scenario === 'validation-close'
                    ? 2
                    : scenario === 'validation-repeat'
                      ? 21
                      : 1,
              instrumentedPrimitiveTiming: true,
              validationJobDrained: true,
              duplicateCleanupObserved: true,
              validationWorkerJoined: false,
              joinedThreads: 'pipe-reader-watchdog',
              inputAttempts: 0,
              childExited: true,
              threadsJoined: true,
              workerIdle: true,
              watchdogFired: false,
            });
          } catch {
            validationFailures.push(`${scenario}: metadata_assertion`);
          }
          // Process exit is distinct from the persistent native worker being idle above.
          console.log(
            JSON.stringify({ case: scenario, kind: 'helper_exit', helperProcessExited: true }),
          );
          continue;
        }
        if (scenario.startsWith('start-')) {
          const failure = /"failure":"([a-z_]+)"/u.exec(result.stdout)?.[1];
          if (result.timedOut) {
            startFailures.push(`${scenario}: outer_watchdog`);
            continue;
          }
          let metadata: unknown;
          try {
            metadata = JSON.parse(result.stdout.trim());
          } catch {
            startFailures.push(`${scenario}: invalid_metadata`);
            continue;
          }
          // Preserve Stop-phase evidence even when a later foreground prerequisite is unavailable.
          console.log(JSON.stringify(metadata));
          if (result.status !== 0) {
            startFailures.push(`${scenario}: ${failure ?? 'native_assertion'}`);
            continue;
          }
          try {
            expect(metadata).toMatchObject({
              case: scenario,
              stopProof: scenario !== 'start-healthy',
              lateCleanupVerified: scenario !== 'start-healthy',
              healthyStartVerified:
                scenario === 'start-healthy' || scenario === 'start-open-cancel',
              lateAdoptionDiscarded: scenario !== 'start-healthy',
              slotHandoffVerified: scenario === 'start-healthy',
              inputAttempts: 0,
              childExited: true,
              threadsJoined: true,
              workerIdle: true,
              watchdogFired: false,
            });
          } catch {
            startFailures.push(`${scenario}: metadata_assertion`);
          }
          continue;
        }
        expect(result.timedOut, `${scenario}: outer watchdog`).toBe(false);
        const failure = /^\{"failure":"([a-z_]+)"\}$/u.exec(result.stdout.trim())?.[1];
        expect(result.status, `${scenario}: ${failure ?? 'native RCA assertions'}`).toBe(0);
        const metadata: unknown = JSON.parse(result.stdout.trim());
        if (scenario.startsWith('semantic-stall-')) {
          expect(metadata).toMatchObject({
            case: scenario,
            baselineStallReproduced: scenario.startsWith('semantic-stall-search-'),
            workerOnlyControl: scenario.startsWith('semantic-stall-search-'),
            syntheticContactStall: true,
            actualUiaLatencyMeasured: false,
            heldMs: expect.any(Number),
            readerLatched: !scenario.endsWith('-timeout'),
            receiptBeforeRelease: scenario.startsWith('semantic-stall-dispatch-'),
            receiptAfterRelease: true,
            inputAttempts: 0,
            childExited: true,
            workerIdle: true,
            watchdogFired: false,
          });
          console.log(JSON.stringify(metadata));
          continue;
        }
        if (scenario.startsWith('binding-detail-')) {
          expect(metadata).toMatchObject({
            case: scenario,
            ownedHwndContact: true,
            normalUiaAcceptance: false,
            stopMs: expect.any(Number),
            resourceCleanupVerified: true,
            failureOutputUnchanged: true,
            inputAttempts: 0,
            childExited: true,
            workerIdle: true,
            watchdogFired: false,
          });
          console.log(JSON.stringify(metadata));
          continue;
        }
        if (scenario === 'binding-healthy') {
          expect(metadata).toMatchObject({
            case: scenario,
            ownedHwndContact: true,
            normalFocusAcceptance: false,
            equivalentValues: true,
            duplicateOmitted: true,
            uniquePreserved: true,
            oldOutputReplaced: true,
            nodes: expect.any(Number),
            sequentialWorkers: 4,
            inputAttempts: 0,
            childExited: true,
            workerIdle: true,
            watchdogFired: false,
          });
          console.log(JSON.stringify(metadata));
          continue;
        }
        if (scenario.startsWith('binding-observe-')) {
          expect(metadata).toMatchObject({
            case: scenario,
            observePrerequisitesControlled: true,
            normalUiaAcceptance: false,
            stopMs: expect.any(Number),
            downstreamCaptureCalls: 0,
            inputAttempts: 0,
            childExited: true,
            workerIdle: true,
            watchdogFired: false,
          });
          console.log(JSON.stringify(metadata));
          continue;
        }
        if (scenario.startsWith('binding-read-')) {
          expect(metadata).toMatchObject({
            case: scenario,
            syntheticContactStall: !scenario.includes('-prequeued-'),
            normalUiaAcceptance: false,
            heldMs: expect.any(Number),
            readerLatched: !scenario.endsWith('-timeout'),
            responseBeforeRelease: !scenario.includes('-prequeued-'),
            contactDeadline: scenario.endsWith('-timeout'),
            prequeued: scenario.includes('-prequeued-'),
            slotRecovered: !scenario.includes('-prequeued-'),
            inputAttempts: 0,
            childExited: true,
            workerIdle: true,
            watchdogFired: false,
          });
          console.log(JSON.stringify(metadata));
          continue;
        }
        if (scenario.startsWith('classification-detail-')) {
          expect(metadata).toMatchObject({
            case: scenario,
            controlledOwnedUia: true,
            normalPointFocusAcceptance: false,
            resourceCleanupVerified: true,
            resultPolicyVerified: true,
            inputAttempts: 0,
            childExited: true,
            workerIdle: true,
            watchdogFired: false,
          });
          console.log(JSON.stringify(metadata));
          continue;
        }
        if (scenario.startsWith('classification-')) {
          expect(metadata).toMatchObject({
            case: scenario,
            syntheticContactStall: true,
            actualUiaLatencyMeasured: false,
            readerLatched: !scenario.endsWith('-timeout'),
            receiptBeforeRelease: true,
            canceledByStop: !scenario.endsWith('-timeout'),
            contactDeadline: scenario.endsWith('-timeout'),
            lateResultDiscarded: true,
            slotRecovered: true,
            heldMs: expect.any(Number),
            lateReceiptConfirmed: true,
            inputAttempts: 0,
            childExited: true,
            threadsJoined: true,
            workerIdle: true,
            watchdogFired: false,
          });
          console.log(JSON.stringify(metadata));
          continue;
        }
        if (scenario.startsWith('uia-')) {
          expect(metadata).toMatchObject({
            case: scenario,
            outerStop:
              scenario === 'uia-contact-timeout'
                ? 'timeout'
                : scenario === 'uia-two-reads'
                  ? 'none'
                  : scenario === 'uia-shared-deadline'
                    ? 'budget'
                    : 'canceled',
            lateResultDiscarded: true,
            realContactCleanup: true,
            inputAttempts: 0,
            childExited: true,
            threadsJoined: true,
            workerIdle: true,
            watchdogFired: false,
          });
          console.log(JSON.stringify(metadata));
          continue;
        }
        expect(metadata).toMatchObject({
          case: scenario,
          stopSerialAdvanced: true,
          busyChecked: scenario === 'deadline',
          generationUnchangedOnRefusal: scenario !== 'healthy' && scenario !== 'deadline',
          partialPreserved: scenario === 'deadline',
          coldContextReused: scenario === 'cold-context-deadline',
          fixtureCount: scenario === 'deadline' || scenario === 'deadline-stop-race' ? 2 : 1,
          closeReplayChecked: scenario === 'measure-close',
          recovered: true,
          inputAttempts: 0,
          childExited: true,
          threadsJoined: true,
          workerIdle: true,
          watchdogFired: false,
        });
        console.log(JSON.stringify(metadata));
      }
      expect(
        [...startFailures, ...validationFailures, ...rejudgeFailures, ...resumeFailures],
        'Every native case must pass, including foreground prerequisites',
      ).toEqual([]);
    } finally {
      if (installed)
        rmSync(installed, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
      rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }

  it('bounds semantic dispatch Stop while retaining worker-only resolver stall controls', async () => {
    await runScenarios([
      'semantic-stall-search-cancel',
      'semantic-stall-search-close',
      'semantic-stall-dispatch-cancel',
      'semantic-stall-dispatch-close',
      'semantic-stall-dispatch-timeout',
    ]);
  }, 700_000);

  it('cleans binding and signature COM values after noncontact Stop and measurement faults', async () => {
    await runScenarios([
      'binding-detail-name-cancel',
      'binding-detail-first-child-close',
      'binding-detail-sibling-cancel',
      'binding-detail-runtime-close',
      'binding-detail-release-cancel',
      'binding-detail-apartment-close',
      'binding-detail-name-exception',
      'binding-detail-hash-exception',
    ]);
  }, 700_000);

  it('preserves owned binding values, duplicate IDs and focus signature values across sequential workers', async () => {
    await runScenarios(['binding-healthy']);
  }, 700_000);

  it('stops Observe after a canceled focus signature without entering capture', async () => {
    await runScenarios(['binding-observe-cancel', 'binding-observe-close']);
  }, 700_000);

  it('bounds binding and focused signature Stop without releasing held COM work', async () => {
    await runScenarios([
      'binding-read-bindings-cancel',
      'binding-read-bindings-close',
      'binding-read-signature-cancel',
      'binding-read-signature-close',
      'binding-read-bindings-timeout',
      'binding-read-signature-timeout',
      'binding-read-bindings-prequeued-close',
      'binding-read-signature-prequeued-close',
      'binding-read-bindings-prequeued-same-epoch-close',
      'binding-read-signature-prequeued-same-epoch-close',
    ]);
  }, 700_000);

  it('preserves classification partial results and drains COM resources through noncontact stops and faults', async () => {
    await runScenarios([
      'classification-detail-name-cancel',
      'classification-detail-name-close',
      'classification-detail-parent-cancel',
      'classification-detail-parent-close',
      'classification-detail-signature-cancel',
      'classification-detail-signature-close',
      'classification-detail-partial-result',
      'classification-detail-signature-result',
      'classification-detail-release-cancel',
      'classification-detail-apartment-close',
      'classification-detail-success-release-cancel',
      'classification-detail-success-apartment-close',
      'classification-detail-name-exception',
      'classification-detail-signature-exception',
      'classification-detail-healthy-consecutive',
      'classification-detail-prequeued-close',
      'classification-detail-prequeued-same-epoch-close',
    ]);
  }, 700_000);

  it('bounds classification Stop during a held foreign call and retains worker ownership', async () => {
    await runScenarios([
      'classification-point-cancel',
      'classification-point-close',
      'classification-focused-cancel',
      'classification-focused-close',
      'classification-point-timeout',
      'classification-focused-timeout',
    ]);
  }, 700_000);

  it('bounds list and UIA reads, Stop receipts, inherited budgets, and late cleanup on owned fixtures', async () => {
    await runScenarios([
      'healthy',
      'measure-cancel',
      'measure-close',
      'measure-same-epoch-close',
      'context-cancel',
      'deadline',
      'cold-context-deadline',
      'deadline-stop-race',
      'queued-stop',
      'completion-race',
      'uia-contact-timeout',
      'uia-cancel',
      'uia-close',
      'uia-prequeued-close',
      'uia-two-reads',
      'uia-shared-deadline',
      'start-open-close',
      'start-prequeued-close',
      'start-open-cancel',
      'start-healthy',
      'start-ready-close',
      'start-adopt-close',
      'validation-cancel',
      'validation-close',
      'validation-prequeued-close',
      'validation-repeat',
    ]);
  }, 700_000);

  it('keeps Rejudge Stop responsive, rejects late results, and reuses fresh measurements without input', async () => {
    await runScenarios([
      'rejudge-cancel',
      'rejudge-close',
      'rejudge-prequeued-close',
      'rejudge-repeat',
      'rejudge-cold-context-close',
    ]);
  }, 700_000);

  it('keeps resume measurement Stop responsive and both phases fresh without foreground', async () => {
    await runScenarios([
      'resume-before-cancel',
      'resume-before-close',
      'resume-prequeued-close',
      'resume-after-component-cancel',
      'resume-after-component-close',
      'resume-components',
      'resume-cold-context-close',
    ]);
  }, 700_000);

  it('runs real resume and refocus with foreground, post-focus Stop, and focus-unit ordering', async () => {
    await runScenarios([
      'resume-live-normal',
      'resume-live-after-cancel',
      'resume-live-after-close',
      'resume-live-focus-stop',
    ]);
  }, 700_000);
});
