# Issue653 POSIX stop confirmation slice

The existing Issue653 requires unconfirmed stops never to become successful exit receipts. Its accepted scope leaves OS descendant discovery and full ownership guarantees outside the adapter ordering change. This follow-up changes only the interpretation of the existing helper's evidence; it does not reopen a closed Issue or claim complete POSIX ownership.

## Change and limits

Only ESRCH confirms a process or process group is gone. EPERM and unknown probe errors keep stop unconfirmed. A failed ps snapshot is distinct from an empty tree and prevents a successful stop result, while known descendants and the existing group still receive bounded stop attempts. The already-signaled negative root PID group is also probed during wait/escalation/final confirmation, so a naturally exited root cannot conceal a same-group survivor. All production POSIX callers already spawn detached; the helper documents this owned-group precondition and rejects invalid nonpositive/noninteger PIDs without signals.

The existing SIGTERM/SIGKILL targets and grace windows are unchanged. Windows Job/taskkill behavior and native source are unchanged. A zombie-retaining init may leave a visible group; this conservatively returns false within the existing bounded waits. Reparented descendants which created a different group before the first snapshot remain untracked. PID reuse and complete POSIX process ownership are not solved. Issue653 remains open.

## Evidence and review

On Windows Node22.23.2, the original source failed six of seven controlled POSIX regressions, while the ESRCH control passed. The updated source passes those seven plus three invalid-PID guards. Tests cover EPERM/unknown errors, unavailable ps, root-exit group survivors, forced escalation, and absent-process controls. These mocked POSIX checks on Windows are not POSIX real-process acceptance.

The Linux/macOS-only synthetic fixture starts a detached root with a same-group child that ignores SIGTERM, naturally closes the root, then checks the child is no longer live after stop. A visible orphan zombie group must remain unconfirmed. Readiness waits and cleanup are bounded; no authenticated CLI or external API is involved. Its actual execution is a CI gate, skipped on Windows.

Independent source review passed without blocker/P1, separately from execution. Native additional build/download hold is respected. Exact remote head, draft PR and Linux/macOS CI results must be recorded before this slice is reported verified.
