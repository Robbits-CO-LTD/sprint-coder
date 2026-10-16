import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Behavioural seam for the Windows helper's ordinary ticket (S5-a). The production functions that
// issue, bind and consume the ticket are cut out of computer_use_windows_host.cc and compiled with
// inert replacements for everything Win32 (the session's window, UI Automation, the RNG, the
// clock and the pipe), then driven directly. No window, process or pipe is used. It builds with
// cl.exe on Windows (the windows-2022 gate has it) and with clang++ elsewhere; where neither
// compiler can be found the test is skipped rather than failed.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const source = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');

function between(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Native seam source markers changed: ${start}`);
  return source.slice(from, to);
}

const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

type Compiler = Readonly<{
  name: string;
  command: (path: string, output: string) => { file: string; args: string[]; verbatim: boolean };
}>;

function findCompiler(): Compiler | null {
  if (process.platform !== 'win32') {
    if (spawnSync('clang++', ['--version'], { stdio: 'ignore' }).status !== 0) return null;
    return {
      name: 'clang++',
      command: (path, output) => ({
        file: 'clang++',
        args: [
          '-std=c++20',
          '-Wall',
          '-Wextra',
          '-fsanitize=address,undefined',
          `-I${nativeDirectory}`,
          path,
          '-o',
          output,
        ],
        verbatim: false,
      }),
    };
  }
  const clArguments = (path: string, output: string): string[] => [
    '/nologo',
    '/std:c++20',
    '/EHsc',
    '/W4',
    '/utf-8',
    `/I${nativeDirectory}`,
    path,
    `/Fe:${output}`,
    `/Fo:${output}.obj`,
  ];
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return {
      name: 'cl.exe',
      command: (path, output) => ({
        file: 'cl.exe',
        args: clArguments(path, output),
        verbatim: false,
      }),
    };
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
    command: (path, output) => ({
      file: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        `"call "${vcvars}" >nul && cl.exe ${clArguments(path, output)
          .map((argument) => `"${argument}"`)
          .join(' ')}"`,
      ],
      verbatim: true,
    }),
  };
}

const compiler = findCompiler();

