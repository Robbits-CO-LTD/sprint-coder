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
import {
  computerUseNativeCloseReceiptSchema,
  computerUseNativeDiscoveryStopReceiptSchema,
} from '@sprint-coder/contracts';
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

// Native integration: a cancellable discovery reads only its own executable; a separate control lifetime stays alive.
// No public Start/grant or target-app acceptance is claimed. Reads name only this process
// with a deliberately wrong path; focus/input calls are replaced with failing tripwires.
const nativeSource = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');

function instrumentPendingHost(source: string): string {
  const from = source.indexOf('bool MeasureWindowsDiscovery(');
  const to = source.indexOf('// END windows cancellable discovery measurement', from);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  let list = source.slice(from, to);
  const open = 'OpenLockedWindowsExecutable(canonical_path, &current_executable)';
  expect(list.split(open)).toHaveLength(2);
  list = list.replace(open, 'HoldListOpen(canonical_path, &current_executable)');
  list = list.replace(
    'LaunchVerifiedExecutable(current_executable, &launched_process.value, work.claim_launch, work.retire_launch)',
    'RcaRefuseLaunch(current_executable, &launched_process.value, work.claim_launch, work.retire_launch)',
  );
  return (source.slice(0, from) + list + source.slice(to))
    .replaceAll('CloseHandle(', 'TrackHandleClose(')
    .replaceAll('ShowWindow(', 'RcaRefuseShow(')
    .replaceAll('SetForegroundWindow(', 'RcaRefuseForeground(')
    .replaceAll('SendInput(', 'RcaRefuseInput(')
    .replaceAll('GetTickCount64() - owner->admitted_at', 'DiscoveryTestNow() - owner->admitted_at');
}

it('holds only the V1 list identity read and trips before any application launch', () => {
  const generated = instrumentPendingHost(nativeSource);
  expect(generated).toContain('HoldListOpen(canonical_path, &current_executable)');
  expect(generated).toContain(
    'RcaRefuseLaunch(current_executable, &launched_process.value, work.claim_launch, work.retire_launch)',
  );
});

