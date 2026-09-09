# Managed command cancellation on Turn stop

## Outcome and boundary

Stopping a Turn must terminate its running managed commands before cancellation cleanup releases custody. This includes commands that already returned a background session. Commands belonging to another Task or Turn and background activities after ordinary successful completion are outside this cancellation scope.

## Root Cause Confirmed

- Reproduction: real Fable 5.1 and Astra, packaged macOS UI, approved a synthetic Python command that writes its PID and waits 120 seconds. Composer stop changed the Turn to canceled, but the command PID remained after 10 seconds. Command persistence became canceled only when the failing test closed the application. No completion marker was written.
- Execution path: default-tools constructs hooks.signal from the Broker call; ManagedCommandSessions.start previously accepted only callback hooks and replaced the caller's signal with an unlinked session controller. RuntimeHost.cancel aborted tool controllers, but the command did not observe that abort. Once exec_command returns a background session, its original tool controller also leaves RuntimeHost's active-call map.
- Independent proof: the session regression starts a real process, aborts the caller and waits five seconds. Before repair it returns null instead of a canceled result. Task shutdown and policy-epoch termination work, excluding an unavailable OS process-termination mechanism.
- Fix: link the caller signal for in-flight and pre-spawn cancellation; explicitly stop sessions owned by the canceled Task/Turn for returned background sessions. Close that Turn's Broker binding to reject new dispatches. Run Runtime and command cancellation together and await both attempts before releasing custody, even if either throws.
- Failed termination is propagated to the existing cancellation quarantine path rather than reported as confirmed stop.

## Validation

The focused before-fix regressions fail on signal propagation, missing Turn-scoped termination and cleanup occurring before command cancellation. After repair, tests cover active-call abort, already-aborted input without spawning, exact Task/Turn ownership, and Runtime failure while command cleanup remains pending. The same real-provider packaged cancellation scenario is the final symptom-gone check.

Evidence directory: /Users/yusei/sc-packaged-acceptance-20260909. The accepted multi-turn editing tests, negative-amount fixture repair and command cancellation tests are separate cases. Auto-preset high-risk denials are intended policy behavior, not fixed by broadening permissions. Local package signing is ad-hoc; notarized distribution and Windows device acceptance remain separate.

## Secondary review follow-up

Fable 5.1 identified two additional failure-path defects. A command-only termination failure now quarantines its owning Task without quarantining every Task using the same CLI; Runtime failures retain the existing kind-level quarantine. Both simultaneous failures are retained and logged. A pre-onStarted CommandRunner error remains failed even if abort races with it; an already-aborted request still returns the runner's normal canceled result without spawning. Repeating Turn termination cannot treat a retained failed session as confirmed stopped. Regression tests cover these failure classifications and retry behavior.

Windows device testing was explicitly deferred by the user on 2026-09-10. macOS package validation continues independently.