const preamble = String.raw`
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iostream>
#include <iterator>
#include <memory>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>
#include "computer_use_native_ticket.h"
#include "computer_use_preflight_classifier.h"
#include "computer_use_protocol.h"

using HANDLE = void *;
using LONG = long;
using ULONG = unsigned long;
using DWORD = unsigned long;
#ifndef BCRYPT_USE_SYSTEM_PREFERRED_RNG
#define BCRYPT_USE_SYSTEM_PREFERRED_RNG 0x00000002
#endif
struct RECT { LONG left = 0, top = 0, right = 0, bottom = 0; };

namespace {

using sprint_coder::computer_use::Frame;
using sprint_coder::computer_use::FrameHeader;
using sprint_coder::computer_use::MessageType;

// ---- inert replacements ----------------------------------------------------------------------
bool g_rng_ok = true;
unsigned char g_rng_fill = 0x11;
long BCryptGenRandom(void *, unsigned char *buffer, unsigned long size, unsigned long) {
  if (!g_rng_ok) return -1;
  for (unsigned long i = 0; i < size; ++i) buffer[i] = static_cast<unsigned char>(g_rng_fill + i);
  return 0;
}
void SecureZeroMemory(void *target, std::size_t size) {
  volatile unsigned char *bytes = static_cast<volatile unsigned char *>(target);
  for (std::size_t i = 0; i < size; ++i) bytes[i] = 0;
}
std::uint64_t g_now_ns = 1'000'000'000ULL;
std::uint64_t MonotonicNowNs() { return g_now_ns; }

// A small real SHA-256, so the digests (and the frame id the preflight derives) are the real ones.
std::string Sha256String(std::string_view message) {
  static const std::uint32_t k[64] = {
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
  std::uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  std::vector<std::uint8_t> data(message.begin(), message.end());
  const std::uint64_t bits = static_cast<std::uint64_t>(data.size()) * 8;
  data.push_back(0x80);
  while (data.size() % 64 != 56) data.push_back(0);
  for (int i = 7; i >= 0; --i) data.push_back(static_cast<std::uint8_t>(bits >> (i * 8)));
  const auto rotr = [](std::uint32_t v, int n) { return (v >> n) | (v << (32 - n)); };
  for (std::size_t chunk = 0; chunk < data.size(); chunk += 64) {
    std::uint32_t w[64];
    for (int i = 0; i < 16; ++i)
      w[i] = (std::uint32_t(data[chunk + i * 4]) << 24) | (std::uint32_t(data[chunk + i * 4 + 1]) << 16) |
             (std::uint32_t(data[chunk + i * 4 + 2]) << 8) | std::uint32_t(data[chunk + i * 4 + 3]);
    for (int i = 16; i < 64; ++i) {
      const std::uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      const std::uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    std::uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; ++i) {
      const std::uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const std::uint32_t ch = (e & f) ^ (~e & g);
      const std::uint32_t t1 = hh + s1 + ch + k[i] + w[i];
      const std::uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const std::uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      const std::uint32_t t2 = s0 + maj;
      hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  static const char hex[] = "0123456789abcdef";
  std::string out;
  for (int i = 0; i < 8; ++i)
    for (int shift = 28; shift >= 0; shift -= 4) out.push_back(hex[(h[i] >> shift) & 0xf]);
  return out;
}

// The parts of a Windows session that the ticket code reads (same member names as the helper).
struct WindowsSession {
  std::shared_ptr<std::atomic<std::uint64_t>> input_api_attempts =
      std::make_shared<std::atomic<std::uint64_t>>(0);
  std::string session_id;
  std::uint32_t pid = 0;
  std::string app_identity;
  std::string window_identity;
  std::string active_window_identity;
  std::string active_window_kind = "application";
  std::string process_start;
  std::uint64_t cancel_epoch = 0;
  std::uint64_t observation_revision = 0;
  bool has_observation = false;
  std::uint64_t dialog_set_revision = 0;
  std::string dialog_set_digest;
  RECT observation_bounds{};
  std::string focused_element_signature;
  bool has_focused_element_signature = false;
};
std::unordered_map<std::string, WindowsSession> sessions;

bool g_validate_ok = true;
std::string g_validate_reason = "stale_target";
bool g_revalidate_ok = true;
bool g_focus_ok = true;
struct WindowsDialogSetSnapshot {};
bool ValidateWindowsSession(const WindowsSession &session, RECT *bounds, std::string *reason,
                            WindowsDialogSetSnapshot * = nullptr) {
  if (!g_validate_ok) {
    *reason = g_validate_reason;
    return false;
  }
  *bounds = session.observation_bounds;
  return true;
}
bool RevalidateWindowsTarget(const WindowsSession &, const RECT &, std::uint64_t) {
  return g_revalidate_ok;
}
bool WindowsFocusedElementSignature(std::uint32_t, const RECT &, std::string *signature) {
  if (!g_focus_ok) return false;
  *signature = "focus-signature";
  return true;
}

struct Sent { MessageType type; std::string payload; };
std::vector<Sent> g_sent;
bool Respond(HANDLE, const Frame &, MessageType type, std::string_view payload,
             std::span<const std::uint8_t> = {}) {
  g_sent.push_back({type, std::string(payload)});
  return true;
}
`;

