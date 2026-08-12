# P3-02 Synthetic Deterministic Matrix

Status: `needs_human`; the local matrix is internally valid, but mandatory exact-contract gaps remain and `releaseEligible=false`.

## Problem And Boundary

P3-01 defined 108 synthetic Release 1 vectors but did not execute them against existing P0-P2 seams. P3-02 assigns every vector exactly one `executed`, `deferred`, or `unrepresented` disposition and binds the result to redacted evidence.

In scope: focused release tests, the optional evidence coverage contract, and generated synthetic evidence. Out of scope: production behavior, database or cloud activity, R1X Portal/Billing behavior, open DP semantics, deployment, migration, and release approval.

## Model And Invariants

- The P3-01 fixture manifest and five scenario files remain the oracle.
- Every fixture ID occurs exactly once in the matrix.
- `represented = executed + deferred`; `total = represented + unrepresented`.
- Matrix integrity requires `total=108`, `represented=108`, and `unrepresented=0`; those conditions do not make the ticket pass while mandatory rows are deferred.
- An `executed` row names a public locator and records stable expected/observed results.
- A `deferred` row records a later-ticket owner and a concrete absent-seam or contract-gap reason; it never claims execution passed.
- One canonical `coverage/matrix.json` artifact owns the rows. The manifest compiler derives and reconciles all coverage counts from its embedded bytes, while the release test requires those bytes to equal the stored artifact exactly.
- Any row mismatch, missing/duplicate ID, disposition/count mismatch, artifact-byte change, or fixture-manifest hash change fails deterministic verification.
- Deferred coverage produces `coverageStatus=represented_with_deferred`; release eligibility remains false regardless of verification or approval state.

The release test owns row completeness and expected/observed comparison. `createEvidenceManifest` owns coverage count validation, redaction, artifact hashing, deterministic canonical manifest hashing, and fail-closed release eligibility.

## Results

| Disposition | Count | Meaning |
| --- | ---: | --- |
| `executed` | 76 | Existing P0-P2 public seam returned the fixture result. |
| `deferred` | 32 | A named later ticket owns the absent seam or exact-code gap. |
| `unrepresented` | 0 | No approved P3-01 vector was dropped. |
| Total | 108 | Matches the immutable P3-01 vector set. |

Executable coverage includes case and SchoolTarget transition policy, CaseOutcome code/state compatibility, Task transition policy, collaborator scope policy, contractor task access, non-K12 denial, typed `503`, and document-event replay through `processDocumentScanEvent`. Direct calls to the scanner and S3 fakes are not counted as executions.

Three supplemental checks are stored separately from the 108 oracle rows: scan-stuck, outbox-stuck, and critical budget thresholds returned by the public alert catalogue. Their expected and observed values are compared before they may report `passed`. They prove durable alert-threshold wiring, not workload capacity. The accepted API P95 target and representative synthetic load for 100 active/1,000 retained cases, 2,000 schools, and low concurrency remain unexecuted.

The mandatory categories still requiring human-owned follow-on work are:

- negative authorization: generic case read/search/opaque-not-found and data-reviewer seams are absent or return a different public vocabulary;
- concurrency: the existing task seam returns `TASK_STALE_VERSION`, while the oracle requires `VERSION_CONFLICT`;
- replay: the idempotency contract returns `replay`, while the oracle requires `duplicate` (document-event replay does match exactly);
- partial failure: scanner timeout is normalized to `DOCUMENT_SCAN_RETRYABLE`, and migration, outbox poison, unknown commit, mandatory audit, region, provider, tenant-context, stale-index, missed-event and reconstruction codes have no matching P0-P2 public result;
- capacity: threshold definitions are verified, but the accepted workload and latency targets have not been executed.

## Evidence And Verification

- `tests/release/phase3-deterministic-matrix.test.ts`
- `tests/unit/release1/harness.test.ts`
- `evidence/release1/p3-02/coverage/matrix.json`
- `evidence/release1/p3-02/manifest-input.json`
- `evidence/release1/p3-02/manifest.json`

Observed TDD red states:

- Optional coverage was absent from the compiled manifest.
- The matrix initially detected duplicate aliased IDs, missing evidence files, result-code drift, and scanner-rejected evidence text.
- The review correction then failed on a public-seam mismatch recorded as an executed result and on the missing canonical matrix binding; both are now fail-closed.

The implementation preserves the smallest exact-code counterexamples in the matrix and corrected only test/evidence tooling; P3-01 fixtures and production modules were not changed. Focused verification used `node --test --experimental-strip-types` for P3-02, the harness, and unchanged P3-01 only. No lint, build, typecheck, external service, database, cloud, commit, push, deploy, or migration action was run.
