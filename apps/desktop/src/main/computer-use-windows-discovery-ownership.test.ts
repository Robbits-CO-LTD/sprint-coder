import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

function cut(start: string, end: string): string {
  const from = host.indexOf(start),
    to = host.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error('Native admission source markers changed');
  return host.slice(from, to);
}

describe('Windows native discovery ownership', () => {
  it('binds query identities, retains stop leases and bounds terminal records', ({ skip }) => {
    const root = mkdtempSync(join(tmpdir(), 'sc-discovery-owner-'));
    try {
      const source = join(root, 'seam.cc');
      const binary = join(root, process.platform === 'win32' ? 'seam.exe' : 'seam');
      const build = findBuild(source, binary);
      if (!build) {
        if (process.env.CI) throw new Error('Native compiler required');
        skip();
        return;
      }
      writeFileSync(
        source,
        preamble +
          cut('bool ReadJsonStringValueAt(', 'bool ReadJsonUint64(') +
          cut('// BEGIN windows discovery ownership', '// END windows discovery ownership') +
          program,
      );
      const compiled = spawnSync(build.file, build.args, {
        encoding: 'utf8',
        windowsVerbatimArguments: build.verbatim,
        timeout: 120000,
      });
      expect(compiled.status, compiled.stdout + '\n' + compiled.stderr).toBe(0);
      const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
      expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
      expect(result.stdout).toContain('PASS: discovery parser, binding, terminal and capacity');
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 150000);
});

const preamble = String.raw`
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>
struct Control { std::mutex stop_mutex; std::atomic<std::uint64_t> stop_serial{0}; };
Control& WindowsTargetListControl(){static Control control;return control;}
`;
const program = String.raw`
void Check(bool ok,const char* text){if(!ok)throw std::runtime_error(text);}
std::string Key(unsigned i){std::string key(16,'\0');key[0]=static_cast<char>(i);return key;}
WindowsDiscoveryAdmission Admit(unsigned i,const std::string& id,const std::string& request="",bool fresh=true){
 std::string reason;auto result=AdmitWindowsDiscovery(Key(i),id,request.empty()?"request-"+std::to_string(i):request,std::string(64,'a'),fresh,100,&reason);
 Check(reason.empty(),"valid admission reason");return result;
}
int main(){try{
 const std::string query="{\"operation\":\"list_windows_cancellable\",\"discoveryId\":\"host:1\",\"canonicalPath\":\"C:\\\\owned.exe\",\"identityDigest\":\""+std::string(64,'a')+"\",\"executableDigest\":\""+std::string(64,'b')+"\",\"signerDigest\":\"\"}";
 WindowsDiscoveryParameters parsed;Check(ReadWindowsDiscoveryQuery(query,&parsed)&&parsed.id=="host:1","query parser");
 Check(!ReadWindowsDiscoveryQuery(query.substr(0,query.size()-1)+",\"extra\":\"x\"}",&parsed),"query extra refused");
 Check(!ReadWindowsDiscoveryQuery(query.substr(0,query.size()-1)+",\"discoveryId\":\"other\"}",&parsed),"duplicate key refused");
 std::string stop_id;Check(ReadWindowsDiscoveryStop("{\"discoveryId\":\"host:1\",\"operation\":\"stop_window_discovery\"}",&stop_id)&&stop_id=="host:1","stop parser");
 Check(!ReadWindowsDiscoveryStop("{\"discoveryId\":\"host:1\",\"operation\":\"stop_window_discovery\",\"action\":\"click\"}",&stop_id),"stop extra refused");
 auto first=Admit(1,"host:1");Check(first.lease&&!first.not_admitted,"first lease");
 const auto owner=first.lease->owner;Check(owner->admitted_at==100,"reader time retained");
 auto replay=Admit(1,"host:1");Check(replay.lease&&replay.lease->owner==owner,"same original frame references owner");
 std::string error;auto alias=Key(1);alias[15]=1;
 Check(!AdmitWindowsDiscovery(alias,"host:1","r",std::string(64,'a'),true,200,&error).lease&&error=="discovery_id_reuse","all opaque bytes bound");
 error.clear();Check(!AdmitWindowsDiscovery(Key(1),"other","r",std::string(64,'a'),true,200,&error).lease,"header alias refused");
 error.clear();Check(!AdmitWindowsDiscovery(Key(1),"host:1","fresh-wire",std::string(64,'a'),true,200,&error).lease,"fresh wire same discovery refused");
 error.clear();Check(!AdmitWindowsDiscovery(Key(1),"host:1","request-1",std::string(64,'b'),false,200,&error).lease,"payload conflict refused");
 Check(ClaimWindowsDiscoveryQuery(first.lease)&&!ClaimWindowsDiscoveryQuery(replay.lease),"query once only");
 Check(!ReferenceWindowsDiscoveryStop(Key(2),"host:1",true)&&!owner->stopped.load(),"unknown pair inert");
 {std::lock_guard lock(WindowsTargetListControl().stop_mutex);owner->launch_in_flight=true;owner->launch_attempts=1;}
 auto stop=ReferenceWindowsDiscoveryStop(Key(1),"host:1",true);
 Check(stop&&owner->stopped.load()&&!owner->terminal,"claimed launch remains unconfirmed");
 FinishWindowsDiscovery(owner,false);Check(!owner->terminal,"return cannot end in-flight unit");
 {std::lock_guard lock(WindowsTargetListControl().stop_mutex);owner->launch_in_flight=false;}
 FinishWindowsDiscovery(owner,false);Check(owner->terminal&&!owner->completed&&owner->launch_attempts==1,"finished unit terminal");
 first.lease.reset();replay.lease.reset();Check(owner->references.load()==1,"queued Stop owns remaining reference");
 std::vector<std::shared_ptr<WindowsDiscoveryLease>> held;
 for(unsigned i=2;i<=16;i++){auto value=Admit(i,"host:"+std::to_string(i));Check(value.lease!=nullptr,"fill registry");held.push_back(std::move(value.lease));}
 auto full=Admit(17,"host:17");Check(full.not_admitted&&!full.lease&&WindowsDiscoveries().owners.size()==16,"bounded capacity and not-admitted proof");
 Check(WindowsDiscoveries().owners.at(Key(1))==owner,"Stop queue lease prevents eviction");
 stop.reset();auto replacement=Admit(17,"host:17");Check(replacement.lease&&!ReferenceWindowsDiscoveryStop(Key(1),"host:1",true),"released terminal evicted, old Stop unknown");
 auto old_wire=Admit(1,"host:1","request-1",false);Check(old_wire.replay_only&&!old_wire.lease&&!old_wire.not_admitted,"old wire cannot recreate owner before cache lookup");
 Check(ClaimWindowsDiscoveryQuery(replacement.lease),"replacement query claim");
 FinishWindowsDiscovery(replacement.lease->owner,true);
 Check(replacement.lease->owner->completed&&replacement.lease->owner->terminal&&!replacement.lease->owner->stopped.load(),"normal completion is not cancellation");
 Check(!ClaimWindowsDiscoveryQuery(replacement.lease),"completed owner cannot run again");
 auto stopped=ReferenceWindowsDiscoveryStop(Key(17),"host:17",true);Check(stopped&&stopped->owner->terminal&&!stopped->owner->completed,"completed to stopped is terminal");
 held.clear();Check(WindowsDiscoveries().owners.at(Key(2))->terminal,"dropped unclaimed queue frame terminal");
 stopped.reset();replacement.lease.reset();
 auto idle=Admit(18,"host:18");Check(ClaimWindowsDiscoveryQuery(idle.lease),"pipe-end case started");
 StopWindowsDiscoveriesForPipeEnd();Check(idle.lease->owner->stopped.load()&&idle.lease->owner->terminal,"pipe end prohibits later launch");
 Check(WindowsTargetListControl().stop_serial.load()==0,"discovery Stop does not cancel unrelated session");
 std::cout<<"PASS: discovery parser, binding, terminal and capacity\n";return 0;
}catch(const std::exception& error){std::cerr<<"FAIL: "<<error.what()<<"\n";return 1;}}
`;