const driver = String.raw`
// ---- driver ----------------------------------------------------------------------------------
int g_failures = 0;
void Check(bool condition, const char *name) {
  if (!condition) { std::cerr << "FAIL " << name << "\n"; ++g_failures; }
}

const std::string kDigest(64, 'a');
sprint_coder::computer_use::FrameId IdOf(std::uint8_t byte) {
  sprint_coder::computer_use::FrameId id;
  id.bytes[0] = byte;
  return id;
}
Frame PipeFrame(MessageType type, std::uint8_t request_byte) {
  Frame frame;
  frame.header.message_type = static_cast<std::uint16_t>(type);
  frame.header.session_id = IdOf(1);
  frame.header.request_id = IdOf(request_byte);
  return frame;
}
const std::string kSessionKey = FrameIdKey(IdOf(1));

void Reset() {
  sessions.clear();
  ticket_states.clear();
  response_cache.clear();
  response_cache_order.clear();
  response_cache_bytes = 0;
  g_sent.clear();
  g_shadow.clear();
  g_validate_ok = true;
  g_revalidate_ok = true;
  g_focus_ok = true;
  g_rng_ok = true;
  g_now_ns = 1'000'000'000ULL;
  WindowsSession session;
  session.session_id = "session-1";
  session.pid = 4242;
  session.app_identity = "app";
  session.window_identity = "window";
  session.active_window_identity = "active";
  session.process_start = "started";
  session.cancel_epoch = 3;
  session.observation_revision = 7;
  session.has_observation = true;
  session.dialog_set_revision = 2;
  session.dialog_set_digest = "dialogs";
  session.observation_bounds = RECT{10, 20, 110, 220};
  session.focused_element_signature = "focus-signature";
  session.has_focused_element_signature = true;
  sessions.emplace(kSessionKey, session);
}

// The request a dispatch carries, as Main sends it (the ticket comes last).
std::string Meta(const std::string &extra = "", const std::string &ticket = "",
                 const std::string &request_id = "request-1", const std::string &digest = kDigest,
                 int epoch = 3, int revision = 7) {
  std::string m = "{\"type\":\"click\",\"x\":0.5,\"y\":0.25,\"requestId\":\"" + request_id +
                  "\",\"actionDigest\":\"" + digest + "\",\"cancelEpoch\":" + std::to_string(epoch) +
                  ",\"observationRevision\":" + std::to_string(revision) + extra;
  if (!ticket.empty()) m += ",\"ticket\":\"" + ticket + "\"";
  return m + "}";
}

std::string TicketFrom(const std::string &receipt) {
  const std::string needle = "\"ticket\":\"";
  const auto at = receipt.find(needle);
  if (at == std::string::npos) return "";
  return receipt.substr(at + needle.size(), 64);
}

// Preflights and returns the ticket (empty when none was issued); the receipt is left in sent.
std::string Preflight(const std::string &metadata) {
  g_sent.clear();
  Frame frame = PipeFrame(MessageType::kPreflight, 9);
  HandleWindowsPreflight(nullptr, frame, metadata);
  return g_sent.empty() ? "" : TicketFrom(g_sent.back().payload);
}
bool Consume(const std::string &metadata) {
  return ConsumeWindowsDispatchTicket(kSessionKey, sessions.at(kSessionKey), metadata);
}
bool HasDecision(const char *decision) {
  return !g_sent.empty() && g_sent.back().type == MessageType::kPreflightResult &&
         g_sent.back().payload.find(std::string("\"decision\":\"") + decision + "\"") != std::string::npos;
}

int main() {
  // 1. A good preflight issues a 64-hex ticket and the matching dispatch consumes it exactly once.
  Reset();
  std::string ticket = Preflight(Meta());
  Check(ticket.size() == 64 && IsLowerHexDigest64(ticket) && HasDecision("ordinary"), "preflight_issues_ticket");
  Check(g_sent.back().payload.find("\"classifierVersion\":1") != std::string::npos &&
            g_sent.back().payload.find("\"requestId\":\"request-1\"") != std::string::npos &&
            g_sent.back().payload.find("\"sessionId\":\"session-1\"") != std::string::npos &&
            g_sent.back().payload.find("\"cancelEpoch\":3") != std::string::npos &&
            g_sent.back().payload.find("\"observationRevision\":7") != std::string::npos,
        "receipt_echoes_binding");
  Check(g_shadow.size() == 1 && g_shadow[0].kind == "click" && g_shadow[0].v1_valid && g_shadow[0].v1_ordinary,
        "shadow_gets_an_issued_ticket_as_ordinary");
  Check(Consume(Meta("", ticket)), "matching_dispatch_consumes");
  Check(!Consume(Meta("", ticket)), "second_use_refused");

  // 2. A request without the key is refused and leaves the ticket alone; a wrong token burns it.
  Reset();
  ticket = Preflight(Meta());
  Check(!Consume(Meta()), "no_ticket_refused");
  Check(Consume(Meta("", ticket)), "no_ticket_does_not_burn");
  ticket = Preflight(Meta());
  Check(!Consume(Meta("", std::string(64, 'f'))), "wrong_token_refused");
  Check(!Consume(Meta("", ticket)), "wrong_token_burns_slot");
  Check(!Consume(Meta("", "not-hex")), "malformed_token_refused");

  // 3. Every bound request field: the ticket does not carry over a changed one.
  const auto refused_with = [&](const char *name, const std::string &base_extra,
                                const std::string &changed_extra) {
    Reset();
    const std::string issued = Preflight(Meta(base_extra));
    Check(!issued.empty(), name);
    Check(!Consume(Meta(changed_extra, issued)), name);
  };
  refused_with("payload_text_added", "", ",\"text\":\"a\"");
  refused_with("payload_text_changed", ",\"text\":\"a\"", ",\"text\":\"b\"");
  refused_with("payload_text_removed", ",\"text\":\"a\"", "");
  refused_with("payload_empty_text_differs_from_absent", "", ",\"text\":\"\"");
  refused_with("payload_key_added", "", ",\"key\":\"Enter\"");
  refused_with("payload_key_changed", ",\"key\":\"Enter\"", ",\"key\":\"Escape\"");
  refused_with("payload_target_added", "", ",\"targetId\":\"t1\"");
  refused_with("payload_target_changed", ",\"targetId\":\"t1\"", ",\"targetId\":\"t2\"");
  refused_with("payload_name_changed", ",\"name\":\"press\"", ",\"name\":\"focus\"");
  refused_with("payload_button_changed", ",\"button\":\"left\"", ",\"button\":\"right\"");
  refused_with("payload_value_string_changed", ",\"value\":\"one\"", ",\"value\":\"two\"");
  refused_with("payload_delta_added", "", ",\"deltaY\":5");
  refused_with("payload_deltaX_changed", ",\"deltaX\":1", ",\"deltaX\":2");
  refused_with("payload_toggle_flipped_true_false", ",\"value\":true", ",\"value\":false");
  refused_with("payload_toggle_flipped_false_true", ",\"value\":false", ",\"value\":true");
  refused_with("payload_toggle_dropped", ",\"value\":true", "");
  refused_with("payload_expanded_flipped", ",\"expanded\":true", ",\"expanded\":false");
  refused_with("payload_expanded_added", "", ",\"expanded\":true");
  // Adjacent fields cannot run together into another pair.
  refused_with("payload_adjacent_fields", ",\"text\":\"a\",\"key\":\"bc\"", ",\"text\":\"ab\",\"key\":\"c\"");
  Reset();
  {
    const std::string issued = Preflight(Meta());
    Check(!Consume(Meta("", issued, "request-2")), "request_id_bound");
    Reset();
    const std::string again = Preflight(Meta());
    Check(!Consume(Meta("", again, "request-1", std::string(64, 'b'))), "action_digest_bound");
    Reset();
    const std::string epoch = Preflight(Meta());
    sessions.at(kSessionKey).cancel_epoch = 4;
    Check(!Consume(Meta("", epoch, "request-1", kDigest, 4)), "cancel_epoch_bound");
  }

  // 4. Every part of the window state the ticket was measured against.
  const auto context_refused = [&](const char *name, auto mutate) {
    Reset();
    const std::string issued = Preflight(Meta());
    Check(!issued.empty(), name);
    mutate(sessions.at(kSessionKey));
    Check(!Consume(Meta("", issued)), name);
  };
  context_refused("context_app", [](WindowsSession &s) { s.app_identity = "other"; });
  context_refused("context_window", [](WindowsSession &s) { s.window_identity = "other"; });
  context_refused("context_active_window", [](WindowsSession &s) { s.active_window_identity = "other"; });
  context_refused("context_active_kind", [](WindowsSession &s) { s.active_window_kind = "dialog"; });
  context_refused("context_process_start", [](WindowsSession &s) { s.process_start = "other"; });
  context_refused("context_pid", [](WindowsSession &s) { s.pid = 1; });
  context_refused("context_dialog_digest", [](WindowsSession &s) { s.dialog_set_digest = "other"; });
  context_refused("context_dialog_revision", [](WindowsSession &s) { s.dialog_set_revision = 9; });
  context_refused("context_observation", [](WindowsSession &s) { s.observation_revision = 8; });
  context_refused("context_bounds_left", [](WindowsSession &s) { s.observation_bounds.left = 11; });
  context_refused("context_bounds_bottom", [](WindowsSession &s) { s.observation_bounds.bottom = 221; });
  context_refused("context_focused_signature", [](WindowsSession &s) { s.focused_element_signature = "other"; });
  context_refused("context_focused_presence", [](WindowsSession &s) { s.has_focused_element_signature = false; });

  // 5. The ticket expires, and the clock going backwards is no extension.
  Reset();
  ticket = Preflight(Meta());
  g_now_ns += sprint_coder::computer_use::kNativeOrdinaryTicketTtlNs - 1;
  Check(Consume(Meta("", ticket)), "valid_just_before_expiry");
  Reset();
  ticket = Preflight(Meta());
  g_now_ns += sprint_coder::computer_use::kNativeOrdinaryTicketTtlNs;
  Check(!Consume(Meta("", ticket)), "expired_at_ttl");
  Reset();
  ticket = Preflight(Meta());
  g_now_ns -= 1;
  Check(!Consume(Meta("", ticket)), "clock_backwards_refused");

  // 6. Session boundaries void the ticket.
  Reset();
  ticket = Preflight(Meta());
  InvalidateWindowsTicket(kSessionKey);
  Check(!Consume(Meta("", ticket)), "invalidate_voids_ticket");
  Reset();
  ticket = Preflight(Meta());
  ForgetWindowsTicket(kSessionKey);
  Check(ticket_states.empty() && !Consume(Meta("", ticket)), "forget_voids_ticket");
  Reset();
  Check(!Consume(Meta("", std::string(64, 'c'))), "no_state_refused");

  // 7. A preflight that is refused issues nothing and voids the ticket it replaced.
  Reset();
  ticket = Preflight(Meta());
  g_validate_ok = false;
  const std::string refused = Preflight(Meta());
  Check(refused.empty() && HasDecision("denied") &&
            g_sent.back().payload.find("\"reasonCode\":\"native_stale_target\"") != std::string::npos &&
            g_sent.back().payload.find("\"deniedResult\":\"rejected\"") != std::string::npos,
        "binding_violation_denied_without_ticket");
  g_validate_ok = true;
  Check(!ticket_states.at(kSessionKey).slot.occupied(), "binding_violation_leaves_slot_empty");
  Check(!Consume(Meta("", ticket)), "refused_preflight_voids_prior_ticket");
  Reset();
  g_validate_ok = true;
  g_revalidate_ok = false;
  Check(Preflight(Meta()).empty() && HasDecision("denied"), "revalidate_failure_denied");
  Reset();
  g_focus_ok = false;
  Check(Preflight(Meta()).empty() == false, "click_does_not_check_focus");
  Reset();
  g_focus_ok = false;
  Check(Preflight("{\"type\":\"key\",\"key\":\"Enter\",\"requestId\":\"request-1\",\"actionDigest\":\"" + kDigest +
                  "\",\"cancelEpoch\":3,\"observationRevision\":7}")
            .empty() &&
            HasDecision("denied") &&
            g_sent.back().payload.find("native_focused_target_changed") != std::string::npos,
        "key_requires_focus_signature");
  Reset();
  ticket = Preflight(Meta("", "", "request-1", kDigest, 3, 8));
  Check(ticket.empty() && HasDecision("denied") &&
            g_sent.back().payload.find("native_invalid_action") != std::string::npos,
        "stale_observation_revision_denied");
  Check(g_shadow.size() == 1 && g_shadow[0].kind == "click" && !g_shadow[0].v1_valid && !g_shadow[0].v1_ordinary,
        "shadow_gets_a_failed_binding_as_not_valid");

  // 8. Malformed requests are errors with no ticket and no echoed binding.
  Reset();
  ticket = Preflight(Meta("", "", "request-1", "not-a-digest"));
  Check(ticket.empty() && !g_sent.empty() && g_sent.back().type == MessageType::kError &&
            g_sent.back().payload.find("invalid_action") != std::string::npos,
        "non_hex_action_digest_error");
  Check(g_shadow.empty(), "malformed_request_schedules_no_shadow");
  // A request without a type is denied by V1 and leaves nothing for the shadow to record.
  Reset();
  ticket = Preflight("{\"requestId\":\"request-1\",\"actionDigest\":\"" + kDigest + "\",\"cancelEpoch\":3,\"observationRevision\":7}");
  Check(ticket.empty() && HasDecision("denied") && g_shadow.empty(), "typeless_request_schedules_no_shadow");
  Check(!ticket_states.at(kSessionKey).slot.occupied(), "non_hex_digest_leaves_slot_empty");
  Reset();
  g_sent.clear();
  Frame unknown = PipeFrame(MessageType::kPreflight, 9);
  unknown.header.session_id = IdOf(77);
  HandleWindowsPreflight(nullptr, unknown, Meta());
  Check(!g_sent.empty() && g_sent.back().type == MessageType::kError &&
            g_sent.back().payload.find("session_missing") != std::string::npos,
        "unknown_session_error");
  Check(g_shadow.empty(), "unknown_session_schedules_no_shadow");

  // 9. A failing RNG issues nothing.
  Reset();
  g_rng_ok = false;
  ticket = Preflight(Meta());
  Check(ticket.empty() && HasDecision("denied") &&
            g_sent.back().payload.find("native_ticket_unavailable") != std::string::npos &&
            !ticket_states.at(kSessionKey).slot.occupied(),
        "rng_failure_issues_nothing");
  Check(g_shadow.size() == 1 && g_shadow[0].v1_valid && !g_shadow[0].v1_ordinary,
        "shadow_gets_a_denied_ticket_as_not_ordinary");
  g_rng_ok = true;
  const std::string first = Preflight(Meta());
  g_rng_fill = 0x40;
  const std::string second = Preflight(Meta());
  g_rng_fill = 0x11;
  Check(first.size() == 64 && second.size() == 64 && first != second, "tokens_differ");
  Check(!Consume(Meta("", first)), "newer_preflight_replaces_older_ticket");

  // 10. A request whose dispatch already finished answers replay, with no ticket.
  Reset();
  {
    Frame finished = PipeFrame(MessageType::kDispatch, 0);
    sprint_coder::computer_use::FrameId derived;
    Check(DispatchFrameIdFor("request-1", &derived), "dispatch_frame_id_derived");
    std::cout << "DERIVED_ID:";
    for (const auto byte : derived.bytes) { char buf[3]; std::snprintf(buf, sizeof(buf), "%02x", byte); std::cout << buf; }
    std::cout << "\n";
    finished.header.request_id = derived;
    response_cache.emplace(ResponseCacheKey(finished), CachedResponse{MessageType::kDispatchResult, "digest", "{}", {}});
    ticket = Preflight(Meta());
    Check(ticket.empty() && HasDecision("replay") &&
              g_sent.back().payload.find("\"reasonCode\":null") != std::string::npos &&
              g_sent.back().payload.find("\"deniedResult\":null") != std::string::npos &&
              g_sent.back().payload.find("\"ticket\":null") != std::string::npos,
          "finished_request_answers_replay");
    Check(!ticket_states.at(kSessionKey).slot.occupied(), "replay_issues_no_ticket");
    Check(g_shadow.empty(), "replay_schedules_no_shadow");
    // A different request id is not a replay.
    Check(!Preflight(Meta("", "", "request-2")).empty(), "other_request_is_not_replay");
  }

  // 11. The cached-response identity of a dispatch ignores the ticket, and only the ticket.
  {
    const auto dispatch_frame = [](const std::string &metadata, MessageType type) {
      Frame frame = PipeFrame(type, 5);
      frame.metadata.assign(metadata.begin(), metadata.end());
      frame.header.metadata_bytes = static_cast<std::uint32_t>(metadata.size());
      return frame;
    };
    const std::string base = Meta("", "");
    const auto a = RequestPayloadDigest(dispatch_frame(Meta("", std::string(64, 'a')), MessageType::kDispatch));
    const auto b = RequestPayloadDigest(dispatch_frame(Meta("", std::string(64, 'b')), MessageType::kDispatch));
    const auto none = RequestPayloadDigest(dispatch_frame(Meta(), MessageType::kDispatch));
    Check(a == b && a == none, "replay_identity_ignores_ticket");
    Check(a != RequestPayloadDigest(dispatch_frame(Meta(",\"text\":\"x\"", std::string(64, 'a')), MessageType::kDispatch)),
          "replay_identity_keeps_payload");
    Check(a != RequestPayloadDigest(dispatch_frame(Meta("", std::string(64, 'a'), "request-9"), MessageType::kDispatch)),
          "replay_identity_keeps_request_id");
    Check(RequestPayloadDigest(dispatch_frame(Meta("", std::string(64, 'a')), MessageType::kProbe)) !=
              RequestPayloadDigest(dispatch_frame(Meta("", std::string(64, 'b')), MessageType::kProbe)),
          "non_dispatch_identity_keeps_ticket_text");
    // Only an exact member is dropped; a text that merely mentions one has it escaped and stays.
    const std::string mention = "{\"type\":\"type\",\"text\":\"\\\"ticket\\\":\\\"" + std::string(64, 'a') + "\\\"\"}";
    Check(WithoutDispatchTicket(mention) == mention, "escaped_mention_is_not_a_ticket");
    Check(WithoutDispatchTicket("{\"a\":1,\"ticket\":\"" + std::string(64, 'a') + "\"}") == "{\"a\":1}", "trailing_member_removed");
    Check(WithoutDispatchTicket("{\"ticket\":\"" + std::string(64, 'a') + "\",\"a\":1}") == "{\"a\":1}", "leading_member_removed");
    Check(WithoutDispatchTicket("{\"ticket\":\"short\"}") == "{\"ticket\":\"short\"}", "short_token_untouched");
  }

  // 12. A finished request is answered from the cache whatever ticket it comes back with; the same
  // id with a different payload is a conflict, not a replay.
  Reset();
  {
    const auto dispatch_frame = [](const std::string &metadata) {
      Frame frame = PipeFrame(MessageType::kDispatch, 6);
      frame.metadata.assign(metadata.begin(), metadata.end());
      frame.header.metadata_bytes = static_cast<std::uint32_t>(metadata.size());
      return frame;
    };
    const Frame first = dispatch_frame(Meta("", std::string(64, 'a')));
    Check(RespondAndCache(nullptr, first, MessageType::kDispatchResult, "{\"result\":\"completed\"}"), "cache_first_result");
    for (const std::string &again : {Meta(), Meta("", std::string(64, 'e'))}) {
      g_sent.clear();
      bool replayed = false;
      Check(ReplayCachedResponse(nullptr, dispatch_frame(again), &replayed) && replayed &&
                !g_sent.empty() && g_sent.back().type == MessageType::kDispatchResult &&
                g_sent.back().payload == "{\"result\":\"completed\"}",
            "repeat_without_or_with_other_ticket_gets_cached_result");
    }
    g_sent.clear();
    bool replayed = false;
    Check(ReplayCachedResponse(nullptr, dispatch_frame(Meta(",\"text\":\"x\"", std::string(64, 'a'))), &replayed) &&
              replayed && !g_sent.empty() && g_sent.back().type == MessageType::kError &&
              g_sent.back().payload.find("request_id_conflict") != std::string::npos,
          "changed_payload_is_a_conflict");
  }

  if (g_failures != 0) return 1;
  std::cout << "OK\n";
  return 0;
}
`;

