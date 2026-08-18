# Finding contract

## Promotion gate

An observation becomes a fileable Finding only when every condition is true.

- Classification is `fail_product`.
- The same normalized symptom occurs in two distinct fresh UI sessions.
- The expectation source is `spec`, `issue`, `acceptance`, or `ui-contract`.
- Environment health, artifact binding, UI driver health, and redaction pass.
- The observation is not explained by authentication failure, missing test
  data, a stale build, user interruption, or a known external outage.

Record failed conditions and keep the observation out of GitHub. Do not lower
the gate because the symptom looks severe.

## Failure classes

Use one closed value:

`crash`, `console-error`, `network-5xx`, `data-not-persisted`,
`wrong-value`, `nav-dead-end`, `layout-broken`, `a11y-blocking`,
`perf-timeout`, `state-not-restored`, or `input-behavior`.

Severity is `P0`, `P1`, `P2`, or `P3`. Severity controls ordering only. It does
not bypass the promotion gate and is not added as a GitHub priority label.

## Fingerprint

Generate the fingerprint with `scripts/New-FindingFingerprint.ps1`.

```text
sha256(
  repository
  | app_target_id
  | screen_or_route
  | stable_element_anchor
  | failure_class
  | normalized_expectation_delta
  | viewport_bucket_when_layout_only
)
```

Exclude timestamps, coordinates, run IDs, UUIDs, ports, user names, changing
counts, screenshot hashes, and browser versions. Prefer an accessible role and
name, `data-testid`, or Windows AutomationId for the element anchor.

Use this marker exactly once in the Issue body:

```html
<!-- e2e-patrol:fingerprint=<sha256> -->
```

## Independent reproduction

Return the tested app to its documented initial state between attempts. Use a
new tab or app session and a distinct `session_id`. Repeating a click twice
without resetting state is one reproduction, not two.

The second attempt must follow the same matrix steps and produce the same
failure class and normalized expectation delta. If attempts alternate between
pass and fail, mark `flaky_unresolved`.

## One defect per Issue

Separate Findings when their user impact or likely responsibility differs.
Combine multiple screens only when the observed failure class and a supported
root-cause hint show the same defect. List combined observation points in the
Issue body. Do not combine unrelated failures to fit the five-Issue limit.

## Duplicate decisions

Search in this order:

1. same-run and local verified creation index;
2. open and closed GitHub Issues;
3. open PRs;
4. marker match plus semantic match of screen, symptom, and impact.

Marker-only matches are collision candidates, not proof. A semantic match
without a marker is still a duplicate.

Use these results:

- `unique`: may be filed;
- `duplicate_open`: report the existing Issue and do not file;
- `fix_in_progress`: report the open PR and do not file;
- `regression_hold`: a closed matching Issue exists; do not reopen or refile;
- `collision`: report the marker collision and stop this Finding;
- `dedup_incomplete`: stop all filing until GitHub inventory succeeds.
