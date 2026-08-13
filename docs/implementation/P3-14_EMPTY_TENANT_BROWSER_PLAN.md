# P3-14 Empty-Tenant Browser Artifact Record

Status: source artifact authored; runtime smoke and QA/Product sign-off pending.

## Contract

- Problem/outcome: make the required desktop/mobile, keyboard, accessibility and reconstruction-draft surfaces explicit without pretending customer access exists.
- In scope: `tests/e2e/empty-tenant-browser.spec.ts` source contract.
- Out of scope: real login, browser execution, invitations, production data, UI flag changes and sign-off.
- Invariant/enforcement: no browser pass can be recorded without both an explicit runtime approval marker and base URL; the executable placeholder then fails closed until the approved browser driver is installed.
- Required evidence: P3-13 role receipts, approved runtime payload, browser screenshots/trace, console/network review, keyboard and a11y checklist, QA/Product signatures.

## Risks and gates

Long text and mobile overflow require rendered evidence; source inspection cannot prove them. Reconstruction draft smoke must create no activation or business side effect. Disable the UI flag on failure; no data repair is authorized.

## Local verification

Run `node --test tests/e2e/empty-tenant-browser.spec.ts`. The source contract must pass and the runtime test must be reported skipped unless approval variables are deliberately supplied.