const shadowStub = String.raw`
// The v2 shadow (S5-b-2b) is a separate seam; here only WHAT the V1 preflight hands it is recorded:
// whether V1 could re-validate the binding, and whether it issued its ordinary ticket.
struct ShadowCall { std::string kind; bool v1_valid; bool v1_ordinary; };
std::vector<ShadowCall> g_shadow;
void ScheduleWindowsEffectShadow(const WindowsSession &, const std::string &, const std::string &kind,
                                 bool v1_valid, bool v1_ordinary) noexcept {
  g_shadow.push_back({kind, v1_valid, v1_ordinary});
}
`;

// The shadow wiring has its own seam (a real run against UI Automation); it is cut out here and
// replaced by the recording stub above, so this seam compiles only the V1 preflight.
function cutShadowWiring(text: string): string {
  const from = text.indexOf('// BEGIN effect shadow wiring');
  const endMarker = '// END effect shadow wiring';
  const to = text.indexOf(endMarker, from);
  if (from < 0 || to < 0) throw new Error('Shadow wiring markers changed');
  const withoutShadow = text.slice(0, from) + text.slice(to + endMarker.length);
  // The synchronous interlock entry (S5-c-1) is not called by anything: cut out like the wiring.
  const entryFrom = withoutShadow.indexOf('// BEGIN sync interlock entry');
  const entryEnd = '// END sync interlock entry';
  const entryTo = withoutShadow.indexOf(entryEnd, entryFrom);
  if (entryFrom < 0 || entryTo < 0) throw new Error('Sync interlock entry markers changed');
  return withoutShadow.slice(0, entryFrom) + withoutShadow.slice(entryTo + entryEnd.length);
}

