# Real AI editing repair

## Outcome

Claude, Codex and Ollama now complete an authorized workspace edit, trusted read-back and a real verification command through the Managed Harness on macOS. Existing source changes unrelated to these paths are excluded. Release publication remains outside this task. The user subsequently authorized merging PR #443 and this dependent PR #446.

## Confirmed causes and repairs

- Claude advanced to synthesis on explanatory text before tools. Keep it executing until the final result. Persist explanation text during waiting_approval without resuming the operation or changing the approval.
- The MCP bridge expired ordinary requests after 15 seconds, including requests waiting for human approval. Authenticated managed tools now use the host's one-hour approval budget; authentication and ordinary Team requests retain their original bounds. Disconnect and cancellation still release pending requests.
- Codex received the complete tool catalog but treated exec_command/write_stdin as disabled native tools. Separate these host tool names and map them back to the sealed catalog before dispatch. Explicitly describe the host-tool boundary while retaining read-only native sandbox, no native environments and approval_policy=never. An A/B run with Astra reached real command approval only after the names were separated.
- Older databases retained the original v14 CHECK constraint without starting, even though the current initial schema included it. Migration 82 replaces the command table and preserves output rows transactionally. An old-schema fixture reproduced the live CHECK failure before repair, and verifies output retention and reopen after repair.
- The edit schema accepted missing single-file path/edits and missing batch revisions that execution rejects. Publish the actual conditional requirements and provide actionable schema guidance on malformed requests. Keep path guards, revision checks and Edit Saga unchanged.
- Completion requires a trusted read-back after editing. Tell all three runtimes to do this in addition to user-requested command checks; do not replace the acceptance gate with model claims or process exit codes.
- Empty OpenAI-compatible final responses no longer become successful blank turns. Tool-only intermediate rounds and explicit output-limit errors retain their original handling.
- Codex plugin HTML under .vite-user-data triggered Vite page reloads during inference. Exclude runtime data from source watching.
- Existing Workspace-root egress repairs are required for CLI requests containing Main-generated canonical root metadata. Include the exact-root checks and their credential/local-only counterexamples; unrelated Local AI settings UI work remains separate.

## Model support

Add explicit Claude Fable 5 and 5.1 IDs. The local Claude CLI was updated to 2.1.266. Astra is discovered from the real Codex CLI catalog; retain its advertised effort choices. All three model choices were exercised from the UI before the editing acceptance runs.

For Ollama on this Mac, reuse installed Gemma 4 12B weights with a coding configuration:

```text
FROM gemma4:12b
PARAMETER num_ctx 16384
PARAMETER temperature 0
```

Registered locally as sprint-coder-gemma4:12b-16k. No new weights were downloaded and the original model was not overwritten. The original 4096-token runner was insufficient: server logs showed an initial 3854-token prompt and later rounds beyond 4096. Initial prompt ingestion took about 47 seconds. Allow up to 120 seconds for Ollama tool requests, as already done for local vision; ordinary text-only and cloud deadlines are unchanged.

Reference: https://docs.ollama.com/api/openai-compatibility#setting-the-context-size

## Accepted real runs

| Provider                             | File proof                                                                              | Command proof                                                                          | Final state |
| ------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------- |
| Claude CLI / claude-fable-5-1        | Exact expected bytes after edit and read-back                                           | Python byte comparison, exact nonce marker, exit 0                                     | completed   |
| Codex CLI / gpt-6-astra              | Exact expected bytes after edit and read-back                                           | Python byte comparison, exact nonce marker, exit 0                                     | completed   |
| Ollama / sprint-coder-gemma4:12b-16k | Changed add(a, b) from subtraction to addition; exact source bytes; test file unchanged | Five pre-existing assertions including negative/zero cases, exact nonce marker, exit 0 | completed   |

These are UI-driven real-model runs. Earlier failures and operator-canceled diagnostic attempts were not counted as passes. Gemma e4b-mlx did not complete the original test; the configured 12B lane above is the verified Ollama configuration. Model-independent guarantees do not imply every installed model can reliably use tools.

## Validation and delivery boundary

- Targeted suite: 259 passed, 3 opt-in skips; includes full SQLite and egress integration suites through their Electron ABI bridges.
- Desktop typecheck, targeted lint, Prettier and diff check passed.
- Existing database files were backed up while the application was stopped before migration 82.
- Local evidence: /Users/yusei/sc-real-ai-repair-20260909/accepted-real-ai-evidence.json (metadata, hashes and markers only).
- Before-fix report: /Users/yusei/sc-three-ai-20260909-z_4a7_m3/report.md.
- macOS development build only. Packaged and Windows real-provider acceptance remain unverified.
- This branch starts at PR #443's head. Merge the dependency first and retarget PR #446 to main; verify the latest CI and review findings before merging.

## Fable 5.1 secondary review follow-up

An actual `claude-fable-5-1` read-only review of commit 581f2a8 identified two reproducible contract mismatches and a CLI idle-timeout risk. Independent tests confirmed all three causes:

- Codex execution guidance listed canonical shell names while dynamic tools used `sprint_` aliases. The same pure name mapping now supplies both surfaces, after applying the canonical parent tool ceiling. Claude and Ollama names are unchanged.
- Batch add/update/rename accepted missing content/edits/destination in the published schema even though the parser rejects them. Conditional required fields now agree with execution; revision requirements remain in force.
- Quiet host-tool waits triggered the 90-second CLI idle deadline in both adapters. Fake CLI subprocesses reproduced `RUNTIME_TIMEOUT` using only a scaled idle clock. Activity leases now suspend that clock while known managed tools run; concurrent waits, result release, total timeout and stop/restart are covered. These adapter tests are protocol evidence, not a new real-provider approval wait longer than 90 seconds.

The follow-up checkpoint passed 154 tests in six directly affected suites, desktop typecheck and targeted ESLint. The original three UI-driven real-model acceptance runs above remain the live edit/command evidence. A fresh immutable-head Fable 5.1 review and CI are required before PR #446 merge.
