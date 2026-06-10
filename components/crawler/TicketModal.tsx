'use client'

import { useState } from 'react'
import type { AdmissionRecord } from '@/types'

export function TicketModal({
  school,
  onClose,
  onSubmit,
}: {
  school: AdmissionRecord
  onClose: () => void
  onSubmit: (input: { field: string; description: string; reporter: string }) => Promise<void>
}) {
  const [field, setField] = useState('general')
  const [description, setDescription] = useState('')
  const [reporter, setReporter] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!description.trim()) {
      setError('請描述懷疑錯誤的地方')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSubmit({ field, description, reporter })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失敗')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.45)' }}>
      <div className="w-full max-w-lg rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between p-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>提交資料疑問</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{school.school_name_zh}</div>
          </div>
          <button onClick={onClose} className="text-sm px-2 py-1 rounded" style={{ color: 'var(--text-secondary)' }}>關閉</button>
        </div>
        <div className="p-4 space-y-3">
          <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            欄位
            <select className="mt-1 w-full" value={field} onChange={(e) => setField(e.target.value)}>
              <option value="general">整體資料</option>
              <option value="admission_url">招生連結</option>
              <option value="application_dates">申請日期</option>
              <option value="required_materials">所需文件</option>
              <option value="tuition_info">學費</option>
              <option value="dormitory_info">宿舍</option>
              <option value="school_metadata">學校基本資料</option>
            </select>
          </label>
          <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            問題描述
            <textarea
              className="mt-1 w-full min-h-28"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="例：學費看起來不是最新年度，或招生連結跳到無關頁面"
            />
          </label>
          <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            提交人
            <input className="mt-1 w-full" type="text" value={reporter} onChange={(e) => setReporter(e.target.value)} placeholder="可留空" />
          </label>
          {error && <div className="text-xs" style={{ color: '#dc2626' }}>{error}</div>}
        </div>
        <div className="flex justify-end gap-2 p-4" style={{ borderTop: '1px solid var(--border)' }}>
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-md" style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>取消</button>
          <button onClick={submit} disabled={saving} className="text-sm px-3 py-1.5 rounded-md disabled:opacity-50" style={{ background: 'var(--accent)', color: '#fff' }}>{saving ? '提交中' : '提交 ticket'}</button>
        </div>
      </div>
    </div>
  )
}