// The click rule (#500 S5-c-2 PR-2) reads the shell's settings and the clock; it has its own
// contract in computer-use-windows-click-rule.test.ts and is not part of the ticket.
function cutClickRule(text: string): string {
  const from = text.indexOf('// BEGIN click rule');
  const endMarker = '// END click rule';
  const to = text.indexOf(endMarker, from);
  if (from < 0 || to < 0) throw new Error('Click rule markers changed');
  return text.slice(0, from) + text.slice(to + endMarker.length);
}

function assembled(): string {
  const cutClock = (text: string): string => {
    const from = text.indexOf('std::uint64_t MonotonicNowNs() {');
    const to = text.indexOf('// Overwrites a secret before', from);
    if (from < 0 || to < 0) throw new Error('MonotonicNowNs markers changed');
    return text.slice(0, from) + text.slice(to);
  };
  return [
    preamble,
    between('std::string JsonEscape(', 'std::string Sha256Bytes('),
    between('struct CachedResponse {', 'struct WindowsSession {'),
    between('// The ordinary dispatch ticket (ADR v2', 'std::uint64_t last_closed_cancel_epoch'),
    between('std::string FrameIdKey(', 'bool StartWindowsSession('),
    between('std::string ErrorPayload(', 'bool Respond('),
    between('std::string ResponseCacheKey(', 'bool RevalidateWindowsTarget('),
    between('bool RespondAndCache(', 'WindowsSession *FindWindowsSession('),
    cutClickRule(
      cutClock(between('bool ValidateWindowsDispatchBinding(', 'bool DispatchWindowsAction(')),
    ),
    shadowStub,
    cutShadowWiring(between('std::string WindowsPreflightReceipt(', 'bool ObserveWindowsWindow(')),
    '}  // namespace\n',
    driver,
  ].join('\n');
}

