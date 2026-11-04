import { findBuild } from './test-support/msvc-build';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const build = findBuild();

// Every OS/N-API call below is a stub; this compiles the addon's actual PID parsing and permit
// callback, never sends OS input.
describe.skipIf(build === null)('P5c1 native helper permit component', () => {
  it('rejects unknown/foreign/dead helper and reuse, and propagates OS refusal', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_main.cc'),
      'utf8',
    );
    const begin = source.indexOf('bool ReadPid(');
    const end = source.indexOf('// Main binds only', begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const program = `
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
using DWORD = std::uint32_t;
using HANDLE = void*;
constexpr DWORD MAXDWORD = 0xffffffff;
constexpr int FALSE = 0, WAIT_TIMEOUT = 258, napi_ok = 0;
struct Value { double number; bool numeric = true; };
using napi_value = Value*;
using napi_env = void*;
struct Info { size_t count; napi_value arg; void* data; };
using napi_callback_info = Info*;
Value yes{1}, no{0};
napi_value Boolean(napi_env, bool value) { return value ? &yes : &no; }
int napi_get_value_double(napi_env, napi_value value, double* out) {
  if (!value || !value->numeric) return 1;
  *out = value->number; return napi_ok;
}
int napi_get_cb_info(napi_env, Info* info, size_t* count, napi_value* args, void*, void** data) {
  *count = info->count; args[0] = info->arg; *data = info->data; return napi_ok;
}
bool alive = true, allowed = true;
int calls = 0;
DWORD seen = 0;
void CloseHandle(HANDLE) {}
int WaitForSingleObject(HANDLE, int) { return alive ? WAIT_TIMEOUT : 0; }
int AllowSetForegroundWindow(DWORD pid) { ++calls; seen = pid; return allowed; }
${source.slice(begin, end)}
bool invoke(HelperPermit& permit, double requested, size_t count = 1) {
  Value value{requested}; Info info{count, &value, &permit};
  return AllowHelperForeground(nullptr, &info) == &yes;
}
int main() {
  for (double pid : {0.0, -1.0, 1.5, double(MAXDWORD),
      std::numeric_limits<double>::quiet_NaN(), 43.0}) {
    HelperPermit permit{42, nullptr};
    if (invoke(permit, pid) || calls != 0 || invoke(permit, 42)) return 1;
  }
  HelperPermit missing{42, nullptr};
  if (invoke(missing, 42, 0) || calls != 0) return 2;
  HelperPermit dead{42, nullptr}; alive = false;
  if (invoke(dead, 42) || calls != 0) return 3;
  alive = true;
  HelperPermit ok{42, nullptr};
  if (!invoke(ok, 42) || calls != 1 || seen != 42 || invoke(ok, 42) || calls != 1) return 4;
  allowed = false;
  HelperPermit refused{42, nullptr};
  if (invoke(refused, 42) || calls != 2 || invoke(refused, 42) || calls != 2) return 5;
  return 0;
}
`;
    const directory = mkdtempSync(join(tmpdir(), 'sc-p5c1-component-'));
    try {
      const cpp = join(directory, 'permit.cc');
      const exe = join(directory, 'permit.exe');
      writeFileSync(cpp, '#include <initializer_list>\n' + program);
      const command = build!.wrap(['/nologo', '/std:c++20', '/EHsc', cpp, `/Fe:${exe}`]);
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
