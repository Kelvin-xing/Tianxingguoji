import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('P3 FE task list/detail use the authoritative Task DTO and routes', async () => {
  const [list, detail, client, directory, detailView] = await Promise.all([
    readFile(new URL('../../../app/(erp)/tasks/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../../app/(erp)/tasks/[taskId]/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../../modules/tasks/client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../components/tasks/TasksDirectory.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../../components/tasks/TaskDetailView.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(list, /<TasksDirectory \/>/)
  assert.match(detail, /<TaskDetailView taskId=\{taskId\} \/>/)
  assert.match(client, /\/api\/v1\/tasks(?:\?case_id=|"|')/)
  assert.doesNotMatch(client, /\/api\/v1\/tasks\/assigned/)
  assert.match(client, /available_transitions/)
  assert.match(directory, /listTasks\(/)
  assert.match(detailView, /available_transitions/)
  assert.match(client, /\/api\/v1\/tasks\/\$\{taskId\}/)
  assert.doesNotMatch(`${list}\n${detail}\n${directory}\n${detailView}`, /f3-client|F3TaskWorkspace|allowed_actions|task_type/)
})

test('P3 FE case sections keep applications/interviews/close separate and contractor redacted', async () => {
  const section = await readFile(new URL('../../../components/cases/F3CaseSection.tsx', import.meta.url), 'utf8')
  const contractor = await readFile(new URL('../../../app/(erp)/contractor/tasks/[taskId]/page.tsx', import.meta.url), 'utf8')
  assert.match(section, /applications/)
  assert.match(section, /interviews/)
  assert.match(section, /Founder 结案/)
  assert.match(contractor, /contractor/)
  assert.doesNotMatch(contractor, /Student|Guardian|Assessment|Document/i)
})