// Where there is no compiler the test is skipped, except in CI: a runner that cannot compile must
// not turn a behaviour check into a silent pass.
describe.skipIf(compiler === null && process.env['CI'] === undefined)(
  'Windows helper ordinary ticket behaviour seam (S5-a)',
  () => {
    it('issues, binds, consumes and voids the ticket as the contract says', () => {
      expect(compiler, 'a C++ compiler is required to run this seam in CI').not.toBeNull();
      const root = mkdtempSync(join(tmpdir(), 'computer-use-win-ticket-seam-'));
      try {
        const path = join(root, 'seam.cc');
        const binary = join(root, process.platform === 'win32' ? 'seam.exe' : 'seam');
        writeFileSync(path, assembled());
        const command = compiler!.command(path, binary);
        const built = spawnSync(command.file, command.args, {
          encoding: 'utf8',
          timeout: 120_000,
          windowsVerbatimArguments: command.verbatim,
          env: { ...process.env, VSLANG: '1033' },
        });
        expect(built.status, `${compiler!.name}\n${built.stdout}\n${built.stderr}`).toBe(0);
        const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 20_000 });
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(run.stdout).toContain('OK');
        // The frame id the helper derives for a request is the one Main puts on a dispatch frame.
        const derived = /DERIVED_ID:([0-9a-f]{32})/u.exec(run.stdout)?.[1];
        expect(derived).toBe(
          createHash('sha256').update('request:request-1', 'utf8').digest('hex').slice(0, 32),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
