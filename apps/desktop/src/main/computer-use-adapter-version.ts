/**
 * The version of the provider-facing Computer Use grammar (`computer_use_action_v1` plus the fields
 * Main accepts in it). Part of every compatibility permit and of every provider egress audit row, so
 * a permit or a decision made for one grammar is never read as covering another.
 *
 * v2: `finish` may carry the answer to a closed question (T15-2).
 * v3: `copy { targetId }` may be offered, only while the native can read a node (#785 T15-6b).
 * v4: `type` / `set_text` may take `artifactRef` instead of `text`, only while the host can paste and
 *     the session holds an artifact (#785 T15-7).
 *
 * Its own module so that `provider-egress` can name it without importing the planner, which imports
 * `provider-egress`.
 */
export const COMPUTER_USE_PROVIDER_ADAPTER_VERSION = 'computer-use-v4' as const;
