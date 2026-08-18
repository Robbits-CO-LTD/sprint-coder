# Run state schema

Store runtime data outside the target repository:

```text
%LOCALAPPDATA%\Codex\e2e-patrol\<owner-repo>\
  index.json
  <run-id>\
    manifest.json
    events.jsonl
    matrix.md
    findings.json
    report.md
    issues\<fingerprint>.md
    evidence\<fingerprint>\...
```

Do not delete prior runs automatically. Stop the current run when evidence
cannot be written. Treat `index.json` as a cache and verify every recorded
Issue against live GitHub before using it as duplicate proof.

Minimum `manifest.json`:

```json
{
  "schema_version": 1,
  "run_id": "20260730T120000000Z-a1b2c3d4",
  "repository": "owner/repo",
  "repository_root": "C:\\path\\to\\repo",
  "app_target_id": "app@windows",
  "target": "https://example.test",
  "environment": "staging",
  "mode": "smoke",
  "filing_mode": "live",
  "required_phase": "deployed",
  "source_sha": "full-sha",
  "artifact_sha256": null,
  "matrix_hash": null,
  "state": "init",
  "limits": {
    "max_issues": 5,
    "max_minutes": 45
  },
  "created_issues": [],
  "discarded": [],
  "started_at": "UTC ISO-8601",
  "finished_at": null
}
```

Each Finding stores:

```json
{
  "finding_id": "F001",
  "fingerprint": "sha256",
  "case_id": "SMOKE-01",
  "classification": "fail_product",
  "failure_class": "data-not-persisted",
  "severity": "P1",
  "repro_session_ids": ["session-a", "session-b"],
  "expectation_source": "acceptance",
  "promotion": "promotable",
  "dedup_result": "unique",
  "primary_surface": "browser-use",
  "computer_use_reason": null,
  "issue_draft": "issues/sha256.md",
  "issue_url": null
}
```

Minimum `index.json`:

```json
{
  "schema_version": 1,
  "repository": "owner/repo",
  "created_issues": [
    {
      "fingerprint": "sha256",
      "number": 123,
      "url": "https://github.com/owner/repo/issues/123",
      "source_sha": "full-sha",
      "run_id": "run-id",
      "verified_at": "UTC ISO-8601"
    }
  ]
}
```

Write JSON through a temporary file and atomic move when updating an existing
index. Preserve unknown keys so a newer schema is not silently destroyed.

Append every driver selection, observation, promotion decision, hold, and
filing result to `events.jsonl` with `scripts/Write-E2ePatrolRecord.ps1`.
Computer Use records must include one allowed `computer_use_reason`; Browser
Use records must not include one.

Computer Use preflight and cleanup records store window ids plus app ids,
ownership, focus-capture status, close verification, focus restoration, and
discarded-handle status in the event `details`. Raw window titles are omitted
or replaced with hashes.
