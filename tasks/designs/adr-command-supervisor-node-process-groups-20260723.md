# ADR: Node process supervisor for the first CommandRunner boundary

- Status: Accepted
- Date: 2026-07-23
- Scope: Slice 4.4 CommandRunner

## Context

The product design requires immutable `ExecutionSpec`, process-tree cancellation, PID/start-time ownership checks, and an OS-specific Windows Job Object or adopted alternative. Node core exposes a retained `ChildProcess` handle and Unix process groups, but it does not expose `openat`/`fchdir`/`execve` or Windows Job Objects without adding a native binary and packaging toolchain.

## Decision

The Team MVP uses a Main-owned, non-persistent Node supervisor:

- only an absolute canonical executable plus an argv array is accepted; `shell:true`, stdin, runtime environment deltas, and PATH resolution are rejected;
- executable canonical path, device/inode, size/timestamps/mode, content digest, and Workspace cwd PathGuard identity are sealed before approval and revalidated immediately before `spawn`;
- the effective environment is rebuilt from a small allowlist and explicitly excludes loader, Electron, hook, and credential variables;
- Unix commands use a dedicated process group and group `SIGTERM` followed by `SIGKILL` after a grace period;
- Windows snapshots descendant PIDs and process-start identities before cooperative `taskkill.exe /PID <pid> /T`, then revalidates each retained identity and applies `/F` descendant-first after the grace period. This is the adopted MVP alternative to a Job Object;
- every live command is owned by an in-memory random lease, retained `ChildProcess` handle, PID, process group, and OS process-start identity. The retained lease keeps group ownership after the leader exits so a stubborn descendant still receives the grace-period `SIGKILL`;
- the durable state moves to `starting` before `spawn`; restart never reconnects to or signals a PID from SQLite, and `prepared`/`starting`/`running` rows become `interrupted` with a terminal event;
- completion waits for process `close` and pipe drain. ANSI/control sanitization and credential redaction run before bounded output batches are committed, then published;
- application shutdown first kills and drains owned commands, then closes SQLite.

## Security boundary

This supervisor is an execution-enforcement boundary for user-approved, non-adversarial Team MVP commands; it is not an OS sandbox. Permission and Approval therefore represent it as `full` user authority with an exact command-digest resource, never as Workspace-scoped `read-only`. The Approval Card explicitly warns that the command can access resources outside the Workspace and the network. A command that deliberately creates a new session or otherwise escapes its process group is outside the process-tree guarantee. OS sandbox feasibility remains a stronger future boundary.

Node pathname revalidation narrows but cannot mathematically eliminate the final cwd rename race between the last check and `spawn`. A hard Main-process crash can also leave an already detached OS process alive: restart records the command as `interrupted`, never reconnects, and never automatically retries it, but this Node-only supervisor cannot provide parent-death containment. Accordingly, this slice does not claim handle-relative TOCTOU closure or crash-proof containment, does not auto-allow shell commands, and keeps every CommandRunner request behind explicit approval. A future signed native supervisor/watchdog may replace this adapter without changing `ExecutionSpec` or the durable command protocol.

## Consequences

The design adds no runtime dependency and can be exercised on all three CI operating systems. Windows tree termination must remain a required CI contract test. Persistent/background processes and authenticated restart reconnection remain disabled and are not implemented by this supervisor.
