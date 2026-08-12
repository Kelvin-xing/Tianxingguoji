# P3-01 Synthetic Golden-Scenario Manifest

| Control | Value |
| --- | --- |
| Ticket | `P3-01` Synthetic golden-scenario manifest covers the approved behavior surface |
| Date | 2026-08-11 (Asia/Hong_Kong) |
| Run identifier | `p3-01-synthetic-golden-20260811` |
| Local status | `mapped_not_executed_release_blocked` |
| Decision inputs | `P3-00`; `DEC-026`, `DEC-027`, `DEC-028`, `DEC-029`, `DEC-034`, `DEC-044`, `DEC-057`, `DEC-058` |
| External state | No migration, RDS/Neon write, cloud/network call, real data access, feature enablement, commit, push, deployment, or release action |

## Problem, Stakeholders, And Boundary

Product and Security need a closed, reviewable inventory of Release 1 behavior
before production access or reconstruction work can begin. Engineers and QA need
stable fixture identifiers and checksums so a later implementation matrix can
prove that it executed the approved surface rather than an easier subset.

P3-01 owns only the versioned synthetic fixture contract, its deterministic
local evidence manifest, and a Node readiness test. It maps five approved
`OrganizationRole` values plus bounded CaseCollaborator access; Case,
SchoolTarget, and Task transitions; collaborator scopes/capabilities/expiry;
and empty, long, error, denied, exception, concurrency, replay, and partial
failure shapes. P3-02, not this ticket, executes these scenarios against module
interfaces and stores generated evidence.

The fixtures contain no real person, organization, case, credential, document,
or business data. Proposed Release 1X portal/billing behavior and unresolved
`DP-01` through `DP-12` are explicitly excluded. This ticket does not define
transitions for Task `created` or `overdue`; it records those as observed states
because no approved command semantics exist.

## State, Invariants, And Enforcement

The fixture state is immutable by version: `release1-phase3-golden-v1` contains
one closed file list. The local evidence state is
`coverageStatus: mapped_not_executed`, `releaseState: blocked`, and
`releaseEligible: false`. Product and Security approvals remain
`not_requested`; every listed feature flag remains false.

The readiness test owns these invariants:

- all five approved organization roles and bounded collaborator mode appear in
  13 typed authorization vectors covering assigned/other Advisor, disabled
  actor, expired grant, direct API, ID guessing, search and export behavior;
- 11 approved Case vectors cover seven forward/close commands, pause, resume,
  cancel and Founder-only immediate-prior rollback; 14 negative vectors pin
  actor/reason, open-target/open-task, cancellation and target evidence guards;
- all 14 approved SchoolTarget transitions, all eight approved Task commands,
  and all six CaseOutcome codes are typed; every outcome carries code, date,
  evidence source/reference, actor and record version facts;
- all seven collaborator scopes and three capabilities are represented, grants
  never exceed seven days or the Case end, sensitive scopes require Founder
  approval plus reason, and expiry/revoke/case-close/account-disable/export
  deny immediately;
- 16 named `DEC-057`/`AC-08` failure vectors cover tenant context, migration,
  outbox, S3, index/publication, PII, HK outage, support, failover, scanner,
  provider and reconstruction interruption; stale writes pin the `409
  VERSION_CONFLICT` contract and replay has zero duplicate effects;
- byte counts and SHA-256 values are pinned as independent literals in the test
  and repeated in `evidence/release1/p3-01/manifest.v1.json`;
- every behavior entry conforms to the allowlisted typed-vector envelope, and
  every fixture passes the established Release 1 evidence safety scanner;
  excluded R1X/DP semantics are also rejected directly.

No manifest field grants authorization. Existing module policies remain the
runtime enforcement owners. The evidence manifest proves local inventory
integrity only; changing fixtures and regenerating checksums cannot make a
release eligible without changing the independent test oracle and obtaining
the later named gates.

## Failure, Risk, And Follow-On Contract

A missing file, changed byte count/hash, unrepresented approved surface,
unsafe fixture value, enabled flag, approval claim, or eligible release state
fails the focused test. The original TDD loop used deterministic `ENOENT`
failures for each new fixture slice. The review correction first failed all
five behavior files on the new typed-vector oracle, then replaced the label-only
entries and pinned checksums only after every semantic assertion passed.

Production behavior is not proven here. In particular, this ticket does not
prove module-interface execution, browser/accessibility behavior, RDS
transactions, concurrency under a database, restore, residency, capacity, or
cloud controls. P3-02 must consume this exact version, preserve minimal
counterexamples, and stop at `needs_human` after two repeated failures with no
new evidence. Product and Security review are still required for `G3-1`.

## Deterministic Evidence

`node --test --test-reporter=spec tests/release/phase3-synthetic-readiness.test.ts`
passed `7/7` tests. It verified the closed fixture set, roles, Case/SchoolTarget
transitions, Task matrix, scopes/expiry, edge/failure taxonomy, exact checksums,
the established evidence safety scanner, flags off, and fail-closed release
metadata.

`node --test --test-reporter=spec tests/unit/release1/harness.test.ts` is the
directly relevant existing evidence-harness regression check. It passed `4/4`
tests, including deterministic adapters, injected replay/failure behavior,
fail-closed release eligibility, and rejection of unsafe or mismatched input.

`pnpm lint` and `pnpm build` were not run because repository instructions
prohibit them without separate authorization.
