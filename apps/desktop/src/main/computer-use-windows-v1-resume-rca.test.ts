import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computerUseNativeCloseReceiptSchema } from '@sprint-coder/contracts';
const nativeDirectory = join(__dirname, '../../computer-use-native');
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
type Build = Readonly<{
  wrap: (arguments_: string[]) => { file: string; args: string[]; verbatim: boolean };
}>;

function findBuild(): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return { wrap: (args) => ({ file: 'cl.exe', args, verbatim: false }) };
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
  const root = found.stdout.trim();
  const vcvars = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (found.status !== 0 || root === '' || !existsSync(vcvars)) return null;
  return {
    wrap: (args) => ({
      file: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        `"call "${vcvars}" >nul && cl.exe ${args.map((argument) => `"${argument}"`).join(' ')}"`,
      ],
      verbatim: true,
    }),
  };
}

// Diagnostic only: seed an existing V1 lifetime to reach its legacy executable read.
// No public Start/grant or target-app acceptance is claimed. Reads name only this process
// with a deliberately wrong path; focus/input calls are replaced with failing tripwires.
const nativeSource = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');

function instrumentPendingHost(source: string): string {
  const legacyOpen =
    /OpenLockedProcessExecutable\(target_process\.value,\s*&process_executable\)/gu;
  const workerOpen = /OpenLockedProcessExecutable\(target_process->value,\s*process_executable\)/gu;
  expect([...source.matchAll(legacyOpen)]).toHaveLength(1);
  expect([...source.matchAll(workerOpen)]).toHaveLength(1);
  const conflictMarker = 'if (found != ledger.entries.end() && found->second->digest != digest) {';
  expect(source.split(conflictMarker)).toHaveLength(2);
  return source
    .replace(legacyOpen, 'HoldStartOpen(target_process.value, &process_executable)')
    .replace(workerOpen, 'HoldStartOpen(target_process->value, process_executable)')
    .replace(conflictMarker, conflictMarker + '\n    ObserveRequestConflict();')
    .replaceAll('CloseHandle(', 'TrackHandleClose(')
    .replaceAll('ShowWindow(', 'RcaRefuseShow(')
    .replaceAll('SetForegroundWindow(', 'RcaRefuseForeground(')
    .replaceAll('SendInput(', 'RcaRefuseInput(');
}

it('instruments both identity-read paths without depending on source line wrapping', () => {
  const source = instrumentPendingHost(nativeSource);
  expect(source).toContain('HoldStartOpen(target_process.value, &process_executable)');
  expect(source).toContain('HoldStartOpen(target_process->value, process_executable)');
});

