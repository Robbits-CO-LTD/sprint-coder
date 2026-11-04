import { findBuild, type BuildCommand } from './test-support/msvc-build';
import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const nativeDirectory = join(__dirname, '../../computer-use-native');
const host = readWindowsHostSource();

function findCompiler(path: string, output: string): BuildCommand | null {
  if (process.platform !== 'win32') {
    if (spawnSync('clang++', ['--version'], { stdio: 'ignore' }).status !== 0) return null;
    return {
      name: 'clang++',
      file: 'clang++',
      args: ['-std=c++20', '-Wall', '-Wextra', `-I${nativeDirectory}`, path, '-o', output],
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
  return findBuild(clArguments);
}

function cut(start: string, end: string, after = ''): string {
  const from = host.indexOf(start, after === '' ? 0 : host.indexOf(after)),
    to = host.indexOf(end, from + start.length);
  if (after !== '' && host.indexOf(after) < 0)
    throw new Error('Native admission source markers changed');
  if (from < 0 || to < 0) throw new Error('Native admission source markers changed');
  return host.slice(from, to);
}

describe('Windows native start ownership table', () => {
  it('binds opaque IDs, isolates stop latches and retains referenced terminal owners', ({
    skip,
  }) => {
    const root = mkdtempSync(join(tmpdir(), 'native-start-owner-'));
    try {
      const source = join(root, 'seam.cc'),
        binary = join(root, process.platform === 'win32' ? 'seam.exe' : 'seam');
      const build = findCompiler(source, binary);
      if (build === null) {
        if (process.env.CI) throw new Error('A native compiler is required');
        skip();
        return;
      }
      writeFileSync(
        source,
        preamble +
          cut('struct WindowsWireFingerprint {', 'struct WindowsStartAdmission {') +
          cut('struct WindowsStartAdmission {', 'struct WindowsSession {') +
          cut(
            'struct WindowsStartRegistry {',
            'std::atomic<bool> &WindowsTargetListWorkerRunning() {',
          ) +
          retirementPreamble +
          // The new start's own slot guard; the rejudge (N5-D) declares one earlier in the file.
          cut(
            '  struct Slot {',
            '  ScopedKernelHandle target_process;',
            'bool StartWindowsNewSession(WindowsStartInput input,',
          ) +
          '\n}\npending->changed.notify_one();\n}\n' +
          driver,
      );
      const compiled = spawnSync(build.file, build.args, {
        encoding: 'utf8',
        windowsVerbatimArguments: build.verbatim,
        timeout: 120000,
      });
      expect(compiled.status, compiled.stdout + '\n' + compiled.stderr).toBe(0);
      const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000 });
      expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(
        'PASS: opaque binding, replay, owner stop, capacity, late lease',
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 130000);
});

const preamble = String.raw`
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>
constexpr std::size_t kMaximumCachedResponses=256;
// This ownership-only seam has no measurement thread; the new-start component covers cancellation.
using HANDLE = void*;
bool CancelSynchronousIo(HANDLE){throw std::runtime_error("unexpected measurement cancellation");}
struct WindowsTargetListState {
  std::mutex stop_mutex;
  HANDLE new_start_thread = nullptr;
  std::atomic<std::uint64_t> stop_serial{0};
  std::shared_ptr<int> context_candidate;
};
WindowsTargetListState& WindowsTargetListControl(){static auto* state=new WindowsTargetListState;return *state;}
`;
// Execute the production slot retirement with its real start lease. The notifier parks
// the worker after idle publication but before the argument lease can destruct.
const retirementPreamble = String.raw`
std::atomic<bool>& WindowsTargetListWorkerRunning(){static std::atomic<bool> running{true};return running;}
struct RetirementNotification {
  std::atomic<bool> entered{false}, release{false};
  void notify_one(){entered.store(true,std::memory_order_release);while(!release.load(std::memory_order_acquire))std::this_thread::yield();}
};
struct RetirementPending { std::mutex mutex; bool ready=false; RetirementNotification changed; };
struct WindowsStartInput { std::shared_ptr<WindowsStartLease> start_lease; };
void PublishRejectedStart(WindowsStartInput input,std::shared_ptr<RetirementPending> pending) {
  {
`;
const driver = String.raw`
void Check(bool value,const char* message){if(!value)throw std::runtime_error(message);}
int main(){
  bool fresh_wire=false;std::string wire_error;
  auto wire=RegisterWindowsWireRequest("probe-key",std::string(64,'a'),&fresh_wire,&wire_error);
  Check(wire&&fresh_wire,"first wire request");
  auto conflict=RegisterWindowsWireRequest("probe-key",std::string(64,'b'),&fresh_wire,&wire_error);
  Check(!conflict&&wire_error=="request_id_conflict","cross-operation conflict before effects");
  auto replay_wire=RegisterWindowsWireRequest("probe-key",std::string(64,'a'),&fresh_wire,&wire_error);
  Check(replay_wire&&!fresh_wire,"same wire replay");
  Check(MarkWindowsWireCached("probe-key",std::string(64,'a'),true),"cache fingerprint");
  wire.reset();replay_wire.reset();
  Check(!RegisterWindowsWireRequest("probe-key",std::string(64,'b'),&fresh_wire,&wire_error),"cached conflict remains");
  MarkWindowsWireCached("probe-key",{},false);
  auto after_eviction=RegisterWindowsWireRequest("probe-key",std::string(64,'b'),&fresh_wire,&wire_error);
  Check(after_eviction&&fresh_wire,"fingerprint follows cache eviction");after_eviction.reset();
  const std::string keyA(16,'a'),keyB(16,'b'),digest(64,'1');
  std::string reason;
  auto a=AdmitWindowsStart(keyA,"a","request-1",digest,&reason);
  auto a2=AdmitWindowsStart(keyA,"a","request-2",digest,&reason,9);
  Check(a && a2 && a->owner==a2->owner,"same owner for parallel attempts");
  Check(a->owner->requested_epoch==9,"admission retains epoch upper bound");
  Check(!AdmitWindowsStart(keyB,"a","request-3",digest,&reason),"SID alias refused");
  Check(!AdmitWindowsStart(keyA,"other","request-3",digest,&reason),"header alias refused");
  Check(!AdmitWindowsStart(keyA,"a","request-1",std::string(64,'2'),&reason),"payload conflict refused");
  auto replay=AdmitWindowsStart(keyA,"a","request-1",digest,&reason);
  Check(replay && replay->owner==a->owner,"wire replay retains owner");
  auto b=AdmitWindowsStart(keyB,"b","request-b",digest,&reason);
  Check(ClaimWindowsStartInput(a),"claim current input owner");
  Check(!ClaimWindowsStartInput(b),"second owner cannot claim");
  const auto serial=WindowsTargetListControl().stop_serial.load();
  Check(!LatchWindowsPendingStop(keyA,"b") && !LatchWindowsPendingStop(keyB,"a"),"stop requires both IDs");
  Check(LatchWindowsPendingStop(keyB,"b"),"queued owner stops locally");
  Check(WindowsTargetListControl().stop_serial.load()==serial,"queued stop leaves current owner alone");
  Check(LatchWindowsPendingStop(keyA,"a"),"current owner stopped");
  Check(WindowsTargetListControl().stop_serial.load()==serial+1,"current stop advances serial");
  Check(LatchWindowsPendingStop(keyA,"a"),"repeated stop accepted");
  Check(WindowsTargetListControl().stop_serial.load()==serial+1,"repeated latch is inert");
  Check(!ClaimWindowsStartInput(a),"stopped owner cannot adopt");
  Check(!AdmitWindowsStart(keyA,"a","fresh-request",digest,&reason),"stopped ID cannot restart");
  auto& registry=WindowsStarts();
  // The consumer's drain proof can retire A, but its queued/worker leases must still keep it.
  a->owner->terminal=true;
  std::vector<std::shared_ptr<WindowsStartLease>> rest;
  for(int i=0;i<14;i++){
    auto item=AdmitWindowsStart(std::string(16,static_cast<char>('c'+i)),"id-"+std::to_string(i),"r",digest,&reason);
    Check(item!=nullptr,"fill available slots");rest.push_back(item);
  }
  Check(!AdmitWindowsStart(std::string(16,'z'),"overflow","r",digest,&reason),"referenced terminal owner not evicted");
  auto old=a->owner;a.reset();a2.reset();replay.reset();
  Check(old->pending_requests.load()==0 && registry.input_owner==nullptr,"last attempt releases input claim");
  auto retire=AdmitWindowsStart(std::string(16,'z'),"retire-trigger","r",digest,&reason);
  Check(retire!=nullptr,"unused terminal record evicted");retire->owner->terminal=true;retire.reset();
  auto fresh=AdmitWindowsStart(keyA,"fresh-id","r",digest,&reason);
  Check(fresh && fresh->owner!=old && ClaimWindowsStartInput(fresh),"drained unused owner can retire");
  Check(!LatchWindowsPendingStop(keyA,"a"),"old SID cannot stop replacement");
  {auto late=std::make_shared<WindowsStartLease>(old);Check(!ClaimWindowsStartInput(late),"late old owner cannot adopt");}
  Check(registry.input_owner==fresh->owner,"late lease cannot clear replacement");
  // Isolate the retirement phase only after every earlier attempt has released its lease.
  fresh.reset();b.reset();rest.clear();
  for(const auto& entry:registry.owners)Check(entry.second->pending_requests.load()==0,"prior leases released");
  registry.owners.clear();registry.keys_by_id.clear();registry.order.clear();registry.last_input_owner.reset();
  auto retiring=AdmitWindowsStart(std::string(16,'q'),"retiring","r",digest,&reason);
  Check(retiring&&ClaimWindowsStartInput(retiring),"retiring owner claimed");
  auto pending=std::make_shared<RetirementPending>();
  std::thread worker([lease=std::move(retiring),pending]() mutable {PublishRejectedStart({std::move(lease)},pending);});
  while(!pending->changed.entered.load(std::memory_order_acquire))std::this_thread::yield();
  const bool idle=!WindowsTargetListWorkerRunning().load(std::memory_order_acquire);
  bool released=false;{std::lock_guard lock(WindowsTargetListControl().stop_mutex);released=registry.input_owner==nullptr;}
  auto next=AdmitWindowsStart(std::string(16,'r'),"next","r",digest,&reason);
  const bool claimed=next&&ClaimWindowsStartInput(next);
  pending->changed.release.store(true,std::memory_order_release);worker.join();
  Check(idle&&released&&claimed,"idle publication must release the last input lease first");
  std::cout<<"PASS: opaque binding, replay, owner stop, capacity, late lease\n";
}
`;
