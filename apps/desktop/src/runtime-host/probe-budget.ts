// Main must wait longer than the Runtime Host's sequential version and authentication probes.
// Keep these budgets in one module so adding another probe cannot silently outrun the hello timer.
export const RUNTIME_VERSION_PROBE_TIMEOUT_MS = 5_000;
export const RUNTIME_AUTH_PROBE_TIMEOUT_MS = 3_000;
export const RUNTIME_HOST_HELLO_TIMEOUT_MS =
  RUNTIME_VERSION_PROBE_TIMEOUT_MS + RUNTIME_AUTH_PROBE_TIMEOUT_MS + 2_000;
