'use client'

import { useTranslation } from 'react-i18next'
import { mockStudents } from '@/lib/mock/students'
import { mockSchools } from '@/lib/mock/schools'

function StatCard({ label, value, icon }: { label: string; value: number; icon: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-center gap-4">
      <div className="text-3xl">{icon}</div>
      <div>
        <div className="text-2xl font-bold text-gray-900">{value}</div>
        <div className="text-sm text-gray-500 mt-0.5">{label}</div>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const { t } = useTranslation()

  const activeStudents = mockStudents.filter(
    (s) => s.status !== 'admitted' && s.status !== 'rejected',
  ).length

  const now = new Date()
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  const pendingDeadlines = mockStudents.filter((s) => {
    const d = new Date(s.deadline)
    return d >= now && d <= in30Days
  }).length

  const upcomingList = mockStudents
    .filter((s) => new Date(s.deadline) >= now)
    .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime())
    .slice(0, 5)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label={t('dashboard.active_students')} value={activeStudents} icon="🎓" />
        <StatCard label={t('dashboard.pending_deadlines')} value={pendingDeadlines} icon="⏰" />
        <StatCard label={t('dashboard.school_db')} value={mockSchools.length} icon="🏫" />
        <StatCard label={t('dashboard.ai_queries')} value={42} icon="🤖" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="font-semibold text-gray-800 mb-4">{t('dashboard.upcoming_deadlines')}</h2>
          <div className="space-y-3">
            {upcomingList.map((s) => {
              const daysLeft = Math.ceil(
                (new Date(s.deadline).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
              )
              const urgent = daysLeft <= 7
              return (
                <div key={s.id} className="flex items-center justify-between text-sm">
                  <div>
                    <span className="font-medium text-gray-800">{s.name_zh}</span>
                    <span className="text-gray-400 ml-2">{s.consultant}</span>
                  </div>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      urgent ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {daysLeft} {t('dashboard.days_left')}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="font-semibold text-gray-800 mb-4">{t('dashboard.crawler_status')}</h2>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">{t('dashboard.crawler_last_run')}</span>
              <span className="font-medium text-gray-800">2026-06-08 03:14</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Phase 1 驗證</span>
              <span className="font-medium text-green-700">86% ✓</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">待審核學校</span>
              <span className="font-medium text-amber-700">
                {mockSchools.filter((s) => s.review_status === 'needs_review').length} 所
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">已審核學校</span>
              <span className="font-medium text-blue-700">
                {mockSchools.filter((s) => s.review_status === 'approved').length} 所
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