describe.skipIf(process.platform !== 'win32')('Windows V1 existing-start RCA', () => {
  it('reproduces consumer-held identity I/O delaying terminal stop without GUI input', ({
    skip,
  }) => {
    const build = findBuild();
    if (!build) {
      if (process.env.CI) throw new Error('MSVC required');
      skip();
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'sc-v1-resume-rca-'));
    try {
      writeFileSync(join(root, 'pending-host.cc'), instrumentPendingHost(nativeSource));
      const file = join(root, 'seam.cc'),
        binary = join(root, 'seam.exe');
      writeFileSync(file, program);
      const provenance = join(root, 'provenance.h');
      writeFileSync(
        provenance,
        '#pragma once\n#define SPRINT_CODER_SOURCE_COMMIT "0000000000000000000000000000000000000000"\n',
      );
      const command = build.wrap([
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
        '/DSPRINT_CODER_ELIGIBILITY_V2=0',
        `/FI${provenance}`,
        `/I${nativeDirectory}`,
        file,
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
      const compiled = spawnSync(command.file, command.args, {
        encoding: 'utf8',
        windowsVerbatimArguments: command.verbatim,
        timeout: 500000,
        env: { ...process.env, VSLANG: '1033' },
      });
      expect(compiled.status, compiled.stdout + '\n' + compiled.stderr).toBe(0);
      const result = spawnSync(realpathSync.native(binary), [], {
        encoding: 'utf8',
        timeout: 20000,
      });
      expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
      const receipts = result.stdout
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('RECEIPT:'))
        .map((line) => computerUseNativeCloseReceiptSchema.parse(JSON.parse(line.slice(8))));
      expect(receipts.map((receipt) => receipt.sessionId)).toEqual(['pending']);
      expect(receipts[0]!.cancelEpoch).toBeGreaterThan(9);
      expect(receipts[0]!.inputAttemptCount).toBe(0);
      expect(result.stdout).toContain('RCA: V1 existing read blocks receipt for 1000ms');
      expect(result.stdout).toContain(
        'PASS: diagnostic reproduced, actual read and cleanup, no input',
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 540000);
});
const program = String.raw`
#include <atomic>
#include <string>
#include <windows.h>
namespace { struct LockedWindowsExecutable; bool HoldStartOpen(HANDLE process, LockedWindowsExecutable* output); BOOL TrackHandleClose(HANDLE handle); BOOL RcaRefuseShow(HWND, int); BOOL RcaRefuseForeground(HWND); UINT RcaRefuseInput(UINT, LPINPUT, int); }
void ObserveRequestConflict();
#define wmain ProductionHostMain
#include "pending-host.cc"
#undef wmain
#include <iostream>
#include <thread>
using namespace sprint_coder::computer_use;
std::atomic<bool> hold_start{true}, entered_start{false}, finished{false}, conflict_seen{false};
void ObserveRequestConflict(){conflict_seen.store(true);}
void Require(bool ok,const char* message){if(!ok){std::cerr<<"FAIL "<<message<<std::endl;TerminateProcess(GetCurrentProcess(),7);}}
std::atomic<DWORD> consumer_thread{0}, io_thread{0};
std::atomic<unsigned> actual_reads{0}, successful_reads{0}, process_releases{0}, file_releases{0};
std::atomic<HANDLE> tracked_process{nullptr}, tracked_file{INVALID_HANDLE_VALUE};
ScopedKernelHandle held_worker;
namespace {
BOOL RcaRefuseShow(HWND, int) { Require(false,"unexpected show window");return FALSE; }
BOOL RcaRefuseForeground(HWND) { Require(false,"unexpected foreground input");return FALSE; }
UINT RcaRefuseInput(UINT, LPINPUT, int) { Require(false,"unexpected native input");return 0; }
BOOL TrackHandleClose(HANDLE handle) {
  const BOOL closed=::CloseHandle(handle);
  if(closed&&handle!=nullptr&&handle!=INVALID_HANDLE_VALUE) {
    HANDLE expected=handle;if(tracked_process.compare_exchange_strong(expected,nullptr))process_releases.fetch_add(1);
    expected=handle;if(tracked_file.compare_exchange_strong(expected,INVALID_HANDLE_VALUE))file_releases.fetch_add(1);
  }
  return closed;
}
bool HoldStartOpen(HANDLE process, LockedWindowsExecutable* output) {
  Require(process!=nullptr&&GetProcessId(process)==GetCurrentProcessId(),"owned process already opened");
  const bool tracked=hold_start.load();
  if(tracked) {
    tracked_process.store(process);
    io_thread.store(GetCurrentThreadId());
    Require(DuplicateHandle(GetCurrentProcess(),GetCurrentThread(),GetCurrentProcess(),&held_worker.value,SYNCHRONIZE,FALSE,0),"worker handle");
    entered_start.store(true);while(hold_start.load())Sleep(1);
  }
  const bool result=OpenLockedProcessExecutable(process,output);
  if(tracked&&result)tracked_file.store(output->file);
  actual_reads.fetch_add(1);if(result)successful_reads.fetch_add(1);return result;
}
}
FrameId Id(unsigned char value){FrameId id;id.bytes[0]=value;return id;}
std::string Payload(const Frame& frame){return std::string(frame.metadata.begin(),frame.metadata.end());}
void Send(HANDLE pipe,unsigned request,unsigned session,const std::string& payload,MessageType type=MessageType::kProbe){
 FrameHeader header;header.message_type=static_cast<std::uint16_t>(type);header.request_id=Id(static_cast<unsigned char>(request));header.session_id=Id(static_cast<unsigned char>(session));
 Require(WriteFrame(pipe,header,payload),"write frame");
}
Frame Read(HANDLE pipe,unsigned request,MessageType type){Frame frame;Require(ReadFrame(pipe,&frame),"read frame");Require(frame.header.request_id.bytes[0]==request&&frame.header.message_type==static_cast<std::uint16_t>(type),"response identity");return frame;}
std::string Start(const std::string& id,unsigned epoch=0){return "{\"operation\":\"start_session\",\"sessionId\":\""+id+"\",\"pid\":"+std::to_string(GetCurrentProcessId())+",\"windowId\":\"1\",\"cancelEpoch\":"+std::to_string(epoch)+",\"appIdentityDigest\":\""+std::string(64,'a')+"\",\"windowIdentityDigest\":\""+std::string(64,'b')+"\",\"canonicalPath\":\"C:\\\\__sprint_nonexistent__.exe\",\"executableDigest\":\""+std::string(64,'c')+"\",\"signerDigest\":null,\"expectedBoundsX\":0,\"expectedBoundsY\":0,\"expectedBoundsWidth\":100,\"expectedBoundsHeight\":100}";}
std::string Stop(const std::string& id){return "{\"sessionId\":\""+id+"\",\"operation\":\"stop_pending_start\"}";}
int wmain(){
 std::thread([]{Sleep(15000);if(!finished.load())TerminateProcess(GetCurrentProcess(),42);}).detach();
 const auto name=L"\\\\.\\pipe\\sc-pending-start-"+std::to_wstring(GetCurrentProcessId());
 SECURITY_ATTRIBUTES security{}; PSECURITY_DESCRIPTOR descriptor=nullptr;
 Require(BuildCurrentUserPipeSecurity(&security,&descriptor),"pipe security");
 ScopedKernelHandle server(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,65536,65536,0,&security));
 LocalFree(descriptor);Require(server.value!=INVALID_HANDLE_VALUE,"create pipe");
 ScopedKernelHandle connected_event(CreateEventW(nullptr,TRUE,FALSE,nullptr));Require(connected_event.value!=nullptr,"connect event");
 OVERLAPPED connecting{};connecting.hEvent=connected_event.value;
 const BOOL immediate=ConnectNamedPipe(server.value,&connecting);const DWORD connect_error=immediate?ERROR_SUCCESS:GetLastError();
 Require(immediate||connect_error==ERROR_IO_PENDING||connect_error==ERROR_PIPE_CONNECTED,"listen pipe");
 ScopedKernelHandle client(CreateFileW(name.c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr));Require(client.value!=INVALID_HANDLE_VALUE,"open pipe");
 if(!immediate&&connect_error==ERROR_IO_PENDING){DWORD transferred=0;Require(WaitForSingleObject(connected_event.value,5000)==WAIT_OBJECT_0&&GetOverlappedResult(server.value,&connecting,&transferred,FALSE),"connect pipe");}
 ULONG peer=0;Require(GetNamedPipeClientProcessId(server.value,&peer)&&peer==GetCurrentProcessId(),"owned peer");
 std::cerr<<"phase=connected\n"<<std::flush;
 // Diagnostic lifetime only: no valid target or approved grant is constructed.
 std::string seed_reason;auto seed=AdmitWindowsStart(FrameIdKey(Id(7)),"pending","diagnostic-seed",std::string(64,'d'),&seed_reason,9);
 Require(seed&&ClaimWindowsStartInput(seed),"seed diagnostic lifetime");
 WindowsSession existing;existing.session_id="pending";existing.cancel_epoch=9;existing.start_owner=seed->owner;
 existing.input_api_attempts=seed->owner->input_api_attempts;existing.eligibility_basis=EligibilityBasis::kV1Allowlist;
 seed->owner->active=true;sessions.emplace(FrameIdKey(Id(7)),std::move(existing));cancellation_epoch.store(9);seed.reset();
 bool served=false;
 std::thread serve([&]{consumer_thread.store(GetCurrentThreadId());const auto apartment=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);Require(SUCCEEDED(apartment),"COM apartment");BackendProbe probe;served=ServePipe(server.value,probe);CoUninitialize();DisconnectNamedPipe(server.value);});
 Send(client.value,1,7,"{\"protocolVersion\":1,\"apiVersion\":3}",MessageType::kHandshake);Read(client.value,1,MessageType::kHandshakeResult);std::cerr<<"phase=handshake\n"<<std::flush;
 Send(client.value,2,7,Start("pending",9));
 for(int i=0;i<3000&&!entered_start.load();i++)Sleep(1);Require(entered_start.load(),"start gate entered");Require(io_thread.load()==consumer_thread.load(),"legacy identity I/O is on the consumer");std::cerr<<"phase=start-gate\n"<<std::flush;
 const auto stop_started=GetTickCount64();Send(client.value,3,7,Stop("pending"));
 bool latched=false;
 for(int i=0;i<3000&&!latched;i++){{std::lock_guard lock(WindowsTargetListControl().stop_mutex);auto found=WindowsStarts().owners.find(FrameIdKey(Id(7)));latched=found!=WindowsStarts().owners.end()&&found->second->stopped.load();}if(!latched)Sleep(1);}
 std::cerr<<"phase=stop-latch-wait\n"<<std::flush;Require(latched,"reader stop latch");
 // The reader records Stop, but the consumer cannot send a terminal response while held.
 Sleep(1000);DWORD available=0;
 Require(PeekNamedPipe(client.value,nullptr,0,nullptr,&available,nullptr)&&available==0&&hold_start.load(),"no receipt while existing read is held");
 std::cout<<"RCA: V1 existing read blocks receipt for 1000ms\n";
 hold_start.store(false);
 auto rejected=Read(client.value,2,MessageType::kError);Require(Payload(rejected).find("session_target_rejected")!=std::string::npos,"wrong identity stays rejected");
 auto terminal=Read(client.value,3,MessageType::kProbeResult);std::cout<<"RECEIPT:"<<Payload(terminal)<<"\n";
 Require(GetTickCount64()-stop_started>=1000,"diagnostic held interval");
 Require(actual_reads.load()==1&&successful_reads.load()==1&&process_releases.load()==1&&file_releases.load()==1,"actual read and handle cleanup");
 Require(sessions.empty()&&!WindowsTargetListWorkerRunning().load(),"no adopted session or worker");
 std::cerr<<"phase=cleanup\n"<<std::flush;CloseHandle(client.value);client.value=INVALID_HANDLE_VALUE;serve.join();Require(served,"pipe shutdown");
 Require(held_worker.value!=nullptr&&WaitForSingleObject(held_worker.value,0)==WAIT_OBJECT_0,"consumer exited");Require(sessions.empty(),"sessions empty at exit");finished.store(true);std::cout<<"PASS: diagnostic reproduced, actual read and cleanup, no input\n";return 0;
}
`;
