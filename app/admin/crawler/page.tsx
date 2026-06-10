'use client'

import { useEffect, useMemo, useState } from 'react'
import { crawlerApi } from '@/lib/crawler/client'
import type { CrawlerConfig, CrawlerReviewDecision, CrawlerReviewRecord, CrawlerSummary, CrawlerTicket } from '@/types'

const LEVEL_OPTIONS = ['Primary', 'Secondary', 'Post Secondary']

export default function AdminCrawlerPage() {
  const [summary, setSummary] = useState<CrawlerSummary | null>(null)
  const [queue, setQueue] = useState<CrawlerReviewRecord[]>([])
  const [tickets, setTickets] = useState<CrawlerTicket[]>([])
  const [decisions, setDecisions] = useState<CrawlerReviewDecision[]>([])
  const [config, setConfig] = useState<CrawlerConfig | null>(null)
  const [selected, setSelected] = useState<CrawlerReviewRecord | null>(null)
  const [suggestion, setSuggestion] = useState('')
  const [reviewer, setReviewer] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function load() {
    setError('')
    try {
      const [nextSummary, nextQueue, nextTickets, nextDecisions, nextConfig] = await Promise.all([
        crawlerApi.summary(),
        crawlerApi.reviewQueue(),
        crawlerApi.tickets(),
        crawlerApi.reviewDecisions(),
        crawlerApi.config(),
      ])
      setSummary(nextSummary)
      setQueue(nextQueue)
      setTickets(nextTickets)
      setDecisions(nextDecisions)
      setConfig(nextConfig)
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入管理資料失敗，請確認 DATABASE_URL 已在 Vercel/本地環境配置')
    }
  }

  useEffect(() => {
    load()
  }, [])

  const decisionMap = useMemo(() => new Map(decisions.map((decision) => [decision.school_key, decision])), [decisions])
  const openTickets = tickets.filter((ticket) => ticket.status !== 'resolved' && ticket.status !== 'rejected')

  async function saveConfig() {
    if (!config) return
    setMessage('')
    setConfig(await crawlerApi.saveConfig(config))
    setMessage('爬蟲配置已儲存')
  }

  async function saveDecision(status: 'approved' | 'needs_changes') {
    if (!selected) return
    await crawlerApi.saveReviewDecision({ school_key: selected.school_key, status, suggestion, reviewer })
    setSuggestion('')
    setSelected(null)
    setMessage(status === 'approved' ? '已標記通過' : '修改建議已儲存')
    await load()
  }

  async function updateTicket(ticket: CrawlerTicket, status: CrawlerTicket['status']) {
    await crawlerApi.updateTicket({ id: ticket.id, status })
    await load()
  }

  return (
    <div className="space-y-5">
      {error && <div className="p-3 rounded-lg text-sm" style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}>{error}</div>}
      {message && <div className="p-3 rounded-lg text-sm" style={{ background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}>{message}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Metric label="全量學校" value={summary?.total_records || 0} />
        <Metric label="待人工驗證" value={summary?.needs_review || queue.length} tone="warn" />
        <Metric label="未處理 tickets" value={openTickets.length} tone="danger" />
        <Metric label="已處理審核" value={decisions.length} tone="ok" />
      </div>

      <section className="rounded-lg p-4 space-y-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>自動爬蟲配置</h2>
          <button onClick={saveConfig} disabled={!config} className="text-sm px-3 py-1.5 rounded-md disabled:opacity-50" style={{ background: 'var(--accent)', color: '#fff' }}>儲存配置</button>
        </div>
        {config && (
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 text-sm">
            <label className="flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}><input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} />啟用自動爬取</label>
            <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>頻率<select className="mt-1 w-full" value={config.frequency} onChange={(e) => setConfig({ ...config, frequency: e.target.value as CrawlerConfig['frequency'] })}><option value="manual">手動</option><option value="daily">每日</option><option value="weekly">每週</option><option value="monthly">每月</option></select></label>
            <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>並發數<input className="mt-1 w-full" type="number" min={1} max={8} value={config.max_parallel} onChange={(e) => setConfig({ ...config, max_parallel: Number(e.target.value) })} /></label>
            <label className="flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}><input type="checkbox" checked={config.llm_enabled} onChange={(e) => setConfig({ ...config, llm_enabled: e.target.checked })} />開啟 LLM</label>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>更新：{config.updated_at}</div>
            <div className="md:col-span-5 flex flex-wrap gap-2">
              {LEVEL_OPTIONS.map((level) => <label key={level} className="text-xs px-2 py-1 rounded-md" style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}><input className="mr-1" type="checkbox" checked={config.school_levels.includes(level)} onChange={(e) => setConfig({ ...config, school_levels: e.target.checked ? [...config.school_levels, level] : config.school_levels.filter((item) => item !== level) })} />{level}</label>)}
            </div>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_.8fr] gap-4">
        <section className="rounded-lg overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="p-4" style={{ borderBottom: '1px solid var(--border)' }}><h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>人工驗證列表</h2></div>
          <div className="max-h-[620px] overflow-auto divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {queue.slice(0, 160).map((item) => {
              const decision = decisionMap.get(item.school_key)
              return <button key={item.school_key} onClick={() => { setSelected(item); setSuggestion(decision?.suggestion || item.suggested_action || ''); setReviewer(decision?.reviewer || '') }} className="w-full text-left p-3 hover:bg-slate-50" style={{ background: selected?.school_key === item.school_key ? 'var(--accent-subtle)' : 'transparent' }}><div className="flex items-start justify-between gap-3"><div><div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{item.school_name_zh}</div><div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{item.missing_fields || '需要確認來源'}</div></div><span className="text-xs px-2 py-0.5 rounded-full" style={{ background: decision?.status === 'approved' ? '#f0fdf4' : '#fffbeb', color: decision?.status === 'approved' ? '#15803d' : '#b45309' }}>{decision?.status || item.review_priority}</span></div></button>
            })}
          </div>
        </section>

        <div className="space-y-4">
          <section className="rounded-lg p-4 space-y-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>審核操作</h2>
            {selected ? (
              <>
                <div><div className="text-sm font-medium">{selected.school_name_zh}</div><a className="text-xs break-all" style={{ color: 'var(--accent)' }} href={selected.final_admission_url || selected.website} target="_blank" rel="noopener noreferrer">{selected.final_admission_url || selected.website}</a></div>
                <div className="text-xs p-3 rounded" style={{ background: 'var(--bg)', color: 'var(--text-secondary)' }}>{selected.suggested_action || selected.notes || '請人工確認此記錄。'}</div>
                <textarea className="w-full min-h-28" value={suggestion} onChange={(e) => setSuggestion(e.target.value)} placeholder="修改建議或審核備註" />
                <input className="w-full" value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="審核人" />
                <div className="flex gap-2"><button onClick={() => saveDecision('approved')} className="text-sm px-3 py-1.5 rounded-md" style={{ background: '#16a34a', color: '#fff' }}>通過</button><button onClick={() => saveDecision('needs_changes')} className="text-sm px-3 py-1.5 rounded-md" style={{ background: '#d97706', color: '#fff' }}>保存修改建議</button></div>
              </>
            ) : <div className="text-sm" style={{ color: 'var(--text-muted)' }}>從左側選擇一條待審核資料。</div>}
          </section>

          <section className="rounded-lg overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <div className="p-4" style={{ borderBottom: '1px solid var(--border)' }}><h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>用戶 tickets</h2></div>
            <div className="max-h-[360px] overflow-auto divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
              {tickets.length === 0 && <div className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>暫無 ticket</div>}
              {tickets.map((ticket) => <div key={ticket.id} className="p-3 space-y-2"><div className="flex justify-between gap-3"><div><div className="text-sm font-medium">{ticket.school_name_zh}</div><div className="text-xs" style={{ color: 'var(--text-muted)' }}>{ticket.field} · {ticket.reporter || '匿名'}</div></div><span className="text-xs">{ticket.status}</span></div><div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{ticket.description}</div><div className="flex gap-1.5">{(['open', 'reviewing', 'resolved', 'rejected'] as const).map((status) => <button key={status} onClick={() => updateTicket(ticket, status)} className="text-xs px-2 py-1 rounded" style={{ border: '1px solid var(--border)', color: ticket.status === status ? 'var(--accent)' : 'var(--text-secondary)' }}>{status}</button>)}</div></div>)}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'warn' | 'danger' | 'ok' }) {
  const color = tone === 'warn' ? '#d97706' : tone === 'danger' ? '#dc2626' : tone === 'ok' ? '#16a34a' : 'var(--accent)'
  return <div className="p-4 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `3px solid ${color}` }}><div className="text-xl font-bold" style={{ color }}>{value}</div><div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div></div>
}
