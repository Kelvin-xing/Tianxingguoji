import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pagePath = new URL('../../../app/(auth)/login/page.tsx', import.meta.url)
const formPath = new URL('../../../app/(auth)/login/DatabaseTestLoginForm.tsx', import.meta.url)

test('renders mutually exclusive entries from the server auth mode', async () => {
  const source = await readFile(pagePath, 'utf8')

  assert.match(source, /authMode = loadAuthMode\(\)/)
  assert.match(source, /authMode === 'local-synthetic'[\s\S]*name="role"/)
  assert.match(source, /authMode === 'database-test'\) return <DatabaseTestLoginForm \/>/)
  assert.match(source, /authMode === 'cognito'[\s\S]*href="\/login\/activate"/)
  assert.match(source, /return null\s*}/)
})

test('database-test posts exactly email and password with browser credential hints', async () => {
  const source = await readFile(formPath, 'utf8')
  const form = source.match(/<form[\s\S]*?>/)?.[0]
  const inputs = source.match(/<input[\s\S]*?\/>/g) ?? []

  assert.ok(form)
  assert.match(form, /action="\/api\/v1\/auth\/login"/)
  assert.match(form, /method="post"/)
  assert.match(form, /encType="application\/x-www-form-urlencoded"/)
  assert.equal(inputs.length, 2)

  const [email, password] = inputs
  assert.match(email, /id="email"/)
  assert.match(email, /name="email"/)
  assert.match(email, /type="email"/)
  assert.match(email, /autoComplete="username"/)
  assert.match(email, /autoCapitalize="none"/)
  assert.match(email, /spellCheck=\{false\}/)
  assert.match(email, /required/)
  assert.match(password, /id="password"/)
  assert.match(password, /name="password"/)
  assert.match(password, /type="password"/)
  assert.match(password, /autoComplete="current-password"/)
  assert.match(password, /required/)

  assert.deepEqual(inputs.map(fieldName), ['email', 'password'])
  assert.doesNotMatch(source, /name="(?:role|next)"/)
  assert.doesNotMatch(source, /type="hidden"/)
})

test('pending locks duplicate submits without disabling credential inputs', async () => {
  const source = await readFile(formPath, 'utf8')
  const inputs = source.match(/<input[\s\S]*?\/>/g) ?? []
  const preventDefaultCalls = source.match(/event\.preventDefault\(\)/g) ?? []
  const lockIndex = source.indexOf('submissionLocked.current = true')
  const pendingIndex = source.indexOf('setPending(true)')

  assert.match(source, /const submissionLocked = useRef\(false\)/)
  assert.match(source, /if \(submissionLocked\.current\) \{\s*event\.preventDefault\(\)\s*return/)
  assert.equal(preventDefaultCalls.length, 1)
  assert.ok(lockIndex >= 0 && lockIndex < pendingIndex)
  assert.equal(inputs.every((input) => !/disabled/.test(input)), true)
  assert.match(source, /disabled=\{pending\}/)
  assert.match(source, /aria-busy=\{pending\}/)
  assert.match(source, /min-w-28/)
})

test('database-test has explicit labels and no activation or browser storage path', async () => {
  const source = await readFile(formPath, 'utf8')
  const stateInitializers = [...source.matchAll(/useState\(([^)]*)\)/g)].map((match) => match[1])

  assert.match(source, /<label htmlFor="email">/)
  assert.match(source, /<label htmlFor="password">/)
  assert.deepEqual(stateInitializers, ['false'])
  assert.doesNotMatch(source, /\b(?:value|onChange)=/)
  assert.doesNotMatch(source, /localStorage|sessionStorage/)
  assert.doesNotMatch(source, /\/login\/activate|Cognito|香港|organization|capabilit/i)
})

test('database-test copy is synthetic-only and authentication failure stays generic', async () => {
  const source = await readFile(pagePath, 'utf8')
  const databasePresentation = source.match(
    /if \(authMode === 'database-test'\) \{[\s\S]*?\n  }/,
  )?.[0]

  assert.ok(databasePresentation)
  assert.match(databasePresentation, /合成測試帳號/)
  assert.match(databasePresentation, /只包含合成測試資料/)
  assert.match(databasePresentation, /隔離測試環境/)
  assert.doesNotMatch(databasePresentation, /Cognito|香港|生產/)
  assert.match(
    source,
    /authentication_failed: '登入驗證失敗，請重新嘗試或聯絡管理員。'/,
  )
  assert.match(source, /DATABASE_TEST_ERROR_CODES/)
  assert.match(source, /return FALLBACK_LOGIN_ERROR/)
})

function fieldName(input: string): string | undefined {
  return input.match(/name="([^"]+)"/)?.[1]
}
