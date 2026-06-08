'use client'

import { useTranslation } from 'react-i18next'

const DIFY_URL = process.env.NEXT_PUBLIC_DIFY_APP_URL

export default function AIPage() {
  const { t } = useTranslation()

  return (
    <div className="h-full flex flex-col space-y-4">
      <div
        className="flex items-center gap-3 p-3.5 rounded-lg"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <div
          className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
          style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
        >
          <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('ai.title')}
          </div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {t('ai.subtitle')}
          </div>
        </div>
      </div>

      {DIFY_URL ? (
        <div
          className="flex-1 overflow-hidden min-h-[600px] rounded-lg"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <iframe
            src={DIFY_URL}
            className="w-full h-full border-0"
            allow="microphone"
            title="Dify AI Assistant"
          />
        </div>
      ) : (
        <div
          className="flex-1 flex flex-col items-center justify-center gap-4 min-h-[400px] rounded-lg"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center"
            style={{ background: 'var(--bg)' }}
          >
            <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" style={{ color: 'var(--text-muted)' }}>
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </div>
          <div className="text-center">
            <div className="text-sm font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>
              {t('ai.not_configured')}
            </div>
            <p className="text-sm max-w-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('ai.setup_instructions')}
            </p>
          </div>
          <div
            className="rounded-md px-4 py-2 text-xs font-mono"
            style={{ background: 'var(--bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            NEXT_PUBLIC_DIFY_APP_URL=https://your-dify-app.dify.ai/...
          </div>
          <div className="text-xs text-center max-w-xs" style={{ color: 'var(--text-muted)' }}>
            部署 Dify 後，在 Vercel 環境變量中設置此值，AI 助理即刻啟用。
          </div>
        </div>
      )}
    </div>
  )
}
