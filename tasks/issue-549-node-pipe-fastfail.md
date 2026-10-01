# Issue549 Windows AppContainer Node compatibility

Base28a3b729; actual Windows host yuseipc. Original checkout untouched.

Confirmed old libuv <1.53 cannot reliably create child-process pipe/IPC in AppContainer. This patch adds a compatibility diagnostic preload to sandbox-only NODE_OPTIONS. It preserves ignore/inherit descriptors and unaffected platforms/runtimes. It is not a security boundary: clearing environment or using native bindings can bypass this diagnostic. Existing AppContainer remains the boundary.

Native runner verifies sibling preload against compiled bytes, rejects reparse/missing/tampered files and holds a read-share handle through execution/cleanup. Only the unique per-run SID gets RX on this exact file; no parent directory access is added. Resource is included in local build and Forge extraResource.

Product-path regression found the WindowsJob wrapper did not use request.env. Keeping host preload-free initially discarded sandbox child options. Applying the Main-owned controlled environment after host/native initialization, before native CreateProcess, restored sandbox-only propagation.

Evidence:23 unit PASS; actual yuseipc Node22.23.2 CommandRunner4 PASS including pipe rejection in2.8s, ignore child success, relative entry and CJS/ESM modules; real AppContainer integration PASS15.19s covering 7 pipe/IPC APIs, ignore/inherit, Unicode quoted resource, ESM, npm-test --test child rejection, workspace read/write boundary, ACL restoration, tampered/missing preload refusal before payload. Rust release build PASS. Desktop typecheck and changed lint/format checked.

Two independent design/code review seats (runtime_fixes, independent_fixes): no blocker; both also reviewed actual WindowsJob propagation addition. Future libuv >=1.53 preservation currently VM-covered, not native future-runtime acceptance.

Initial inline-e test fixture triggered Defender event1116/1117 SuspExec and could not launch. Normal file-based fixture works without new detection. No Defender exclusions/settings changed. Default Node24 alias C:/Program Files/nodejs child execution ENOENT remains an unconfirmed environment difference; do not claim Node24 acceptance.

Local Windows package and same-SHA packaged acceptance remain pending. Official Node22.23.3 ZIP35,574,076bytes retrieved for package only, no installation. Its node.exe SHA2569C9245166B4A8E182E0B797DA9C20136117FF24368EAFF1FEC8343A123C8DB0E and valid OpenJS signature/thumbprint5A2C440219B027EF812E24A1E15F671D7CD379DE match repository pins. Existing Electron43.5.0 and pinned managed-local cache reused. No paid API, credential/config/security edits, merge, release or Issue close.
