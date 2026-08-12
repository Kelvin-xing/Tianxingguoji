# P2-10 Crawler Manifest Gate Plan

| Control | Value |
| --- | --- |
| Ticket | `P2-10` Crawler publisher and consumer enforce exact four-file manifest |
| Date | 2026-08-10 (Asia/Hong_Kong) |
| Run ID | `p2-10-crawler-manifest-20260810` |
| Local status | `implemented_locally_pending_durable_activation_ledger_and_approved_candidate` |
| Decision inputs | `P2-06`, amended `DEC-016`, `DEC-050`, resolved `OD-12`, `AC-21` |
| External state | None: no crawl, publish, snapshot copy/sync/activation, warning acceptance, database/cloud write, commit, push, deploy, deletion, or release action |

## Problem, Outcome, And Boundary

The crawler currently publishes a broad directory and the frontend independently
reads individual JSON files with empty fallbacks. A partial copy, stale optional
file, wrong hash, or malformed file can therefore produce a mixed snapshot. P2-10
must make the crawler handoff one immutable release candidate and make the
frontend validate the whole candidate before it can replace the process's prior
active snapshot.

In scope: a versioned four-file manifest contract, deterministic schema/count/
SHA-256 validation, fail/warn/pass handling, exact OD-12 warning-receipt
validation, atomic local publisher staging, an all-or-nothing frontend adapter,
and synthetic tests. Out of scope: generating crawler facts, accepting a real
warning, copying or activating a real snapshot, overlay reconciliation, changing
SchoolTarget pins, durable RDS activation receipts, deployment, or any release
action.

## Bundle Identity And Schema

The only supported file set is exactly:

1. `records.json`
2. `review_queue.json`
3. `run_summary.json`
4. `publish_manifest.json`

`publish_manifest.json` uses `crawler-handoff/v1`. Its canonical release
descriptor contains the schema version, candidate state, normalized health,
exact warning list, publisher timestamp/identity/notes, and entries for the three payload files. Each entry has a
file schema version, JSON row/object count, byte count, and lowercase SHA-256.
`manifest_sha256` is the SHA-256 of that canonical descriptor, excluding only
the self-hash and warning receipt. This avoids a self-hash cycle while
making any payload, count, schema, health, or warning change produce a new
release identity. The manifest file itself is the fourth file and is validated
by its schema plus canonical `manifest_sha256`; it cannot contain its own raw
file hash without recursion.

`records.json` and `review_queue.json` must be arrays and their counts are array
lengths. `run_summary.json` must be an object and has count `1`. Its declared
record/review counts and health must agree with the other payloads and manifest.
Unknown schema versions, missing or extra files, malformed JSON, wrong counts,
wrong byte counts, or wrong hashes fail closed.

## Warning Receipt And State

The file state is `candidate`; the publisher owns candidate construction but
does not own frontend activation. The frontend adapter validates a candidate
and may make that exact immutable bundle its process-local `active` snapshot.
On every validation/read failure it keeps the prior active snapshot. If no prior
active snapshot exists, it fails closed rather than returning empty data.

`pass` requires an empty warning list and no receipt. `fail` is never
publishable or activatable. `warn` requires one embedded receipt containing:

- a unique receipt ID and the exact `manifest_sha256`;
- the exact ordered warning list;
- Data Reviewer actor ID and `recommend_accept` recommendation;
- Founder actor ID, `accept` decision, and non-empty reason;
- acceptance timestamp and expiry exactly after it and no more than 24 hours.

The receipt must already be effective and unexpired at validation time. A changed manifest or warning
list invalidates it. Re-reading one already-active immutable manifest is
idempotent and is not a second acceptance. Durable cross-process non-reuse must
be enforced by the future HK RDS activation ledger; this ticket neither invents
that adapter nor claims process memory provides durable consumption.

## Ownership, Errors, And Invariants

The crawler publisher owns source validation, canonical manifest construction,
warning-receipt validation, isolated staging, and atomic directory replacement.
It must not remove the prior published run before a complete candidate passes.
The frontend snapshot adapter owns exact-file discovery, independent hash/count/
schema revalidation, warning receipt validation, and active-pointer replacement.
API/data mappers consume only a validated active bundle.

