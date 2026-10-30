import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const nativeDirectory = join(__dirname, '../../computer-use-native');
const host = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
type Build = Readonly<{ name: string; file: string; args: string[]; verbatim: boolean }>;

function findBuild(path: string, output: string): Build | null {
  if (process.platform !== 'win32') {
    if (spawnSync('clang++', ['--version'], { stdio: 'ignore' }).status !== 0) return null;
    return {
      name: 'clang++',
      file: 'clang++',
      args: [
        '-std=c++20',
        '-Wall',
        '-Wextra',
        '-pthread',
        `-I${nativeDirectory}`,
        path,
        '-o',
        output,
      ],
      verbatim: false,
    };
  }
  const clArguments = [
    '/nologo',
    '/std:c++20',
    '/EHsc',
    '/W4',
    '/permissive-',
    '/utf-8',
    `/I${nativeDirectory}`,
    path,
    `/Fe:${output}`,
    `/Fo:${output}.obj`,
  ];
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return { name: 'cl.exe', file: 'cl.exe', args: clArguments, verbatim: false };
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
    name: 'cl.exe (vcvars64)',
    file: 'cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      `"call "${vcvars}" >nul && cl.exe ${clArguments.map((argument) => `"${argument}"`).join(' ')}"`,
    ],
    verbatim: true,
  };
}

// A long synchronous compiler/native run prevents the worker from receiving Vitest RPC replies.
function runNative(
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    timeout: number;
    windowsVerbatimArguments?: boolean;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({
        status: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        stdout,
        stderr: stderr || error?.message || '',
      });
    });
  });
}

function cut(begin: string, end: string): string {
  const start = host.indexOf(begin);
  const stop = host.indexOf(end, start + begin.length);
  if (start < 0 || stop < 0) throw new Error('UIA worker source boundary changed');
  return host.slice(start, stop);
}
function once(value: string, before: string, after: string): string {
  if (value.split(before).length !== 2) throw new Error('UIA worker hook boundary changed');
  return value.replace(before, after);
}
function workerSource(): string {
  let capture = cut(
    '// BEGIN windows capture read ownership',
    '// END windows capture read ownership',
  );
  capture = once(
    capture,
    'struct WindowsCaptureBytes {',
    'struct WindowsCaptureBytes { WindowsCaptureBytes() { capture_owned_values.fetch_add(1); }',
  );
  capture = once(
    capture,
    '~WindowsCaptureBytes() { std::fill(bytes.begin(), bytes.end(), 0); }',
    '~WindowsCaptureBytes() { std::fill(bytes.begin(), bytes.end(), 0); TestCaptureScrub(bytes); }',
  );
  let engine = cut('// Observation rejects a worker timeout', 'struct WindowsUiaObservationResult');
  engine = once(
    engine,
    '    std::thread([pending, snapshot, preserve_stopped_result, measure = std::move(measure), &running]() mutable {',
    '    TestBeforeSpawn();\n    std::thread([pending, snapshot, preserve_stopped_result, measure = std::move(measure), &running]() mutable {',
  );
  engine = once(
    engine,
    '      std::lock_guard stop_lock(control.stop_mutex);\n      WindowsV1UiaLane &lane',
    '      TestBeforeAdoption(pending->done);\n      std::lock_guard stop_lock(control.stop_mutex);\n      WindowsV1UiaLane &lane',
  );
  return (
    cut(
      'thread_local const std::uint64_t *windows_validation_frame_serial',
      'bool WindowsValidationStillCurrent(',
    ) +
    cut('constexpr DWORD kWindowsV1UiaConnectionTimeoutMs', '// The ONE place') +
    cut('enum class WindowsV1UiaStop', '// Why the path ended, now') +
    host.slice(
      host.indexOf('void WindowsV1UiaCountNode()'),
      host.indexOf('\n}', host.indexOf('void WindowsV1UiaCountNode()')) + 2,
    ) +
    engine +
    capture +
    cut(
      '// BEGIN windows semantic operation ownership',
      '// END windows semantic operation ownership',
    )
  );
}

