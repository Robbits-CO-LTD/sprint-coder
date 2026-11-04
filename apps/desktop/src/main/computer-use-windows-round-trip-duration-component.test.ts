import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
type Build = Readonly<{
  wrap: (arguments_: string[]) => { file: string; args: string[]; verbatim: boolean };
}>;

// The same MSVC lookup as the other Windows component tests: cl.exe on PATH, else vcvars64.
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

const build = findBuild();

// The production Begin call and state machine are used;
// ticket invalidation is a counter, and no Windows API or OS input is involved.
describe.skipIf(build === null)('P5c2b-W native duration component', () => {
  it('offer 59000ms and remaining 58990ms begins and expires at the shorter deadline', () => {
    const native = join(__dirname, '../../computer-use-native');
    const source = readFileSync(join(native, 'computer_use_windows_host_preflight.inc'), 'utf8');
    const start = source.indexOf('accepted = session->round_trip->Begin(');
    const end = source.indexOf('if (accepted) InvalidateWindowsTicket(key);', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const call = source.slice(start, end + 'if (accepted) InvalidateWindowsTicket(key);'.length);
    const program = `
#include <algorithm>
#include <memory>
#include "computer_use_windows_approval_round_trip.h"
using namespace sprint_coder::computer_use;
int invalidated = 0;
void InvalidateWindowsTicket(int) { ++invalidated; }
struct Session { std::shared_ptr<WindowsApprovalRoundTrip> round_trip;
  std::uint64_t observation_revision = 7; };
struct Ticket { std::uint64_t generation = 3; };
bool begin(Session* session, std::uint64_t duration, std::uint64_t remaining) {
  ApprovalRoundTripBinding binding{"card", "session", "task", "turn", 1, 0};
  std::uint64_t received_ms = 100;
  Ticket ticket_states[1]; int key = 0; bool monitoring = true, accepted = false;
  ${call}
  return accepted;
}
int main() {
  Session session{std::make_shared<WindowsApprovalRoundTrip>()};
  if (!begin(&session, 59000, 58990) || invalidated != 1) return 1;
  session.round_trip->Observe(ApprovalRoundTripFocus::kTarget, true, true, 59089);
  if (session.round_trip->Failed() || session.round_trip->MayInput(59089)) return 2;
  session.round_trip->Observe(ApprovalRoundTripFocus::kTarget, true, true, 59090);
  if (!session.round_trip->Failed()) return 3;
  for (auto remaining : {0ULL, 58990ULL}) {
    Session expired{std::make_shared<WindowsApprovalRoundTrip>()};
    if (begin(&expired, remaining == 0 ? 59000 : 0, remaining)) return 4;
  }
  Session shorter{std::make_shared<WindowsApprovalRoundTrip>()};
  if (!begin(&shorter, 10, 58990)) return 5;
  shorter.round_trip->Observe(ApprovalRoundTripFocus::kTarget, true, true, 110);
  if (!shorter.round_trip->Failed() || invalidated != 2) return 6;
  return 0;
}
`;
    const directory = mkdtempSync(join(tmpdir(), 'sc-p5c2b-duration-'));
    try {
      const cpp = join(directory, 'duration.cc');
      const exe = join(directory, 'duration.exe');
      writeFileSync(cpp, program);
      const command = build!.wrap([
        '/nologo',
        '/std:c++20',
        '/EHsc',
        `/I${native}`,
        cpp,
        `/Fe:${exe}`,
      ]);
      const built = spawnSync(command.file, command.args, {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
      });
      expect(built.status, `${built.error ?? ''}\n${built.stdout}\n${built.stderr}`).toBe(0);
      const ran = spawnSync(exe, [], { encoding: 'utf8', windowsHide: true });
      expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
