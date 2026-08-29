import { Icon } from '@/components/workspace/Icon'
import { loadAuthMode, type AuthMode } from '@/modules/identity/server'

import { DatabaseTestLoginForm } from './DatabaseTestLoginForm'

export const dynamic = 'force-dynamic'

type LoginPageProps = {
  searchParams: Promise<{ error?: string | string[] | undefined }>
}

type LoginPresentation = {
  eyebrow: string
  description: string
  desktopFooter: string
  securityNotice: string
}

const FALLBACK_LOGIN_ERROR = '登入流程未完成，請重新嘗試或聯絡管理員。'

const LOGIN_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  access_denied: '登入驗證未完成，請重新嘗試或聯絡管理員。',
  access_disabled: '此公司帳戶目前已停用。',
  authentication_failed: '登入驗證失敗，請重新嘗試或聯絡管理員。',
  configuration: '登入服務尚未完成部署設定，請聯絡管理員。',
  invalid_local_role: '請選擇有效的登入角色。',
  email_not_verified: '此公司帳戶的電郵尚未驗證。',
  invalid_callback: '登入連結已失效，請重新開始登入。',
  logout_pending: '登出請求尚未完全確認，請稍後重新登入。',
  not_invited: '此帳戶尚未獲邀加入工作台。',
  session_limit: '目前登入工作階段已達上限，請先登出其他裝置。',
  service_unavailable: '登入服務暫時不可用，請聯絡系統管理員。',
}

const DATABASE_TEST_ERROR_CODES = new Set([
  'authentication_failed',
  'configuration',
  'service_unavailable',
])

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const query = await searchParams
  const errorCode = typeof query.error === 'string' ? query.error : undefined
  let authMode: AuthMode | null = null

  try {
    authMode = loadAuthMode()
  } catch {
    // A rejected environment combination must not expose a usable login entry.
  }

  const presentation = getLoginPresentation(authMode)
  const visibleError = getLoginError(authMode, errorCode)

  return (
    <div
      className="min-h-screen grid lg:grid-cols-[1.05fr_.95fr]"
      style={{ background: 'var(--bg)' }}
    >
      <div
        className="hidden lg:flex flex-col justify-between p-12 xl:p-16"
        style={{ background: 'var(--sidebar-bg)', color: '#fff' }}
      >
        <div>
          <BrandMark inverted />
          <div className="max-w-md mt-24">
            <div className="eyebrow" style={{ color: '#93c5fd' }}>
              內部工作台
            </div>
            <h1 className="text-4xl font-semibold leading-tight mt-3">
              把每一個案件，<br />變成可協作的工作面。
            </h1>
            <p className="mt-5 text-sm leading-7" style={{ color: 'var(--sidebar-text)' }}>
              從學生資料到案件、選校、文件與任務，所有需要判斷的資訊集中在同一個工作區。
            </p>
          </div>
        </div>
        <div className="text-xs" style={{ color: 'var(--sidebar-text-muted)' }}>
          {presentation.desktopFooter}
        </div>
      </div>

      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md min-w-0">
          <div className="lg:hidden mb-12">
            <BrandMark />
          </div>

          <div className="mb-8">
            <div className="eyebrow">{presentation.eyebrow}</div>
            <h2 className="text-2xl font-semibold mt-2" style={{ color: 'var(--text-primary)' }}>
              登入工作台
            </h2>
            <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              {presentation.description}
            </p>
          </div>

          {visibleError ? (
            <div className="form-error mb-4" role="alert">
              <Icon name="shield" size={15} />
              <span>{visibleError}</span>
            </div>
          ) : null}

          <LoginEntry authMode={authMode} />

          <div
            className="mt-8 flex items-start gap-2 text-xs leading-5"
            style={{ color: 'var(--text-muted)' }}
          >
            <Icon name="shield" size={15} className="shrink-0 mt-0.5" />
            <span>{presentation.securityNotice}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function LoginEntry({ authMode }: { authMode: AuthMode | null }) {
  if (authMode === 'local-synthetic') {
    return (
      <form action="/api/v1/auth/login" method="post" className="space-y-4">
        <label className="block text-sm font-medium" htmlFor="role">
          登入角色
        </label>
        <select className="w-full" id="role" name="role" defaultValue="founder">
          <option value="founder">Founder</option>
          <option value="admin">Admin</option>
          <option value="advisor">Advisor</option>
          <option value="contractor">Contractor</option>
        </select>
        <button className="primary-button w-full justify-center" type="submit">
          <Icon name="log-in" size={16} />
          使用角色登入
        </button>
      </form>
    )
  }

  if (authMode === 'database-test') return <DatabaseTestLoginForm />

  if (authMode === 'cognito') {
    return (
      <>
        <a href="/api/v1/auth/login" className="primary-button w-full justify-center">
          <Icon name="log-in" size={16} />
          使用公司帳戶登入
        </a>
        <a
          href="/login/activate"
          className="mt-3 block text-center text-sm"
          style={{ color: 'var(--text-secondary)' }}
        >
          第一次使用邀請？啟用公司帳戶
        </a>
      </>
    )
  }

  return null
}

function getLoginPresentation(authMode: AuthMode | null): LoginPresentation {
  if (authMode === 'local-synthetic') {
    return {
      eyebrow: '公司工作台',
      description: '選擇登入角色進入工作台。',
      desktopFooter: '帳戶登入',
      securityNotice: '請使用公司提供的帳戶登入。',
    }
  }

  if (authMode === 'database-test') {
    return {
      eyebrow: '公司工作台',
      description: '使用公司帳戶登入工作台。',
      desktopFooter: '帳戶登入',
      securityNotice: '請使用公司提供的帳戶登入。',
    }
  }

  if (authMode === 'cognito') {
    return {
      eyebrow: '公司工作台',
      description: '使用公司帳戶登入，查看你有權限的案件與學生資料。',
      desktopFooter: '公司登入',
      securityNotice: '登入服務由公司帳戶系統處理。',
    }
  }

  return {
    eyebrow: '公司工作台',
    description: '登入服務目前不可使用，請聯絡系統管理員確認設定。',
    desktopFooter: '登入服務',
    securityNotice: '目前沒有可用的登入方式。',
  }
}

function getLoginError(authMode: AuthMode | null, errorCode: string | undefined): string | undefined {
  if (authMode === null) return LOGIN_ERROR_MESSAGES.configuration
  if (!errorCode) return undefined
  if (authMode === 'database-test' && !DATABASE_TEST_ERROR_CODES.has(errorCode)) {
    return FALLBACK_LOGIN_ERROR
  }
  return LOGIN_ERROR_MESSAGES[errorCode] ?? FALLBACK_LOGIN_ERROR
}

function BrandMark({ inverted = false }: { inverted?: boolean }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div
        className="w-9 h-9 rounded-md flex shrink-0 items-center justify-center"
        style={{ background: 'var(--sidebar-active)', color: '#fff' }}
      >
        <Icon name="sparkles" size={18} />
      </div>
      <div className="min-w-0">
        <div className="font-semibold" style={inverted ? undefined : { color: 'var(--text-primary)' }}>
          天星顧問
        </div>
        <div
          className="text-xs"
          style={{ color: inverted ? 'var(--sidebar-text-muted)' : 'var(--text-muted)' }}
        >
          案件工作台
        </div>
      </div>
    </div>
  )
}
