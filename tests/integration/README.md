# Release 1 Browser Gates

Only browser tests whose contract matches the current Release 1 business rules may produce acceptance evidence.

## Active

- `task-01-case-task-workflow-dev-browser.test.ts`: current Case-linked Task workflow, four active roles, current workspace routes and DTOs.

## Legacy

The older Case, CRM, and document browser harnesses remain in place for historical reference but are explicitly skipped. They contain retired assumptions such as Data Reviewer, Founder-led Case creation, the old account menu, old headings, duplicate merge/undo, or Founder approval of completed Tasks. Their output is not Release 1 acceptance evidence.
