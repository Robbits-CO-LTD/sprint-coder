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
  let engine = cut('// Observation rejects a worker timeout', 'struct WindowsUiaObservationResult');
  engine = once(
    engine,
    '    std::thread([pending, snapshot, preserve_stopped_result, measure = std::move(measure)]() mutable {',
    '    TestBeforeSpawn();\n    std::thread([pending, snapshot, preserve_stopped_result, measure = std::move(measure)]() mutable {',
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
    engine
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
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 150000);

// Portable control-logic evidence only. COM initialization/cleanup are controlled stubs;
// the Windows pipe/real-UIA seams independently validate the actual OS boundary.
const preamble = String.raw`
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
void Reset(){ReleaseAll();Check(Drain(),"previous worker drained");cleanup_gate.reset();adoption_gate.reset();all_gates.clear();initialized=0;cleanup_entered=0;cleaned=0;fail_thread=false;fail_init=false;cancellation_epoch=0;parent_process_dead=false;WindowsTargetListControl().stop_serial=0;}
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
  std::cout<<"PASS: UIA read engine policies and ownership\n";return 0;
} catch(const std::exception& error){ReleaseAll();std::cerr<<"FAIL: "<<error.what()<<"\n";return 1;}}
`;