describe.skipIf(process.platform !== 'win32')('Windows cancellable discovery terminal pipe', () => {
  it('stops a held discovery without stopping another lifetime or waiting for its read', ({
    skip,
  }) => {
    const build = findBuild();
    if (!build) {
      if (process.env.CI) throw new Error('MSVC required');
      skip();
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'sc-window-discovery-stop-'));
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
      for (const mode of ['stop', 'deadline', 'queue-expired', 'eof', 'cross-owner-stop']) {
        const result = spawnSync(realpathSync.native(binary), [mode], {
          encoding: 'utf8',
          timeout: 20000,
        });
        expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
        if (mode === 'eof') {
          expect(result.stdout).toContain(
            'PASS: EOF latches discovery before held read cleanup, no launch or input',
          );
          continue;
        }
        if (mode === 'deadline')
          expect(result.stdout).toContain('PASS: deadline alone rejects held query before Stop');
        if (mode === 'queue-expired')
          expect(result.stdout).toContain('PASS: twenty queue-expired owners reclaimed before I/O');
        const receipts = result.stdout
          .split(/\r?\n/u)
          .filter((line) => line.startsWith('RECEIPT:'))
          .map((line) =>
            computerUseNativeDiscoveryStopReceiptSchema.parse(JSON.parse(line.slice(8))),
          );
        expect(receipts.map((receipt) => receipt.discoveryId)).toEqual(['discovery:1']);
        expect(receipts[0]!.launchAttemptCount).toBe(0);
        const controlLine = result.stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith('CONTROL:'));
        const control = computerUseNativeCloseReceiptSchema.parse(
          JSON.parse(controlLine!.slice(8)),
        );
        expect(control.sessionId).toBe('pending');
        expect(control.cancelEpoch).toBeGreaterThan(9);
        expect(control.inputAttemptCount).toBe(0);
        expect(result.stdout).toContain(
          mode === 'cross-owner-stop'
            ? 'PASS: terminal owner Stop is served while another discovery remains held'
            : 'PASS: discovery terminal before read release',
        );
        expect(result.stdout).toContain(
          'PASS: owned discovery stopped, late actual read and cleanup, no input',
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 540000);
});
const program = String.raw`
#include <atomic>
#include <functional>
#include <string>
#include <windows.h>
namespace { struct LockedWindowsExecutable; bool HoldListOpen(const std::wstring&, LockedWindowsExecutable*); bool RcaRefuseLaunch(const LockedWindowsExecutable&, HANDLE*, const std::function<bool()>&, const std::function<void()>&); BOOL TrackHandleClose(HANDLE handle); BOOL RcaRefuseShow(HWND, int); BOOL RcaRefuseForeground(HWND); UINT RcaRefuseInput(UINT, LPINPUT, int); }
ULONGLONG DiscoveryTestNow();
void ObserveRequestConflict();
#define wmain ProductionHostMain
#include "pending-host.cc"
#undef wmain
#include <iostream>
#include <thread>
using namespace sprint_coder::computer_use;
std::atomic<bool> hold_start{true}, entered_start{false}, finished{false}, conflict_seen{false};
std::atomic<ULONGLONG> clock_offset{0};
std::atomic<bool> cross_owner_mode{false};
std::atomic<unsigned> open_attempts{0};
ULONGLONG DiscoveryTestNow(){return GetTickCount64()+clock_offset.load();}
void ObserveRequestConflict(){conflict_seen.store(true);}
void Require(bool ok,const char* message){if(!ok){std::cerr<<"FAIL "<<message<<std::endl;TerminateProcess(GetCurrentProcess(),7);}}
std::atomic<DWORD> consumer_thread{0}, io_thread{0};
std::wstring owned_path;
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
bool RcaRefuseLaunch(const LockedWindowsExecutable&, HANDLE*, const std::function<bool()>&, const std::function<void()>&) { Require(false,"unexpected application launch");return false; }
bool HoldListOpen(const std::wstring& path, LockedWindowsExecutable* output) {
  Require(SameWindowsPath(path,owned_path),"list may read only the owned executable");
  const unsigned attempt = open_attempts.fetch_add(1);
  io_thread.store(GetCurrentThreadId());
  if (held_worker.value != nullptr && held_worker.value != INVALID_HANDLE_VALUE) CloseHandle(held_worker.value);
  Require(DuplicateHandle(GetCurrentProcess(),GetCurrentThread(),GetCurrentProcess(),&held_worker.value,SYNCHRONIZE,FALSE,0),"consumer thread handle");
  if (!cross_owner_mode.load() || attempt != 0) {
    entered_start.store(true);while(hold_start.load())Sleep(1);
  }
  const bool read=OpenLockedWindowsExecutable(path,output);
  if(read)tracked_file.store(output->file);
  actual_reads.fetch_add(1);if(read)successful_reads.fetch_add(1);return read;
}
}
FrameId Id(unsigned char value){FrameId id;id.bytes[0]=value;return id;}
std::string Payload(const Frame& frame){return std::string(frame.metadata.begin(),frame.metadata.end());}
void Send(HANDLE pipe,unsigned request,unsigned session,const std::string& payload,MessageType type=MessageType::kProbe){
 FrameHeader header;header.message_type=static_cast<std::uint16_t>(type);header.request_id=Id(static_cast<unsigned char>(request));header.session_id=Id(static_cast<unsigned char>(session));
 Require(WriteFrame(pipe,header,payload),"write frame");
}
Frame Read(HANDLE pipe,unsigned request,MessageType type){Frame frame;Require(ReadFrame(pipe,&frame),"read frame");Require(frame.header.request_id.bytes[0]==request&&frame.header.message_type==static_cast<std::uint16_t>(type),"response identity");return frame;}
std::string List(){return "{\"operation\":\"list_windows_cancellable\",\"discoveryId\":\"discovery:1\",\"canonicalPath\":\""+JsonEscape(Utf8FromWide(owned_path))+"\",\"identityDigest\":\""+std::string(64,'a')+"\",\"executableDigest\":\""+std::string(64,'c')+"\",\"signerDigest\":\"\"}";}
std::string DiscoveryStop(const std::string& id){return "{\"operation\":\"stop_window_discovery\",\"discoveryId\":\""+id+"\"}";}
std::string Stop(const std::string& id){return "{\"sessionId\":\""+id+"\",\"operation\":\"stop_pending_start\"}";}
int wmain(int argc,wchar_t** argv){
 const std::wstring mode=argc>1?argv[1]:L"stop";
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
 ScopedKernelHandle source_process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,GetCurrentProcessId()));
 LockedWindowsExecutable source_executable;Require(source_process.value!=nullptr&&OpenLockedProcessExecutable(source_process.value,&source_executable),"owned source handles");
 WindowsSession existing;existing.session_id="pending";existing.cancel_epoch=9;existing.start_owner=seed->owner;
 existing.pid=GetCurrentProcessId();existing.window=reinterpret_cast<HWND>(static_cast<UINT_PTR>(1));
 Require(ReadProcessStartIdentity(source_process.value,&existing.process_start),"owned source start");
 existing.process_handle=source_process.release();existing.executable_file=source_executable.file;source_executable.file=INVALID_HANDLE_VALUE;
 existing.executable_volume_serial=source_executable.identity.file_identity.volume_serial;existing.executable_file_id=source_executable.identity.file_identity.file_id;
 existing.executable_digest=source_executable.identity.executable_digest;existing.signer_digest=source_executable.identity.signer_digest;existing.policy_language=source_executable.identity.policy_language;
 owned_path=source_executable.identity.path;existing.canonical_path=owned_path;existing.app_identity=std::string(64,'a');existing.window_identity=std::string(64,'b');
 existing.input_api_attempts=seed->owner->input_api_attempts;existing.eligibility_basis=EligibilityBasis::kV1Allowlist;
 seed->owner->active=true;sessions.emplace(FrameIdKey(Id(7)),std::move(existing));cancellation_epoch.store(9);seed.reset();
 bool served=false;
 std::thread serve([&]{consumer_thread.store(GetCurrentThreadId());const auto apartment=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);Require(SUCCEEDED(apartment),"COM apartment");BackendProbe probe;served=ServePipe(server.value,probe);CoUninitialize();DisconnectNamedPipe(server.value);});
 Send(client.value,1,7,"{\"protocolVersion\":1,\"apiVersion\":3}",MessageType::kHandshake);Read(client.value,1,MessageType::kHandshakeResult);std::cerr<<"phase=handshake\n"<<std::flush;
 if(mode==L"cross-owner-stop") {
   cross_owner_mode.store(true);
   // A's owned executable read fails the deliberately wrong identity digest normally.
   // B was submitted before A's failure could make Main schedule Stop(A).
   std::string second=List();const auto id=second.find("discovery:1");
   Require(id!=std::string::npos,"second discovery id");second.replace(id,11,"discovery:2");
   Send(client.value,2,8,List());Send(client.value,4,9,second);
   const auto first=Read(client.value,2,MessageType::kError);
   std::string first_code;Require(ReadJsonString(Payload(first),"code",&first_code),"first error code");
   std::cout<<"RCA: firstErrorCode="<<first_code<<"\n"<<std::flush;
   Require(first_code=="app_identity_changed","first owned read rejects identity");
   const auto waiting=GetTickCount64();while(!entered_start.load()&&GetTickCount64()-waiting<5000)Sleep(1);
   Require(entered_start.load()&&actual_reads.load()==1&&file_releases.load()==1,"second alone holds read");
   const auto serial=WindowsTargetListControl().stop_serial.load();
   {std::lock_guard lock(WindowsTargetListControl().stop_mutex);
     auto a=WindowsDiscoveries().owners.at(FrameIdKey(Id(8)));auto b=WindowsDiscoveries().owners.at(FrameIdKey(Id(9)));
     Require(a->terminal&&!a->launch_in_flight&&a->launch_attempts==0&&!b->terminal&&!b->stopped.load(),"first safe second active");}
   const auto started=GetTickCount64();Send(client.value,3,8,DiscoveryStop("discovery:1"));
   bool latched=false;while(!latched&&GetTickCount64()-started<1000){
     {std::lock_guard lock(WindowsTargetListControl().stop_mutex);latched=WindowsDiscoveries().owners.at(FrameIdKey(Id(8)))->stopped.load();}Sleep(1);}
   Require(latched,"first Stop reader latch");
   std::atomic<bool> received_stop{false},received_second{false};std::string receipt;
   std::thread reader([&]{for(unsigned index=0;index<2;++index){
     Frame frame;Require(ReadFrame(client.value,&frame),"cross-owner response read");
     if(frame.header.request_id.bytes==Id(3).bytes){
       Require(frame.header.session_id.bytes==Id(8).bytes&&frame.header.message_type==static_cast<unsigned>(MessageType::kProbeResult),"first Stop binding");
       receipt=Payload(frame);received_stop.store(true);
     }else{Require(frame.header.request_id.bytes==Id(4).bytes&&frame.header.session_id.bytes==Id(9).bytes&&frame.header.message_type==static_cast<unsigned>(MessageType::kError),"second response binding");received_second.store(true);}
   }});
   while(GetTickCount64()-started<1000&&!received_stop.load())Sleep(1);
   Require(received_stop.load()&&!received_second.load()&&hold_start.load()&&GetTickCount64()-started<1000,"cross-owner Stop before other read release");
   {std::lock_guard lock(WindowsTargetListControl().stop_mutex);Require(!WindowsDiscoveries().owners.at(FrameIdKey(Id(9)))->stopped.load(),"Stop A leaves B running");}
   Require(WindowsTargetListControl().stop_serial.load()==serial&&cancellation_epoch.load()==9,"cross-owner Stop does not invalidate B");
   const auto held_ms=GetTickCount64()-started;
   hold_start.store(false);reader.join();
   Require(received_stop.load()&&received_second.load(),"both responses after release");
   Require(WaitForSingleObject(held_worker.value,5000)==WAIT_OBJECT_0&&actual_reads.load()==2&&successful_reads.load()==2&&file_releases.load()==2&&!WindowsTargetListWorkerRunning().load(),"both actual reads cleaned");
   std::cout<<"RECEIPT:"<<receipt<<"\nRCA: terminal owner Stop heldMs="<<held_ms<<"\n";
   Send(client.value,7,7,Stop("pending"));auto control=Read(client.value,7,MessageType::kProbeResult);std::cout<<"CONTROL:"<<Payload(control)<<"\n";
   CloseHandle(client.value);client.value=INVALID_HANDLE_VALUE;serve.join();Require(served&&sessions.empty(),"cross-owner final cleanup");
   finished.store(true);std::cout<<"PASS: terminal owner Stop is served while another discovery remains held\nPASS: owned discovery stopped, late actual read and cleanup, no input\n";return 0;
 }
 if(mode==L"queue-expired") {
   for(unsigned char index=20;index<40;++index) {
     const std::string id="expired:"+std::to_string(index);std::string reason,response;
     auto admission=AdmitWindowsDiscovery(FrameIdKey(Id(index)),id,"request:"+id,std::string(64,'a'),true,GetTickCount64()-kWindowsDiscoveryBudgetMs-1,&reason);
     Require(admission.lease!=nullptr,"expired admission capacity reclaimed");auto owner=admission.lease->owner;
     Require(!RunWindowsDiscovery(List(),std::move(admission.lease),WindowsTargetListControl().stop_serial.load(),&response,&reason),"queue deadline rejects query");
     Require(owner->terminal&&owner->launch_attempts==0&&owner->references.load()==0&&!WindowsTargetListWorkerRunning().load()&&actual_reads.load()==0,"expired queue creates no I/O or worker");
   }
   Require(WindowsDiscoveries().owners.size()==16,"expired records remain bounded");
   std::cout<<"PASS: twenty queue-expired owners reclaimed before I/O\n";
 }
 Send(client.value,2,8,List());
 for(int i=0;i<3000&&!entered_start.load();i++)Sleep(1);Require(entered_start.load(),"start gate entered");Require(io_thread.load()!=consumer_thread.load(),"list identity I/O is on the worker");std::cerr<<"phase=start-gate\n"<<std::flush;
 const auto serial=WindowsTargetListControl().stop_serial.load();
 if(mode==L"eof") {
   CloseHandle(client.value);client.value=INVALID_HANDLE_VALUE;
   serve.join();Require(!served,"closed pipe cannot publish pending query");
   {std::lock_guard lock(WindowsTargetListControl().stop_mutex);auto owner=WindowsDiscoveries().owners.at(FrameIdKey(Id(8)));Require(owner->stopped.load()&&owner->terminal&&owner->references.load()!=0,"EOF latches discovery while read remains");}
   Require(hold_start.load()&&actual_reads.load()==0&&WindowsTargetListWorkerRunning().load(),"EOF returns without read completion");
   hold_start.store(false);
   Require(WaitForSingleObject(held_worker.value,5000)==WAIT_OBJECT_0&&actual_reads.load()==1&&successful_reads.load()==1&&file_releases.load()==1&&!WindowsTargetListWorkerRunning().load(),"EOF late read cleanup");
   for(auto& entry:sessions)ReleaseWindowsSessionResources(&entry.second);sessions.clear();
   finished.store(true);std::cout<<"PASS: EOF latches discovery before held read cleanup, no launch or input\n";return 0;
 }
 if(mode==L"deadline") {
   clock_offset.store(kWindowsDiscoveryBudgetMs+1);
   auto expired=Read(client.value,2,MessageType::kError);
   Require(Payload(expired).find("window_discovery_unavailable")!=std::string::npos&&hold_start.load()&&actual_reads.load()==0,"deadline rejects before read or Stop");
   {std::lock_guard lock(WindowsTargetListControl().stop_mutex);auto owner=WindowsDiscoveries().owners.at(FrameIdKey(Id(8)));Require(owner->stopped.load()&&owner->terminal&&owner->references.load()!=0,"deadline retains held worker");}
   std::cout<<"PASS: deadline alone rejects held query before Stop\n";
 }
 const auto stop_started=GetTickCount64();Send(client.value,3,8,DiscoveryStop("discovery:1"));
 if(mode!=L"deadline") {
   auto rejected=Read(client.value,2,MessageType::kError);Require(Payload(rejected).find("window_discovery_unavailable")!=std::string::npos,"stopped query rejected");
 }
 auto terminal=Read(client.value,3,MessageType::kProbeResult);std::cout<<"RECEIPT:"<<Payload(terminal)<<"\n";
 Require(GetTickCount64()-stop_started<1000&&hold_start.load()&&actual_reads.load()==0,"terminal before read release");
 {std::lock_guard lock(WindowsTargetListControl().stop_mutex);auto owner=WindowsDiscoveries().owners.at(FrameIdKey(Id(8)));Require(owner->terminal&&owner->stopped.load()&&owner->references.load()!=0&&WindowsTargetListWorkerRunning().load(),"worker ownership retained");Require(sessions.size()==1&&!WindowsStarts().owners.at(FrameIdKey(Id(7)))->stopped.load(),"discovery stop leaves control alive");}
 Require(WindowsTargetListControl().stop_serial.load()==serial&&cancellation_epoch.load()==9,"discovery stop does not alter input epoch or serial");
 Send(client.value,4,9,DiscoveryStop("unknown"));Read(client.value,4,MessageType::kError);
 Send(client.value,5,8,DiscoveryStop("wrong"));Read(client.value,5,MessageType::kError);
 Send(client.value,6,8,List());Read(client.value,6,MessageType::kError);
 Require(actual_reads.load()==0,"duplicate query cannot restart the held read");
 std::cout<<"PASS: discovery terminal before read release\n";
 hold_start.store(false);
 Require(held_worker.value!=nullptr&&WaitForSingleObject(held_worker.value,5000)==WAIT_OBJECT_0,"read worker exits");
 Require(actual_reads.load()==1&&successful_reads.load()==1&&file_releases.load()==1&&!WindowsTargetListWorkerRunning().load(),"late actual read and cleanup");
 {std::lock_guard lock(WindowsTargetListControl().stop_mutex);auto owner=WindowsDiscoveries().owners.at(FrameIdKey(Id(8)));Require(owner->references.load()==0&&owner->launch_attempts==0,"late result cannot regain a lease or launch");}
 Send(client.value,7,7,Stop("pending"));auto control=Read(client.value,7,MessageType::kProbeResult);std::cout<<"CONTROL:"<<Payload(control)<<"\n";
 std::cerr<<"phase=cleanup\n"<<std::flush;CloseHandle(client.value);client.value=INVALID_HANDLE_VALUE;serve.join();Require(served,"pipe shutdown");
 Require(sessions.empty(),"sessions empty at exit");finished.store(true);std::cout<<"PASS: owned discovery stopped, late actual read and cleanup, no input\n";return 0;
}
`;
