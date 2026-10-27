import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// No target application is started. The real pipe's V1 start is held before OS I/O, then canceled.
// The remaining reads name this process with a deliberately wrong identity and cannot reach focus.
describe.skipIf(process.platform !== 'win32')('Windows API3 pending-start terminal pipe', () => {
  it('closes only admitted owners and prevents queued V1 adoption without GUI input', ({
    skip,
  }) => {
    const build = findBuild();
    if (!build) {
      if (process.env.CI) throw new Error('MSVC required');
      skip();
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'sc-pending-start-'));
    try {
      const source = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
      const marker = '  // Reject a stop observed before V1 synchronous I/O begins.';
      expect(source.split(marker)).toHaveLength(2);
      writeFileSync(
        join(root, 'pending-host.cc'),
        source.replace(marker, '  HoldBeforeStartIo();\n' + marker),
      );
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
      const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 20000 });
      expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
      const receipts = result.stdout
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('RECEIPT:'))
        .map((line) => computerUseNativeCloseReceiptSchema.parse(JSON.parse(line.slice(8))));
      expect(receipts.map((receipt) => receipt.sessionId)).toEqual([
        'pending',
        'pending',
        'other',
        'failed',
      ]);
      expect(receipts[1]!.cancelEpoch).toBeGreaterThan(receipts[0]!.cancelEpoch);
      expect(receipts.every((receipt) => receipt.inputAttemptCount === 0)).toBe(true);
      expect(result.stdout).toContain('PASS: pending pipe, no input, no late adoption');
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 540000);
});
const program = String.raw`
#include <atomic>
#include <string>
void HoldBeforeStartIo();
#define wmain ProductionHostMain
#include "pending-host.cc"
#undef wmain
#include <iostream>
#include <thread>
using namespace sprint_coder::computer_use;
std::atomic<bool> hold_start{true}, entered_start{false}, finished{false};
void Require(bool ok,const char* message){if(!ok){std::cerr<<"FAIL "<<message<<std::endl;TerminateProcess(GetCurrentProcess(),7);}}
void HoldBeforeStartIo(){if(!hold_start.load())return;entered_start.store(true);while(hold_start.load())Sleep(1);}
FrameId Id(unsigned char value){FrameId id;id.bytes[0]=value;return id;}
std::string Payload(const Frame& frame){return std::string(frame.metadata.begin(),frame.metadata.end());}
void Send(HANDLE pipe,unsigned request,unsigned session,const std::string& payload,MessageType type=MessageType::kProbe){
 FrameHeader header;header.message_type=static_cast<std::uint16_t>(type);header.request_id=Id(static_cast<unsigned char>(request));header.session_id=Id(static_cast<unsigned char>(session));
 Require(WriteFrame(pipe,header,payload),"write frame");
}
Frame Read(HANDLE pipe,unsigned request,MessageType type){Frame frame;Require(ReadFrame(pipe,&frame),"read frame");Require(frame.header.request_id.bytes[0]==request&&frame.header.message_type==static_cast<std::uint16_t>(type),"response identity");return frame;}
std::string Start(const std::string& id){return "{\"operation\":\"start_session\",\"sessionId\":\""+id+"\",\"pid\":"+std::to_string(GetCurrentProcessId())+",\"windowId\":\"1\",\"cancelEpoch\":0,\"appIdentityDigest\":\""+std::string(64,'a')+"\",\"windowIdentityDigest\":\""+std::string(64,'b')+"\",\"canonicalPath\":\"C:\\\\__sprint_nonexistent__.exe\",\"executableDigest\":\""+std::string(64,'c')+"\",\"signerDigest\":null,\"expectedBoundsX\":0,\"expectedBoundsY\":0,\"expectedBoundsWidth\":100,\"expectedBoundsHeight\":100}";}
std::string Stop(const std::string& id){return "{\"sessionId\":\""+id+"\",\"operation\":\"stop_pending_start\"}";}
int wmain(){
 std::thread([]{Sleep(15000);if(!finished.load())TerminateProcess(GetCurrentProcess(),42);}).detach();
 const auto name=L"\\\\.\\pipe\\sc-pending-start-"+std::to_wstring(GetCurrentProcessId());
 ScopedKernelHandle server(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT,1,65536,65536,0,nullptr));
 Require(server.value!=INVALID_HANDLE_VALUE,"create pipe");
 bool served=false;
 std::thread serve([&]{Require(ConnectNamedPipe(server.value,nullptr)||GetLastError()==ERROR_PIPE_CONNECTED,"connect pipe");BackendProbe probe;served=ServePipe(server.value,probe);DisconnectNamedPipe(server.value);});
 ScopedKernelHandle client(CreateFileW(name.c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,0,nullptr));Require(client.value!=INVALID_HANDLE_VALUE,"open pipe");
 Send(client.value,1,7,"{\"protocolVersion\":1,\"apiVersion\":3}",MessageType::kHandshake);Read(client.value,1,MessageType::kHandshakeResult);
 Send(client.value,2,7,Start("pending"));
 for(int i=0;i<3000&&!entered_start.load();i++)Sleep(1);Require(entered_start.load(),"start gate entered");
 Send(client.value,3,7,Stop("pending"));
 bool latched=false;
 for(int i=0;i<3000&&!latched;i++){{std::lock_guard lock(WindowsTargetListControl().stop_mutex);auto found=WindowsStarts().owners.find(FrameIdKey(Id(7)));latched=found!=WindowsStarts().owners.end()&&found->second->stopped.load();}if(!latched)Sleep(1);}
 Require(latched,"reader stop latch");DWORD bytes=0;Require(PeekNamedPipe(client.value,nullptr,0,nullptr,&bytes,nullptr)&&bytes==0,"no terminal before consumer drain");
 hold_start.store(false);
 Read(client.value,2,MessageType::kError);
 auto first=Read(client.value,3,MessageType::kProbeResult);std::cout<<"RECEIPT:"<<Payload(first)<<"\n";
 {std::lock_guard lock(WindowsTargetListControl().stop_mutex);Require(sessions.empty(),"no late adoption");}
 const auto serial=WindowsTargetListControl().stop_serial.load(), epoch=cancellation_epoch.load();
 Send(client.value,4,8,Stop("pending"));Read(client.value,4,MessageType::kError);
 Send(client.value,5,7,Stop("wrong"));Read(client.value,5,MessageType::kError);
 Require(WindowsTargetListControl().stop_serial.load()==serial&&cancellation_epoch.load()==epoch,"wrong pair is inert");
 std::string reason;auto other=AdmitWindowsStart(FrameIdKey(Id(9)),"other","test-other",std::string(64,'d'),&reason);Require(other&&ClaimWindowsStartInput(other),"other owner claim");
 Send(client.value,6,7,Stop("pending"));auto replay=Read(client.value,6,MessageType::kProbeResult);std::cout<<"RECEIPT:"<<Payload(replay)<<"\n";
 Require(WindowsTargetListControl().stop_serial.load()==serial&&cancellation_epoch.load()==epoch,"old terminal does not cancel other owner");
 other.reset();
 Send(client.value,7,9,Stop("other"));auto other_stop=Read(client.value,7,MessageType::kProbeResult);std::cout<<"RECEIPT:"<<Payload(other_stop)<<"\n";
 Send(client.value,8,10,Start("failed"));Read(client.value,8,MessageType::kError);
 Send(client.value,9,10,Stop("failed"));auto failed=Read(client.value,9,MessageType::kProbeResult);std::cout<<"RECEIPT:"<<Payload(failed)<<"\n";
 Send(client.value,10,10,"{\"sessionId\":\"failed\",\"operation\":\"stop_pending_start\",\"action\":\"click\"}");Read(client.value,10,MessageType::kError);
 CloseHandle(client.value);client.value=INVALID_HANDLE_VALUE;serve.join();Require(served,"pipe shutdown");
 Require(sessions.empty(),"sessions empty at exit");finished.store(true);std::cout<<"PASS: pending pipe, no input, no late adoption\n";return 0;
}
`;