it('preserves UIA result policy, stop ordering and resource retirement in the shared read engine', async ({
  skip,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'sc-uia-read-engine-'));
  try {
    const source = join(root, 'seam.cc');
    const binary = join(root, process.platform === 'win32' ? 'seam.exe' : 'seam');
    const compiler = findBuild(source, binary);
    if (compiler === null) {
      if (process.env.CI) throw new Error('Native compiler required');
      skip();
      return;
    }
    writeFileSync(source, preamble + workerSource() + program);
    const compiled = await runNative(compiler.file, compiler.args, {
      encoding: 'utf8',
      timeout: 120000,
      windowsVerbatimArguments: compiler.verbatim,
    });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const result = await runNative(binary, [], { encoding: 'utf8', timeout: 20000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS: UIA read engine policies and ownership');
    expect(result.stdout).toContain('PASS: capture slot, lane, output, Runtime and Stop policies');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 150000);

// Portable control-logic evidence only. COM initialization/cleanup are controlled stubs;
// the Windows pipe/real-UIA seams independently validate the actual OS boundary.
const preamble = String.raw`
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cwchar>
#include <functional>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>
using HRESULT=std::int32_t;
using DWORD=std::uint32_t;
using HWND=void*;
#define SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE 1
std::atomic<unsigned> capture_owned_values{0},capture_scrubs{0},capture_calls{0},runtime_inits{0},runtime_uninits{0};
std::atomic<bool> capture_scrubbed{true},fail_runtime{false};
std::function<bool(HWND,std::vector<std::uint8_t>*,std::size_t*,std::size_t*)> capture_measure;
void TestCaptureScrub(const std::vector<std::uint8_t>& bytes){
  if(!std::all_of(bytes.begin(),bytes.end(),[](auto value){return value==0;}))capture_scrubbed=false;
  capture_scrubs.fetch_add(1);capture_owned_values.fetch_sub(1);
}
namespace winrt {
enum class apartment_type {multi_threaded};
void init_apartment(apartment_type){runtime_inits.fetch_add(1);if(fail_runtime)throw std::runtime_error("runtime init fault");}
void uninit_apartment(){runtime_uninits.fetch_add(1);}
}
bool CaptureWindowWithGraphicsCaptureOnWorker(HWND window,std::vector<std::uint8_t>* bytes,std::size_t* width,std::size_t* height){
  capture_calls.fetch_add(1);return capture_measure(window,bytes,width,height);
}
void Sleep(DWORD milliseconds){std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));}
struct WindowsSession {std::string session_id;std::shared_ptr<std::atomic<std::uint64_t>> input_api_attempts=std::make_shared<std::atomic<std::uint64_t>>(0);};
using BSTR=wchar_t*;
struct RECT { long left=0,top=0,right=0,bottom=0; };
constexpr HRESULT S_OK=0,E_ABORT=static_cast<HRESULT>(0x80004004),E_FAIL=static_cast<HRESULT>(0x80004005);
constexpr unsigned COINIT_MULTITHREADED=0;
constexpr bool SUCCEEDED(HRESULT value){return value>=0;}
constexpr bool FAILED(HRESULT value){return value<0;}
std::size_t SysStringLen(BSTR text){return text==nullptr?0:std::wcslen(text);}
struct Control { std::mutex stop_mutex; std::atomic<std::uint64_t> stop_serial{0}; };
Control& WindowsTargetListControl(){static auto* control=new Control;return *control;}
std::atomic<std::uint64_t> cancellation_epoch{0};
std::atomic<bool> parent_process_dead{false};
struct Gate {
  std::mutex mutex;std::condition_variable ready;bool entered=false,released=false;
  void Hold(){std::unique_lock lock(mutex);entered=true;ready.notify_all();ready.wait(lock,[&]{return released;});}
  bool Wait(){std::unique_lock lock(mutex);return ready.wait_for(lock,std::chrono::seconds(2),[&]{return entered;});}
  void Release(){std::lock_guard lock(mutex);released=true;ready.notify_all();}
};
std::vector<std::weak_ptr<Gate>> all_gates;
std::shared_ptr<Gate> MakeGate(){auto gate=std::make_shared<Gate>();all_gates.push_back(gate);return gate;}
void ReleaseAll(){for(auto& weak:all_gates)if(auto gate=weak.lock())gate->Release();}
std::shared_ptr<Gate> cleanup_gate,adoption_gate;
std::atomic<unsigned> initialized{0},cleanup_entered{0},cleaned{0};
std::atomic<bool> fail_thread{false},fail_init{false};
HRESULT CoInitializeEx(void*,unsigned){initialized.fetch_add(1);return fail_init.load()?E_FAIL:S_OK;}
void CoUninitialize(){cleanup_entered.fetch_add(1);if(cleanup_gate)cleanup_gate->Hold();cleaned.fetch_add(1);}
void TestBeforeSpawn(){if(fail_thread.load())throw std::runtime_error("synthetic thread creation failure");}
void TestBeforeAdoption(bool done){if(done&&adoption_gate)adoption_gate->Hold();}
`;
const program = String.raw`
void Check(bool ok,const char* name){if(!ok)throw std::runtime_error(name);}
bool Drain(){const auto until=std::chrono::steady_clock::now()+std::chrono::seconds(2);while(WindowsUiaReadWorkerRunning().load()&&std::chrono::steady_clock::now()<until)std::this_thread::sleep_for(std::chrono::milliseconds(1));return !WindowsUiaReadWorkerRunning().load();}
bool DrainCapture(){const auto until=std::chrono::steady_clock::now()+std::chrono::seconds(2);while((WindowsCaptureWorkerRunning().load()||capture_owned_values.load()!=0)&&std::chrono::steady_clock::now()<until)Sleep(1);return !WindowsCaptureWorkerRunning().load()&&capture_owned_values==0;}
bool CaptureValue(HWND,std::vector<std::uint8_t>* bytes,std::size_t* width,std::size_t* height){*bytes={1,2,3,4};*width=2;*height=2;return true;}
void Reset(){ReleaseAll();Check(Drain()&&DrainCapture(),"previous worker drained");cleanup_gate.reset();adoption_gate.reset();all_gates.clear();initialized=0;cleanup_entered=0;cleaned=0;fail_thread=false;fail_init=false;cancellation_epoch=0;parent_process_dead=false;WindowsTargetListControl().stop_serial=0;capture_measure=CaptureValue;capture_calls=0;capture_scrubs=0;capture_scrubbed=true;runtime_inits=0;runtime_uninits=0;fail_runtime=false;}
void Stop(bool epoch=true){auto& c=WindowsTargetListControl();std::lock_guard lock(c.stop_mutex);c.stop_serial.fetch_add(1);if(epoch)cancellation_epoch.fetch_add(1);}
struct Sample {bool secure=false,complete=false;std::string signature;};
struct Outcome {bool ok=false;Sample value;WindowsV1UiaStop stop=WindowsV1UiaStop::kNone;std::size_t nodes=0;};
using Measure=std::function<std::optional<Sample>()>;
struct Consumer {
  std::promise<Outcome> promise;std::future<Outcome> future=promise.get_future();std::thread thread;
  Consumer(Measure measure,bool preserve=true,int budget=0,std::size_t initial_nodes=0){
    const auto before=cleaned.load();
    thread=std::thread([this,measure=std::move(measure),preserve,budget,initial_nodes,before]{
      try {
        WindowsValidationFrameScope frame(0);
        const WindowsV1UiaPath path(std::chrono::milliseconds(budget),0);
        for(std::size_t i=0;i<initial_nodes;++i)WindowsV1UiaCountNode();
        Outcome out;
        out.ok=RunWindowsUiaRead<Sample>(preserve,measure,[&](Sample value){Check(cleaned.load()>before,"result adopted before cleanup");out.value=std::move(value);});
        out.stop=path.Stop();out.nodes=path.Nodes();promise.set_value(std::move(out));
      } catch (...) {promise.set_exception(std::current_exception());}
    });
  }
  bool Ready(int ms=1000){return future.wait_for(std::chrono::milliseconds(ms))==std::future_status::ready;}
  Outcome Take(){Check(Ready(),"consumer response deadline");return future.get();}
  ~Consumer(){ReleaseAll();if(thread.joinable())thread.join();}
};
Sample Value(){return {true,true,"signature"};}
struct SemanticOutcome {bool accepted=false,threw=false;HRESULT result=E_FAIL;};
struct SemanticCall {
  std::promise<SemanticOutcome> promise;std::future<SemanticOutcome> future=promise.get_future();std::thread thread;
  SemanticCall(std::shared_ptr<WindowsSemanticPending> pending,std::function<HRESULT()> action,bool validate=false){
    thread=std::thread([this,pending,action=std::move(action),validate]{
      windows_semantic_operation=pending.get();windows_uia_read_progress=pending.get();
      const WindowsV1UiaPath path(std::chrono::milliseconds::zero(),0,0);
      SemanticOutcome out;
      try {if(!validate||AwaitWindowsSemanticValidation())out.result=InvokeWindowsSemanticInput(action,&out.accepted);}
      catch(...){out.threw=true;}
      windows_semantic_operation=nullptr;windows_uia_read_progress=nullptr;promise.set_value(out);
    });
  }
  SemanticOutcome Take(){Check(future.wait_for(std::chrono::seconds(2))==std::future_status::ready,"semantic call returned");return future.get();}
  ~SemanticCall(){ReleaseAll();if(thread.joinable())thread.join();}
};
std::shared_ptr<WindowsSemanticPending> SemanticOwner(WindowsSession& session){
  auto pending=std::make_shared<WindowsSemanticPending>();pending->session_id=session.session_id;pending->attempts=session.input_api_attempts;
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);WindowsSemanticOperations().active=pending;return pending;
}
void SemanticPolicies(){
  for(int invalid=0;invalid<3;++invalid){Reset();WindowsSession session{"semantic"};auto pending=SemanticOwner(session);
    std::uint64_t count=99;if(invalid==0)Check(StopWindowsSemanticInput(session,&count)&&count==0,"preclaim Stop is drained");
    else if(invalid==1)Stop(false);else parent_process_dead=true;
    unsigned calls=0;{SemanticCall call(pending,[&]{++calls;return S_OK;});const auto out=call.Take();Check(!out.accepted&&out.result==E_ABORT&&calls==0&&*session.input_api_attempts==0,"preclaim invalidity cannot enter input");}}
  Reset();{WindowsSession session{"semantic"},other{"other"};auto pending=SemanticOwner(session);auto gate=MakeGate();unsigned calls=0;
    {SemanticCall call(pending,[&]{++calls;gate->Hold();return S_OK;});Check(gate->Wait()&&WindowsSemanticInputInFlight(),"claimed API held");
      std::uint64_t count=99;Check(StopWindowsSemanticInput(other,&count)&&count==0&&WindowsSemanticInputInFlight(),"another owner receipt does not retire this input");
      Check(!StopWindowsSemanticInput(session,&count)&&*session.input_api_attempts==1,"in-flight Stop is not drained");
      gate->Release();const auto out=call.Take();Check(out.accepted&&!out.threw&&calls==1&&!WindowsSemanticInputInFlight(),"API return retires claim");
      Check(StopWindowsSemanticInput(session,&count)&&count==1,"returned API has stable attempt receipt");}}
  Reset();{WindowsSession session{"semantic"};auto pending=SemanticOwner(session);
    {SemanticCall call(pending,[]{throw std::runtime_error("input fault");return E_FAIL;});const auto out=call.Take();std::uint64_t count=0;
      Check(out.accepted&&out.threw&&!WindowsSemanticInputInFlight()&&StopWindowsSemanticInput(session,&count)&&count==1,"exception retires input claim without claiming success");}}
  for(bool allow:{false,true}){Reset();WindowsSession session{"semantic"};auto pending=SemanticOwner(session);unsigned calls=0;
    {SemanticCall call(pending,[&]{++calls;return S_OK;},true);{
      std::unique_lock lock(pending->mutex);Check(pending->ready.wait_for(lock,std::chrono::seconds(2),[&]{return pending->validation_requested;}),"worker requests consumer validation");
      Check(*session.input_api_attempts==0,"no input before validation");pending->validation=allow;pending->ready.notify_all();}
      const auto out=call.Take();Check(out.accepted==allow&&calls==(allow?1u:0u),"only successful consumer validation permits claim");}}
  Reset();{WindowsSession session{"semantic"};auto pending=SemanticOwner(session);auto gate=MakeGate();
    std::future<void> drain;
    SemanticCall call(pending,[&]{gate->Hold();return S_OK;});Check(gate->Wait(),"exit-drain claimed input held");
    drain=std::async(std::launch::async,[]{DrainWindowsSemanticInputForExit();});
    Check(drain.wait_for(std::chrono::milliseconds(40))==std::future_status::timeout,"normal helper exit waits for claimed API return");
    gate->Release();Check(call.Take().accepted,"exit-drain input returned");Check(drain.wait_for(std::chrono::seconds(1))==std::future_status::ready,"normal exit drain completed");drain.get();}
  {std::lock_guard lock(WindowsTargetListControl().stop_mutex);WindowsSemanticOperations().active.reset();}
  Reset();std::cout<<"PASS: semantic input claim, Stop, validation and exit ownership\n";
}
struct CaptureOutcome {
  bool ok=false,parent_preserved=false;
  WindowsV1UiaStop stop=WindowsV1UiaStop::kNone;
  std::vector<std::uint8_t> bytes{7,9};std::size_t width=99,height=77;
};
struct CaptureCall {
  std::promise<CaptureOutcome> promise;std::future<CaptureOutcome> future=promise.get_future();std::thread thread;
  CaptureCall(WindowsV1UiaStop prior=WindowsV1UiaStop::kNone,int budget=0){
    thread=std::thread([this,prior,budget]{try{
      const WindowsValidationFrameScope frame(0);
      const WindowsV1UiaPath path(std::chrono::milliseconds(budget),0,0);
      auto* parent=windows_v1_uia_lane;parent->stop=prior;parent->nodes=7;
      const auto before=*parent;CaptureOutcome out;
      out.ok=CaptureWindowWithGraphicsCapture(nullptr,0,frame.StopSerial(),&out.bytes,&out.width,&out.height,&out.stop);
      out.parent_preserved=windows_v1_uia_lane==parent&&parent->stop==before.stop&&parent->nodes==before.nodes&&parent->has_deadline==before.has_deadline&&(!before.has_deadline||parent->deadline==before.deadline);
      promise.set_value(std::move(out));
    }catch(...){promise.set_exception(std::current_exception());}});
  }
  bool Ready(int ms=1000){return future.wait_for(std::chrono::milliseconds(ms))==std::future_status::ready;}
  CaptureOutcome Take(){Check(Ready(),"capture consumer deadline");return future.get();}
  ~CaptureCall(){ReleaseAll();if(thread.joinable())thread.join();}
};
void CapturePolicies(){
  Reset();WindowsUiaReadWorkerRunning()=true;{
    CaptureCall call(WindowsV1UiaStop::kTimeout,1000);const auto out=call.Take();
    Check(out.ok&&out.bytes==std::vector<std::uint8_t>({1,2,3,4})&&out.width==2&&out.height==2&&out.parent_preserved,"capture independent of prior UIA timeout and busy slot");
    Check(WindowsUiaReadWorkerRunning()&&!WindowsCaptureWorkerRunning()&&runtime_inits==1&&runtime_uninits==1&&capture_scrubbed,"capture released only its own slot and Runtime");
  }WindowsUiaReadWorkerRunning()=false;
  for(auto prior:{WindowsV1UiaStop::kCanceled,WindowsV1UiaStop::kBudget}){Reset();CaptureCall call(prior);const auto out=call.Take();
    Check(!out.ok&&out.bytes.empty()&&out.width==99&&out.height==77&&out.stop==prior&&out.parent_preserved&&initialized==0,"capture preserves prior cancel/budget without spawn");}
  for(bool implicit:{false,true}){Reset();const WindowsValidationFrameScope frame(implicit?std::nullopt:std::optional<std::uint64_t>{0});Stop(false);
    CaptureOutcome out;out.ok=CaptureWindowWithGraphicsCapture(nullptr,0,WindowsValidationFrameStopSerial(),&out.bytes,&out.width,&out.height,&out.stop);
    Check(!out.ok&&out.stop==WindowsV1UiaStop::kCanceled&&out.bytes.empty()&&initialized==0&&windows_v1_uia_lane==nullptr,"capture refuses original explicit or implicit frame before spawn");}
  Reset();cancellation_epoch=1;{const WindowsV1UiaPath parent(std::chrono::milliseconds::zero(),1,0);CaptureOutcome out;
    out.ok=CaptureWindowWithGraphicsCapture(nullptr,0,0,&out.bytes,&out.width,&out.height,&out.stop);
    Check(!out.ok&&out.stop==WindowsV1UiaStop::kCanceled&&initialized==0&&parent.Stop()==WindowsV1UiaStop::kNone,"capture does not replace old session epoch with newer global epoch");}
  for(int ending=0;ending<3;++ending){Reset();auto gate=MakeGate();capture_measure=[gate](auto window,auto bytes,auto width,auto height){CaptureValue(window,bytes,width,height);gate->Hold();return true;};{
    CaptureCall call(WindowsV1UiaStop::kNone,ending==2?100:0);Check(gate->Wait(),"capture held");
    if(ending!=2){CaptureOutcome rejected;
      rejected.ok=CaptureWindowWithGraphicsCapture(nullptr,0,0,&rejected.bytes,&rejected.width,&rejected.height,&rejected.stop);
      Check(!rejected.ok&&rejected.bytes.empty()&&windows_v1_uia_lane==nullptr&&capture_calls==1&&WindowsCaptureWorkerRunning(),"second capture busy without freeing first slot");
      // Consumer's cleanup helper releases all gates; use the engine directly to leave the other
      // capture's foreign-call gate held while checking independent UIA admission.
      {const WindowsValidationFrameScope frame(0);const WindowsV1UiaPath path;bool adopted=false;
        const bool ok=RunWindowsUiaRead<Sample>(true,[]{return std::optional<Sample>{Value()};},[&](Sample){adopted=true;});
        Check(ok&&adopted,"UIA remains available while capture busy");}
      Stop(ending==0);
    }
    const auto out=call.Take();Check(!out.ok&&out.bytes.empty()&&out.width==99&&out.height==77&&out.parent_preserved&&out.stop==(ending==2?WindowsV1UiaStop::kBudget:WindowsV1UiaStop::kCanceled),"capture Stop/deadline does not publish bytes");
    Check(WindowsCaptureWorkerRunning()&&runtime_uninits==0,"capture owns Runtime until foreign work retires");gate->Release();Check(DrainCapture()&&runtime_inits==1&&runtime_uninits==1&&capture_scrubbed,"late capture bytes scrubbed and Runtime retired");
  }}
  Reset();capture_measure=[](auto w,auto b,auto x,auto y){Sleep(550);return CaptureValue(w,b,x,y);};{CaptureCall call;Check(call.Take().ok,"capture does not inherit UIA 470ms contact timeout");}
  for(int fault=0;fault<4;++fault){Reset();if(fault==0)fail_thread=true;else if(fault==1)fail_init=true;else if(fault==2)fail_runtime=true;else capture_measure=[](auto w,auto b,auto x,auto y){CaptureValue(w,b,x,y);throw std::runtime_error("capture fault");return false;};
    CaptureCall call;const auto out=call.Take();Check(!out.ok&&out.bytes.empty()&&out.width==99&&out.height==77&&out.parent_preserved&&DrainCapture(),"capture fault restores TLS and output/slot ownership");
    Check(runtime_uninits==(fault==3?1u:0u),"only successful Runtime init is uninitialized");}
  Reset();cleanup_gate=MakeGate();{CaptureCall call;Check(cleanup_gate->Wait()&&!call.Ready(30),"capture waits for apartment cleanup");Stop(false);const auto out=call.Take();
    Check(!out.ok&&out.parent_preserved&&WindowsCaptureWorkerRunning(),"cleanup Stop retains capture slot");cleanup_gate->Release();Check(DrainCapture(),"capture cleanup eventually retires");}
  Reset();adoption_gate=MakeGate();{CaptureCall call;Check(adoption_gate->Wait(),"capture adoption gate");Stop(false);adoption_gate->Release();const auto out=call.Take();
    Check(!out.ok&&out.stop==WindowsV1UiaStop::kCanceled&&out.bytes.empty()&&out.parent_preserved&&DrainCapture()&&capture_scrubbed,"Stop wins against complete capture before adoption");}
  Reset();std::cout<<"PASS: capture slot, lane, output, Runtime and Stop policies\n";
}
int main(){try {
  // Same-epoch prequeued Close must use the frame's old serial, not the current global one.
  Reset();{WindowsValidationFrameScope frame(0);Stop(false);const WindowsV1UiaPath path;bool adopted=false;
    Check(!RunWindowsUiaRead<Sample>(true,[]{return std::optional<Sample>{Value()};},[&](Sample){adopted=true;}),"stale frame refused");
    Check(path.Stop()==WindowsV1UiaStop::kCanceled&&!adopted&&initialized==0,"prequeued close created no worker");}
  // Cancel, same-epoch Close and parent death interrupt a held non-contact read.
  for(int mode=0;mode<3;++mode){Reset();auto gate=MakeGate();std::atomic<unsigned> after_calls{0};{
    Consumer call([gate,&after_calls]{int value=0;WindowsV1UiaRead(value,[&]{gate->Hold();value=7;return S_OK;});
      WindowsV1UiaRead(value,[&]{after_calls.fetch_add(1);return S_OK;});return std::optional<Sample>{Value()};});
    Check(gate->Wait(),"property gate entered");if(mode==2)parent_process_dead=true;else Stop(mode==0);
    const auto out=call.Take();Check(!out.ok&&out.stop==WindowsV1UiaStop::kCanceled&&out.value.signature.empty(),"external stop rejected held property");
    Check(WindowsUiaReadWorkerRunning().load()&&cleaned==0,"stop retained worker");
    if(mode!=2){const WindowsV1UiaPath fresh;bool ran=false;
      Check(!RunWindowsUiaRead<Sample>(true,[&]{ran=true;return std::optional<Sample>{Value()};},[](Sample){}),"busy read refused");
      Check(!ran&&initialized==1&&fresh.Stop()==WindowsV1UiaStop::kTimeout,"busy stopped outer lane without another worker");}
    if(mode!=2){const WindowsV1UiaPath observation;bool ran=false;
      Check(!RunWindowsUiaRead<Sample>(false,[&]{ran=true;return std::optional<Sample>{Value()};},[](Sample){}),"observation busy refused");
      Check(!ran&&initialized==1&&observation.Stop()==WindowsV1UiaStop::kNone,"observation busy keeps existing unavailable reason");}
    gate->Release();Check(Drain()&&after_calls==0&&cleaned==1,"late work discarded and cleaned once");
  }}
  // Classification retains a fully returned measurement and its internal first stop.
  Reset();{Consumer call([]{WindowsV1UiaOk(kWindowsV1UiaTimeoutResult);return std::optional<Sample>{{true,false,"partial"}};});
    const auto out=call.Take();Check(out.ok&&out.value.secure&&!out.value.complete&&out.value.signature=="partial"&&out.stop==WindowsV1UiaStop::kTimeout,"partial result and internal stop retained");}
  // Normal observation rejects the internal stop before cleanup; classification waits for cleanup,
  // but still responds to external Close with the first (internal timeout) reason.
  for(bool preserve:{false,true}){Reset();cleanup_gate=MakeGate();{
    Consumer call([]{WindowsV1UiaOk(kWindowsV1UiaTimeoutResult);return std::optional<Sample>{Value()};},preserve);
    Check(cleanup_gate->Wait(),"cleanup gate entered");
    if(preserve){Check(!call.Ready(50),"classification not published before cleanup");Stop(false);}
    const auto out=call.Take();Check(!out.ok&&out.stop==WindowsV1UiaStop::kTimeout&&out.value.signature.empty(),"cleanup stop policy");
    Check(cleaned==0&&WindowsUiaReadWorkerRunning().load(),"cleanup retains slot");cleanup_gate->Release();Check(Drain()&&cleaned==1,"cleanup retired once");
  }}
  // A successful measurement is also abandoned if Stop arrives while cleanup is held.
  for(bool cancel:{false,true}){Reset();cleanup_gate=MakeGate();{
    Consumer call([]{return std::optional<Sample>{Value()};});
    Check(cleanup_gate->Wait()&&!call.Ready(50),"successful measurement waits for cleanup");Stop(cancel);
    const auto out=call.Take();Check(!out.ok&&!out.value.secure&&out.value.signature.empty()&&out.stop==WindowsV1UiaStop::kCanceled,"successful late result not adopted after cleanup Stop");
    Check(cleaned==0&&WindowsUiaReadWorkerRunning().load(),"successful cleanup retains slot");cleanup_gate->Release();Check(Drain()&&cleaned==1,"successful stopped cleanup retired once");
  }}
  // Slow but nonempty property results are not turned into a timeout.
  Reset();{Consumer call([]{int value=0;const bool ok=WindowsV1UiaRead(value,[&]{std::this_thread::sleep_for(std::chrono::milliseconds(320));value=7;return S_OK;});
    return ok?std::optional<Sample>{Value()}:std::nullopt;});const auto out=call.Take();Check(out.ok&&out.stop==WindowsV1UiaStop::kNone,"slow nonempty answer preserved");}
  // First contacts alone keep the existing 470ms refusal, even without a Stop request.
  Reset();{auto gate=MakeGate();Consumer call([gate]{int value=0;WindowsV1UiaContact(value,[&]{gate->Hold();value=7;return S_OK;});return std::optional<Sample>{Value()};});
    Check(gate->Wait(),"contact gate entered");const auto out=call.Take();Check(!out.ok&&out.stop==WindowsV1UiaStop::kTimeout&&cleaned==0,"contact deadline releases consumer only");gate->Release();Check(Drain(),"contact drained");}
  // The inherited absolute budget and cumulative nodes survive the worker handoff.
  Reset();{auto gate=MakeGate();Consumer call([gate]{WindowsV1UiaCountNode();WindowsV1UiaCountNode();gate->Hold();return std::optional<Sample>{Value()};},true,80,3);
    Check(gate->Wait(),"budget gate entered");const auto out=call.Take();Check(!out.ok&&out.stop==WindowsV1UiaStop::kBudget&&out.nodes==5,"absolute budget and node accounting");gate->Release();Check(Drain(),"budget worker drained");}
  // Worker creation and COM initialization failures cannot leave the slot occupied or a live lane.
  for(bool preserve:{false,true}) {
    const auto failure_stop=preserve?WindowsV1UiaStop::kTimeout:WindowsV1UiaStop::kNone;
    Reset();fail_thread=true;{Consumer call([]{return std::optional<Sample>{Value()};},preserve);const auto out=call.Take();Check(!out.ok&&out.stop==failure_stop&&!WindowsUiaReadWorkerRunning().load()&&initialized==0,"thread creation failure retired slot");}
    Reset();fail_init=true;{Consumer call([]{return std::optional<Sample>{Value()};},preserve);const auto out=call.Take();Check(!out.ok&&out.stop==failure_stop&&initialized==1&&cleaned==0&&!WindowsUiaReadWorkerRunning().load(),"failed apartment not uninitialized");}
  }
  Reset();std::atomic<unsigned> destructed{0};{Consumer call([&]() -> std::optional<Sample>{struct Resource{std::atomic<unsigned>& count;~Resource(){++count;}} resource{destructed};throw std::runtime_error("synthetic measurement failure");});
    const auto out=call.Take();Check(!out.ok&&out.stop==WindowsV1UiaStop::kTimeout&&destructed==1&&cleaned==1,"exception cleanup before publication");}
  // Stop wins against a completed result immediately before the adoption lock.
  Reset();adoption_gate=MakeGate();{Consumer call([]{return std::optional<Sample>{Value()};});Check(adoption_gate->Wait(),"adoption gate entered");Stop(false);adoption_gate->Release();
    const auto out=call.Take();Check(!out.ok&&out.stop==WindowsV1UiaStop::kCanceled&&out.value.signature.empty(),"completed result not adopted after Stop");}
  // A successful result never frees its successor to race still-running cleanup.
  Reset();for(int i=0;i<3;++i){cleanup_gate=MakeGate();{Consumer call([]{return std::optional<Sample>{Value()};});Check(cleanup_gate->Wait()&&!call.Ready(20),"success waits for cleanup");cleanup_gate->Release();Check(call.Take().ok,"success published after cleanup");}
    cleanup_gate.reset();{Consumer next([]{return std::optional<Sample>{Value()};});Check(next.Take().ok,"consecutive classification not spuriously busy");}}
  Check(Drain()&&initialized==6&&cleaned==6,"all apartments retired");
  SemanticPolicies();
  CapturePolicies();
  std::cout<<"PASS: UIA read engine policies and ownership\n";return 0;
} catch(const std::exception& error){ReleaseAll();std::cerr<<"FAIL: "<<error.what()<<"\n";return 1;}}
`;
