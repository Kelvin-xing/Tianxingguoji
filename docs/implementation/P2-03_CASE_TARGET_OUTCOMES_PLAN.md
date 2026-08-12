# P2-03 Case / SchoolTarget Breadth and CaseOutcome

| Control | Value |
| --- | --- |
| Ticket | `P2-03` Case / SchoolTarget breadth and CaseOutcome enforce approved route guards |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Local status | `implemented_locally_pending_hk_rds_transaction_adapter` |
| Decision inputs | `P2-02`, `OD-04`, `OD-05`, `DEC-004`, `DEC-027`, `DEC-044`, `DEC-058` |
| External state | No migration execution, RDS/Neon write, cloud call, real PII, export, commit, push, deployment, or release action |

## Scope And Boundary

This ticket adds the approved P2 policy for the eight-stage Case lifecycle, versioned `hk_k12_standard_v1` SchoolTarget transitions, and append-only `CaseOutcome` revisions.

It adds only fail-closed route adapters for target transition and outcome correction; there is no local runtime, test-fake, JSON, Neon, or cloud fallback.

It does not change the P1-14 narrow Case transition command, create a database migration, permit a Case re-sign in place, turn pause/cancel into canonical Case stages, implement another route template, write a ServiceGoalOutcome, or expose live write controls while the RDS runtime is unavailable.

## Approved State Policy

The canonical Case stages remain `signed -> background_collection -> school_selection_confirmed -> interview_preparation -> application_submitted -> awaiting_result -> offer_confirmed -> closed`.

The P2 lifecycle overlay is `active | paused | cancelled`; it preserves the canonical Case stage and, for `paused`, the immediately preceding stage.

| Command | Authority | Guard | Result |
| --- | --- | --- | --- |
| Advance | Current Primary Advisor, including a Founder only when named Primary Advisor | Immediate next stage only; `signed -> background_collection` needs P2-02 manifest/background blockers; `background_collection -> school_selection_confirmed` needs manifest/selection blockers | Next canonical stage |
| Pause | Current Primary Advisor with Advisor role | Active non-terminal Case and non-empty reason | `paused` overlay retaining stage |
| Resume | Founder | Stored paused prior stage and non-empty reason | `active` at stored stage only |
| Cancel | Founder | Active Case before `application_submitted` and non-empty reason | `cancelled` overlay retaining stage |
| Close | Founder | `offer_confirmed`, every target terminal with required outcome, no open task | `closed` canonical stage |

There is no re-sign command. `DEC-004` requires a new Case and never rewrites or reopens a closed/cancelled Case. Any absent operation, lifecycle state, or non-immediate stage pair denies; this is the no-invented-semantics guard.

`hk_k12_standard_v1` is versioned template data, not a client assertion. Approved transitions are `candidate -> preparing`, `preparing -> submitted`, `submitted -> interview`, `submitted/interview -> waitlisted|accepted|rejected|withdrawn`, and `waitlisted -> accepted|rejected|withdrawn`. Submission requires due date, checklist-complete receipt, and official submission reference. Interview requires invitation evidence and interview time. Other paths deny.

| Target state | Permitted current outcome code |
| --- | --- |
| `waitlisted` | `waitlisted` |
| `accepted` | `accepted` |
| `rejected` | `rejected` |
| `withdrawn` | `withdrawn`, `not_submitted`, `aborted` |

Each terminal target state requires its outcome in the same command. An outcome includes ISO date plus official portal/letter or Advisor-attested source reference. Corrections append a new revision and advance the outcome token; they never mutate the prior fact.

## Ownership, Transaction, And Errors

`transition-policy.ts` owns pure decisions. `outcome-service.ts` owns command framing, stable errors, idempotency request hashing, and redacted audit/outbox construction. The future HK RDS repository is the enforcement owner.

In one transaction, the RDS adapter must lock and re-read Case, target, current Primary Advisor relation, actor role/case visibility, route-template version, current target/outcome version, and idempotency row. It must re-evaluate policy and atomically write transition, optional immutable outcome revision, audit, outbox, and idempotency receipt or write nothing.

Target writes use `expected_record_version`; corrections use `expected_outcome_record_version`. Stale writes return `409 STALE_VERSION`; changed payload idempotency reuse returns `409 CONFLICT`. Evidence references are hashed for idempotency but omitted from audit/outbox metadata and payloads. Invalid framing is `400`, known invalid/evidence is `422`, auth is `403`, hidden/unknown case or target is `404`, unsupported/template/replay conflict is `409`, and missing Identity/CaseOutcome runtime is `503`.

## Local Evidence

The focused test covers case pause/resume/cancel/close, P2-02 selection blockers, OD-05 submission/interview evidence, terminal atomic outcome creation, append-only correction, current Primary Advisor denial, stale version, required/mismatched outcome denial, and pre-commit failure.

- Initial `node --test tests/integration/case-target-outcome-workflow.test.ts`: `2` pass and `2` fail because the shared audit contract correctly rejected new `outcome_code` metadata. The source was corrected to use existing safe `status` metadata and continue omitting evidence.
- The two initial corrected reruns were blocked before execution by a missing local PreToolUse hook. On 2026-08-10 the parent verification reran `node --test --test-reporter=spec tests/integration/case-target-outcome-workflow.test.ts` without that harness failure: `4` pass, `0` fail. The corrected source is therefore locally focused-passed; no HK RDS adapter/runtime pass is claimed.
- `./node_modules/.bin/tsc --noEmit --pretty false` launched with the initial test and emitted no diagnostics, but no explicit exit status was returned; rerun remains pending after the hook repair.
- `pnpm lint` and `pnpm build` were not run because `AGENTS.md` prohibits them without separate authorization.

## Files

- `modules/cases/transition-policy.ts`
- `modules/cases/outcome-service.ts`
- `modules/cases/outcome-runtime.ts`
- `app/api/v1/cases/[caseId]/school-targets/[targetId]/transitions/route.ts`
- `app/api/v1/cases/[caseId]/school-targets/[targetId]/outcomes/route.ts`
- `tests/fakes/case-target-outcome.ts`
- `tests/integration/case-target-outcome-workflow.test.ts`
