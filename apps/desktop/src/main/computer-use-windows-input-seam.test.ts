import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
  'utf8',
);
describe.skipIf(process.platform === 'win32')(
  'Windows SendInput count portable native seam',
  () => {
    // This spec spawns a compiler and then an ASan/UBSan-instrumented binary, so its cost is
    // dominated by process spawn inside the Vitest worker rather than by the tiny translation
    // unit: ~0.4s when the same steps run straight from Node, ~4s inside a worker on an idle
    // machine, and 9.4s on a healthy two-core Linux CI shard sharing the host with the rest of the
    // suite (run 34957326437). Vitest's 20s project default left no room for that spread and turned
    // an ordinary slow runner into a red build with only "Test timed out" to go on. Like the other
    // spawn-heavy specs in this repo it therefore declares its own budget, which keeps the bounded
    // clang++ (30s) and binary (5s) guards below the per-test deadline so a genuinely stuck
    // compiler still fails first and names the command instead of being masked by the runner.
    it('counts the actual API attempt even when SendInput fails, but not a guard refusal', () => {
      const root = mkdtempSync(join(tmpdir(), 'computer-use-win-input-seam-'));
      try {
        const from = source.indexOf('UINT SendInputForBoundTarget(');
        const to = source.indexOf('WORD VirtualKeyForName(', from);
        expect(from).toBeGreaterThan(0);
        expect(to).toBeGreaterThan(from);
        const path = join(root, 'seam.cc');
        const binary = join(root, 'seam');
        writeFileSync(
          path,
          `
#include <atomic>
#include <cstdint>
#include <memory>
using UINT = unsigned;
struct RECT {};
struct INPUT {};
using LPINPUT = INPUT*;
struct WindowsSession { std::shared_ptr<std::atomic<std::uint64_t>> input_api_attempts = std::make_shared<std::atomic<std::uint64_t>>(0); };
bool valid = true;
unsigned calls = 0;
bool RevalidateWindowsTarget(const WindowsSession&, const RECT&, std::uint64_t) { return valid; }
UINT SendInput(UINT, LPINPUT, unsigned) { ++calls; return 0; }
${source.slice(from, to)}
int main() {
  WindowsSession session;
  RECT bounds;
  INPUT input;
  if (SendInputForBoundTarget(session, bounds, 0, 1, &input) != 0) return 1;
  if (session.input_api_attempts->load() != 1 || calls != 1) return 2;
  valid = false;
  SendInputForBoundTarget(session, bounds, 1, 1, &input);
  return session.input_api_attempts->load() == 1 && calls == 1 ? 0 : 3;
}`,
        );
        execFileSync(
          'clang++',
          [
            '-std=c++20',
            '-Wall',
            '-Wextra',
            '-Werror',
            '-fsanitize=address,undefined',
            path,
            '-o',
            binary,
          ],
          { stdio: 'pipe', timeout: 30_000 },
        );
        execFileSync(binary, [], { stdio: 'pipe', timeout: 5_000 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
