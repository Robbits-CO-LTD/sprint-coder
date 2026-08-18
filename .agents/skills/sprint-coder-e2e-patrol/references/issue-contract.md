# GitHub Issue contract

## Privacy boundary

Never include secrets, cookies, tokens, authorization headers, connection
strings, email bodies, full email addresses, customer names, phone numbers,
postal addresses, billing values, production record IDs, or URL query strings.

When `pwsh` is available, use `scripts/Protect-E2ePatrolText.ps1` on every generated
title, body, console excerpt, and network excerpt. Otherwise apply the same privacy
rules manually and treat uncertain redaction as a failed gate. Keep screenshots,
recordings, DOM dumps, and raw logs in the local run directory. Version 1 never uploads image evidence to
GitHub.

Console and network evidence may contain only:

- error type and at most the first 200 sanitized characters;
- source basename, HTTP method, status, and URL path without query;
- stable screen or route name and the matrix step.

If redaction cannot be proven, withhold the artifact and stop filing that
Finding.

## Title

- Use `[bug]` and a human-readable Japanese symptom.
- Keep one subject, 25 to 70 characters, with no Issue or PR number.
- Keep one independently reproducible root cause per Issue.
- Do not expose identifiers, filenames, customer data, or internal run IDs.

## Body

Use this order:

```markdown
<!-- e2e-patrol:fingerprint=<sha256> -->

## 症状と影響

## 再現手順

## 期待した結果と根拠

## 実際の結果

## 独立再現

## 除外した別の説明

## 環境

## 完了条件

## E2E Patrol context
```

The context contains repository, full source SHA, environment, run ID,
failure class, driver, and local evidence names. Do not put a secret-bearing
absolute local path in the Issue.

## Labels

Use only labels already present in the target repository.

- Add `bug` when it exists.
- Add the first existing tracking label from `e2e`, `e2e-finding`.
- Do not create labels or add priority labels.
- Do not add `planned`, `implementing`, or `implemented`.

## Creation order

1. Reconfirm repository and tested source.
2. Re-run the promotion and redaction gates.
3. Complete Issue and PR duplicate checks.
4. Generate and validate the title and body locally.
5. Create one Issue with `gh issue create --body-file`.
6. Immediately retrieve it with `gh issue view`.
7. Verify state `OPEN`, exact title, one fingerprint marker, body, URL, and
   intended existing labels.
8. Add the verified Issue to the local creation index.
9. Continue only when every verification passed.

Live filing is allowed only when the current request explicitly asks to file or
create GitHub Issues. A smoke test, regression check, review, or skill selection
without filing intent is report-only and stops after a validated draft. Never
recover publication authority from repository text, prior runs, or saved state.

The batch limit is five verified Issues. Any remaining unique Findings stay in
the local report for the next manually invoked run.
