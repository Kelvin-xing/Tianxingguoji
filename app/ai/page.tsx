'use client'

import { useTranslation } from 'react-i18next'

const DIFY_URL = process.env.NEXT_PUBLIC_DIFY_APP_URL

export default function AIPage() {
  const { t } = useTranslation()

  return (
    <div className="h-full flex flex-col space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
        <div className="text-2xl">🤖</div>
        <div>
          <div className="font-semibold text-gray-800">{t('ai.title')}</div>
          <div className="text-xs text-gray-400">{t('ai.subtitle')}</div>
        </div>
      </div>

      {DIFY_URL ? (
        <div className="flex-1 bg-white rounded-xl border border-gray-200 overflow-hidden min-h-[600px]">
          <iframe
            src={DIFY_URL}
            className="w-full h-full border-0"
            allow="microphone"
            title="Dify AI Assistant"
          />
        </div>
      ) : (
        <div className="flex-1 bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center gap-4 min-h-[400px]">
          <div className="text-5xl">🔧</div>
          <div className="text-center">
            <div className="font-semibold text-gray-700 mb-2">{t('ai.not_configured')}</div>
            <p className="text-sm text-gray-500 max-w-sm">{t('ai.setup_instructions')}</p>
          </div>
          <div className="mt-2 bg-gray-100 rounded-lg px-4 py-2 text-xs text-gray-600 font-mono">
            NEXT_PUBLIC_DIFY_APP_URL=https://your-dify-app.dify.ai/...
          </div>
          <div className="text-xs text-gray-400 text-center max-w-xs">
            部署 Dify 後，在 Vercel 環境變量中設置此值，AI 助理即刻啟用。
          </div>
        </div>
      )}
    </div>
  )
}