Validation failures use stable machine-readable codes: `FILE_SET_MISMATCH`,
`INVALID_JSON`, `SCHEMA_MISMATCH`, `COUNT_MISMATCH`, `HASH_MISMATCH`,
`HEALTH_FAILED`, and `WARNING_RECEIPT_INVALID`. Publisher CLI failures are
non-zero and occur before pointer mutation. Frontend candidate failures return
the prior active bundle when one exists; otherwise they throw a typed error.

The central invariant is: no consumer-visible snapshot changes unless all four
files describe the same validated release identity. It is enforced independently
at both publisher and frontend adapter boundaries.

## Risk, Recovery, And Harness

- Partial copy or crash: build in a sibling staging directory and rename only
  after full validation; prior target/latest remain unchanged on failure.
- Stale or extra file: exact directory enumeration fails; staging starts empty.
- Concurrent publication: an existing run identity is idempotent only when its
  manifest identity matches; a changed same-name payload conflicts.
- Candidate mutation between reads: frontend hashes bytes read for the candidate
  and promotes only that in-memory parsed bundle; a later load revalidates all
  four files.
- Warning replay: binding and expiry fail closed locally; durable receipt
  consumption remains an explicit activation-ledger prerequisite.
- Schema evolution: unsupported versions fail; a future version requires a new
  validator, never a permissive fallback.

Allowed work is scoped source/doc edits plus synthetic focused `pytest`, Node
tests, `py_compile`, and diff review. Deterministic failure gets one responsible
fix and full focused rerun. Identical transient checks may retry at most three
times; two repeats without new evidence stop in `needs_human`. Frontend
`pnpm lint` and `pnpm build` remain prohibited.

## Acceptance Evidence

Focused fixtures must cover supported pass, missing file, extra file, wrong
hash, wrong count, wrong schema, fail health, warning without receipt, warning
with changed binding, expired receipt, exact valid warning receipt, stale/partial
candidate retention, crash before promotion, and idempotent same-manifest read.
No generated crawler output or committed frontend snapshot is modified.

## Release Gate

This local implementation cannot accept a real warning or publish, copy, sync,
or activate a real snapshot. A real warning requires the exact OD-12 human
receipt and durable activation-ledger evidence. Publisher invocation, snapshot
copy, frontend commit/push, and deployment remain four separately approved
actions. Rollback keeps or restores the previously approved snapshot pointer;
snapshot files and history are never hand-edited.

## Local Verification Evidence

The crawler red step failed during test collection because the new manifest
public contract did not exist. After the minimal implementation, the focused
publisher suite and its production-finish command-construction regression pass:

```text
/Users/mingjiexing/anaconda3/bin/python3 -m pytest \
  apps/crawler/tools/test_publish_run_outputs.py \
  apps/crawler/tools/test_partitioned_workflow_production_finish.py -q

13 passed in 11.95s
```

The frontend red step failed with `ERR_MODULE_NOT_FOUND` for the not-yet-created
snapshot adapter. After implementation, the exact bundle, prior-active
retention, warning denial/acceptance, cold-start denial, missing/extra file, and
schema/count, metadata-binding, and future-receipt denial cases pass:

```text
node --test tests/unit/crawler/snapshot-manifest.test.ts

8 tests, 8 pass, 0 fail
```

`python -m py_compile apps/crawler/tools/publish_run_outputs.py` completed with
exit `0`. `./node_modules/.bin/tsc --noEmit --pretty false` completed with exit
`0` and no diagnostics. The focused tracked-file diff check emitted no
whitespace diagnostics. Frontend `pnpm lint` and `pnpm build` were not run under
repository policy.

No publisher CLI, crawler workflow, snapshot copy/sync, generated-output edit,
warning acceptance, or activation was executed. The committed frontend
snapshot remains the pre-v1 legacy evidence bundle and was deliberately not
modified; a cold runtime using it will fail closed until a separately approved
v1 candidate and durable warning-receipt activation ledger are available.
