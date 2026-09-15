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
    });
  },
);
