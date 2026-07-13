'use client'

import { useEffect, useState, useCallback } from 'react'

// ─── 配置：替換為你的 Google Drive 視頻上傳文件夾 URL ───────────────────────
const GOOGLE_DRIVE_VIDEO_FOLDER_URL =
  'https://drive.google.com/drive/folders/1E26PU25BCUZA_Nxn_eGK6LM41LSPr4tL?usp=sharing'
// ──────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'ts_knowledge_base_v2'

type KBData = {
  videos: Record<string, string>
  schools: Record<string, Record<string, string>>
  cases: Record<string, Record<string, string>>
  strategy: Record<string, string>
  sop: Record<string, string>
}

const DEFAULT_DATA: KBData = {
  videos: {},
  schools: {},
  cases: {},
  strategy: {},
  sop: {},
}

const VIDEO_PROMPTS = [
  {
    id: 'v1',
    title: '視頻 1 — 學術弱但活動少的學生規劃',
    prompt:
      '如果一個申請港大附屬學校的小六學生來找我，他的成績不錯但課外活動很少，我會怎麼規劃他的面試準備？具體會問他哪些問題來了解他？',
  },
  {
    id: 'v2',
    title: '視頻 2 — 家長面試輔導',
    prompt:
      'K12 面試中，家長面試是很多人忽略的環節。我通常如何輔導家長？大陸背景家長最常犯的3個錯誤是什麼？',
  },
  {
    id: 'v3',
    title: '視頻 3 — 成功案例共同點',
    prompt:
      '我見過申請最成功的幾個學生案例，他們有什麼共同點？是什麼讓他們在面試中脫穎而出？是天賦還是準備方式？',
  },
  {
    id: 'v4',
    title: '視頻 4 — 不同學校類型的面試差異',
    prompt:
      '不同類型的香港學校（英制國際校、IB、本地名校、DSS）在面試風格上有什麼本質差異？招生官分別在找什麼類型的孩子？',
  },
  {
    id: 'v5',
    title: '視頻 5 — 面試前核心建議',
    prompt:
      '面試前一周和面試當天，我給學生和家長最核心的3-5條建議是什麼？哪些細節是普通顧問不知道、但我特別在意的？',
  },
  {
    id: 'v6',
    title: '視頻 6 — 最差面試案例復盤',
    prompt:
      '我遇過面試表現最差的案例，問題出在哪裡？如果重來，我會怎麼處理？這個案例讓我改變了什麼做法？',
  },
  {
    id: 'v7',
    title: '視頻 7 — 大陸背景學生的優劣勢',
    prompt:
      '大陸背景的 K12 學生申請香港學校，和本地學生比有什麼優勢和劣勢？哪類大陸背景的孩子最容易被哪類學校接受？',
  },
  {
    id: 'v8',
    title: '視頻 8 — 選校策略量化標準',
    prompt:
      '選校策略中，衝刺/匹配/保底的比例我通常怎麼分配？我用什麼具體標準判斷一所學校是衝刺還是匹配？舉一個例子說明。',
  },
  {
    id: 'v9',
    title: '視頻 9 — PS 對錄取的影響【新增】',
    prompt:
      '在我做過的申請中，PS（個人陳述）對錄取結果的影響有多大？我見過哪些 PS 讓招生官印象深刻，他們的共同特質是什麼？',
    isNew: true,
  },
  {
    id: 'v10',
    title: '視頻 10 — Resume 各校偏好【新增】',
    prompt:
      'Resume（活動清單）方面，各類學校對格式、長度、語言的偏好有什麼不同？什麼樣的活動描述方式最有說服力？',
    isNew: true,
  },
  {
    id: 'v11',
    title: '視頻 11 — 顧問培訓要點【新增】',
    prompt:
      '我對初級顧問最常說的是什麼？他們剛入行時最容易犯哪些錯誤？關於選校和文件準備，我希望他們記住哪三件事？',
    isNew: true,
  },
]

const SCHOOL_FIELDS = [
  { id: 'student_profile', label: '核心學生畫像', rows: 4, hint: '完美申請者的特質、背景、能力組合' },
  { id: 'not_preferred', label: '學校不喜歡的學生類型', rows: 3, hint: '什麼背景的孩子成功率很低？' },
  { id: 'top3_traits', label: 'Top 3 最看重特質（排序）', rows: 3, hint: '第1名最重要' },
  { id: 'bonus_factors', label: '加分項', rows: 3, hint: '有這些背景能顯著提升機率' },
  { id: 'interview_format', label: '面試形式', rows: 3, hint: '流程、時長、語言、有無親子面試' },
  { id: 'student_questions', label: '高頻面試問題（學生，至少5個）', rows: 5, hint: '真實見過的問題' },
  { id: 'parent_questions', label: '高頻面試問題（家長）', rows: 4, hint: '' },
  { id: 'impressive_traits', label: '讓招生官印象深刻的回答特質', rows: 3, hint: '' },
  { id: 'pitfalls', label: '面試常見扣分陷阱', rows: 3, hint: '' },
  { id: 'ps_focus', label: 'PS 評分最看重什麼？', rows: 4, hint: '最關鍵信息，請盡量具體' },
  { id: 'ps_structure', label: '推薦 PS 結構/框架', rows: 4, hint: '' },
  { id: 'ps_traits', label: 'PS 中應突出的學生特質類型', rows: 3, hint: '' },
  { id: 'ps_mistakes', label: 'PS 常犯錯誤', rows: 3, hint: '' },
  { id: 'ps_success_example', label: '成功 PS 真實例子（脫敏描述）', rows: 4, hint: '不需要原文，描述「什麼視角讓 PS 成功」' },
  { id: 'resume_format', label: 'Resume 格式偏好', rows: 3, hint: '長度、語言、排版' },
  { id: 'resume_activities', label: '哪類活動更受重視', rows: 3, hint: '' },
  { id: 'activity_writing', label: '活動描述最佳寫法', rows: 3, hint: '' },
  { id: 'shortlist_criteria', label: '衝刺/匹配/保底判斷標準（量化）', rows: 6, hint: '英語≥X且學術≥Y→Z類' },
]

const STRATEGY_FIELDS = [
  { id: 'decision_criteria', label: '衝刺/匹配/保底判斷框架（量化）', rows: 6, hint: '嘗試寫出具體邏輯規則' },
  { id: 'student_tendencies', label: '不同學生背景的選校傾向規律', rows: 7, hint: '大陸新移民→通常…因為…' },
  { id: 'bad_cases', label: '「不應該申請但家長堅持」的案例', rows: 4, hint: '結果如何？教訓是什麼？' },
  { id: 'reach_ratio', label: '衝刺比例建議（通常是多少）', rows: 3, hint: '' },
  { id: 'safety_floor', label: '保底的底線在哪裡', rows: 3, hint: '任何情況下都要有的保障' },
]

const SOP_FIELDS = [
  { id: 'first_meeting_q', label: '第一次見面必問問題', rows: 8, hint: '哪些是第一次必須收集的？哪些後續可補充？' },
  { id: 'quality_check', label: '提交選校方案前的 Quality Check 標準', rows: 4, hint: '' },
  { id: 'timeline', label: '面試準備時間表（標準版）', rows: 5, hint: '面試前3個月/2個月/1個月/2週/1天' },
  { id: 'result_followup', label: '收到結果後的標準跟進', rows: 4, hint: '錄取/拒絕/候補分別怎麼做' },
]

function AutoSaveTextarea({
  value,
  onChange,
  rows = 4,
  placeholder = '',
}: {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
}) {
  return (
    <textarea
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md px-3 py-2.5 text-sm resize-y border focus:outline-none focus:ring-2 focus:ring-amber-500/40"
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        color: 'var(--text-primary)',
        fontFamily: 'inherit',
        lineHeight: '1.6',
      }}
    />
  )
}

function SectionHeader({ title, filled, total }: { title: string; filled: number; total: number }) {
  const pct = total > 0 ? Math.round((filled / total) * 100) : 0
  return (
    <div className="flex items-center justify-between mb-4">
      <h2
        className="text-base font-semibold"
        style={{ color: 'var(--text-primary)', fontFamily: "'Noto Serif TC', serif" }}
      >
        {title}
      </h2>
      <span
        className="text-xs px-2.5 py-1 rounded-full font-medium"
        style={{
          background: pct === 100 ? 'var(--success-subtle)' : 'var(--surface)',
          color: pct === 100 ? 'var(--success)' : 'var(--text-muted)',
          border: '1px solid var(--border)',
        }}
      >
        {filled}/{total} 已填寫
      </span>
    </div>
  )
}

export default function KnowledgePage() {
  const [data, setData] = useState<KBData>(DEFAULT_DATA)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'videos' | 'schools' | 'strategy' | 'sop'>('videos')
  const [activeSchool, setActiveSchool] = useState('school_0')
  const [schoolNames, setSchoolNames] = useState<Record<string, string>>({ school_0: '' })
  const [exportDone, setExportDone] = useState(false)
  const [dbSaving, setDbSaving] = useState(false)
  const [dbSavedAt, setDbSavedAt] = useState<string | null>(null)
  const [dbError, setDbError] = useState<string | null>(null)

  // Load from DB first, fall back to localStorage
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/knowledge')
        if (res.ok) {
          const remote = await res.json()
          if (remote.updatedAt) {
            setData((remote.data as KBData) ?? DEFAULT_DATA)
            setSchoolNames((remote.schoolNames as Record<string, string>) ?? { school_0: '' })
            setDbSavedAt(remote.updatedAt)
            return
          }
        }
      } catch {}
      // fallback to localStorage
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          setData(parsed.data ?? DEFAULT_DATA)
          setSchoolNames(parsed.schoolNames ?? { school_0: '' })
          setSavedAt(parsed.savedAt ?? null)
        }
      } catch {}
    }
    load()
  }, [])

  // Auto-save to localStorage
  const save = useCallback(
    (nextData: KBData, nextSchoolNames: Record<string, string>) => {
      const payload = { data: nextData, schoolNames: nextSchoolNames, savedAt: new Date().toISOString() }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
      setSavedAt(payload.savedAt)
    },
    []
  )

  // Save to Neon DB
  const saveToDB = useCallback(
    async (nextData: KBData, nextSchoolNames: Record<string, string>) => {
      setDbSaving(true)
      setDbError(null)
      try {
        const res = await fetch('/api/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: nextData, schoolNames: nextSchoolNames }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        setDbSavedAt(json.updatedAt)
      } catch (e) {
        setDbError('儲存失敗，請重試')
      } finally {
        setDbSaving(false)
      }
    },
    []
  )

  const updateVideo = (id: string, val: string) => {
    const next = { ...data, videos: { ...data.videos, [id]: val } }
    setData(next)
    save(next, schoolNames)
  }

  const updateSchool = (schoolKey: string, fieldId: string, val: string) => {
    const next = {
      ...data,
      schools: {
        ...data.schools,
        [schoolKey]: { ...(data.schools[schoolKey] ?? {}), [fieldId]: val },
      },
    }
    setData(next)
    save(next, schoolNames)
  }

  const updateSchoolName = (key: string, name: string) => {
    const next = { ...schoolNames, [key]: name }
    setSchoolNames(next)
    save(data, next)
  }

  const updateField =
    (section: 'strategy' | 'sop') => (id: string, val: string) => {
      const next = { ...data, [section]: { ...data[section], [id]: val } }
      setData(next)
      save(next, schoolNames)
    }

  const addSchool = () => {
    const key = `school_${Date.now()}`
    const nextNames = { ...schoolNames, [key]: '' }
    setSchoolNames(nextNames)
    setActiveSchool(key)
    save(data, nextNames)
  }

  const removeSchool = (key: string) => {
    if (Object.keys(schoolNames).length <= 1) return
    const nextNames = { ...schoolNames }
    delete nextNames[key]
    const nextData = { ...data, schools: { ...data.schools } }
    delete nextData.schools[key]
    setSchoolNames(nextNames)
    setData(nextData)
    setActiveSchool(Object.keys(nextNames)[0])
    save(nextData, nextNames)
  }

  // Export to Markdown
  const exportMarkdown = () => {
    const lines: string[] = ['# 天星國際教育 · 創始人知識庫\n']

    lines.push('## 第一部分：視頻問題筆記\n')
    VIDEO_PROMPTS.forEach((p) => {
      const note = data.videos[p.id]
      lines.push(`### ${p.title}`)
      lines.push(`**問題：** ${p.prompt}\n`)
      if (note) lines.push(`**筆記/摘要：**\n${note}\n`)
      lines.push('')
    })

    lines.push('\n## 第二部分：學校申請偏好卡\n')
    Object.entries(schoolNames).forEach(([key, name]) => {
      if (!name) return
      lines.push(`### ${name}\n`)
      SCHOOL_FIELDS.forEach((f) => {
        const val = data.schools[key]?.[f.id]
        if (val) lines.push(`**${f.label}：**\n${val}\n`)
      })
      lines.push('')
    })

    lines.push('\n## 第三部分：選校決策框架\n')
    STRATEGY_FIELDS.forEach((f) => {
      const val = data.strategy[f.id]
      if (val) lines.push(`### ${f.label}\n${val}\n`)
    })

    lines.push('\n## 第四部分：操作 SOP\n')
    SOP_FIELDS.forEach((f) => {
      const val = data.sop[f.id]
      if (val) lines.push(`### ${f.label}\n${val}\n`)
    })

    const md = lines.join('\n')
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tianxing_knowledge_base_${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(url)
    setExportDone(true)
    setTimeout(() => setExportDone(false), 3000)
  }

  // Count filled fields
  const videoFilled = VIDEO_PROMPTS.filter((p) => (data.videos[p.id] ?? '').trim()).length
  const strategyFilled = STRATEGY_FIELDS.filter((f) => (data.strategy[f.id] ?? '').trim()).length
  const sopFilled = SOP_FIELDS.filter((f) => (data.sop[f.id] ?? '').trim()).length

  const tabs = [
    { id: 'videos' as const, label: '視頻提示', count: `${videoFilled}/${VIDEO_PROMPTS.length}` },
    { id: 'schools' as const, label: '學校偏好卡', count: `${Object.keys(schoolNames).length} 所` },
    { id: 'strategy' as const, label: '選校策略', count: `${strategyFilled}/${STRATEGY_FIELDS.length}` },
    { id: 'sop' as const, label: 'SOP', count: `${sopFilled}/${SOP_FIELDS.length}` },
  ]

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ background: 'var(--bg)' }}>
      {/* Header */}
      <div
        className="px-6 py-4 flex items-center justify-between shrink-0"
        style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
      >
        <div>
          <h1 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            創始人知識庫
          </h1>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {dbSavedAt
              ? `已儲存到雲端 · ${new Date(dbSavedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`
              : savedAt
              ? `本機已儲存 · ${new Date(savedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`
              : '尚未儲存'}
            {dbError && <span style={{ color: 'var(--error, #dc2626)', marginLeft: 6 }}>{dbError}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => saveToDB(data, schoolNames)}
            disabled={dbSaving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors"
            style={{
              background: dbSaving ? 'var(--surface)' : 'var(--accent)',
              color: dbSaving ? 'var(--text-muted)' : '#fff',
              border: '1px solid var(--border)',
              opacity: dbSaving ? 0.7 : 1,
              cursor: dbSaving ? 'not-allowed' : 'pointer',
            }}
          >
            {dbSaving ? (
              '儲存中…'
            ) : (
              <>
                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                儲存到雲端
              </>
            )}
          </button>
          <a
            href={GOOGLE_DRIVE_VIDEO_FOLDER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors"
            style={{
              background: '#1a73e8',
              color: '#fff',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6.18 17l-2.1-3.63L8.5 5.5h7L19.92 13.37 17.82 17H6.18z" opacity=".3" />
              <path d="M2.1 17L7 7.57 11.9 17H2.1zm9.83-11.5L7 13.37 9.1 17h9.73L16.1 13.37 11.93 5.5z" />
            </svg>
            上傳視頻到 Google Drive
          </a>
          <button
            onClick={exportMarkdown}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors"
            style={{
              background: exportDone ? 'var(--success-subtle)' : 'var(--surface)',
              color: exportDone ? 'var(--success)' : 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}
          >
            {exportDone ? (
              '✓ 已下載'
            ) : (
              <>
                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                導出 Markdown（上傳 AI）
              </>
            )}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div
        className="flex gap-0.5 px-4 pt-3 shrink-0"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="px-4 pb-2.5 text-sm font-medium transition-colors flex items-center gap-1.5"
            style={{
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            {tab.label}
            <span
              className="text-xs px-1.5 py-0.5 rounded-full"
              style={{
                background: activeTab === tab.id ? 'var(--accent-subtle)' : 'var(--bg)',
                color: activeTab === tab.id ? 'var(--accent)' : 'var(--text-muted)',
              }}
            >
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

        {/* ─── Videos Tab ─────────────────────────────────────────────── */}
        {activeTab === 'videos' && (
          <>
            <div
              className="rounded-lg p-4 text-sm"
              style={{ background: 'var(--accent-subtle)', color: 'var(--accent)', border: '1px solid var(--accent-border, var(--border))' }}
            >
              <strong>怎麼用：</strong> 對著手機錄製，每段 15-20 分鐘，錄完後點擊右上角「上傳視頻到 Google Drive」上傳。
              這裡的文字框可以貼轉錄文字或關鍵筆記，AI 可以直接閱讀這些內容。
            </div>
            <SectionHeader title="視頻錄製問題（共 11 段）" filled={videoFilled} total={VIDEO_PROMPTS.length} />
            {VIDEO_PROMPTS.map((p) => (
              <div
                key={p.id}
                className="rounded-lg overflow-hidden"
                style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}
              >
                <div
                  className="px-4 py-3 flex items-start justify-between gap-3"
                  style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>
                        {p.title}
                      </span>
                      {p.isNew && (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-semibold"
                          style={{ background: '#fee2e2', color: '#dc2626' }}
                        >
                          NEW
                        </span>
                      )}
                    </div>
                    <p className="text-sm mt-1" style={{ color: 'var(--text-primary)' }}>
                      「{p.prompt}」
                    </p>
                  </div>
                  <a
                    href={GOOGLE_DRIVE_VIDEO_FOLDER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap"
                    style={{ background: '#e8f0fe', color: '#1a73e8' }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 11H7.83l4.88-4.88c.39-.39.39-1.03 0-1.42-.39-.39-1.02-.39-1.41 0l-6.59 6.59c-.39.39-.39 1.02 0 1.41l6.59 6.59c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L7.83 13H19c.55 0 1-.45 1-1s-.45-1-1-1z" transform="rotate(180 12 12)" />
                    </svg>
                    上傳
                  </a>
                </div>
                <div className="p-4">
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-muted)' }}>
                    視頻轉錄文字或關鍵筆記（可選）
                  </label>
                  <AutoSaveTextarea
                    rows={4}
                    value={data.videos[p.id] ?? ''}
                    onChange={(v) => updateVideo(p.id, v)}
                    placeholder="貼入視頻轉錄文字，或記錄關鍵觀點…"
                  />
                </div>
              </div>
            ))}
          </>
        )}

        {/* ─── Schools Tab ────────────────────────────────────────────── */}
        {activeTab === 'schools' && (
          <>
            <div className="flex items-center justify-between">
              <SectionHeader
                title="學校申請偏好卡"
                filled={Object.keys(schoolNames).filter((k) => schoolNames[k]?.trim()).length}
                total={Object.keys(schoolNames).length}
              />
              <button
                onClick={addSchool}
                className="text-xs px-3 py-1.5 rounded font-medium"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                + 添加學校
              </button>
            </div>

            {/* School tabs */}
            <div className="flex gap-2 flex-wrap">
              {Object.keys(schoolNames).map((key) => (
                <button
                  key={key}
                  onClick={() => setActiveSchool(key)}
                  className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
                  style={{
                    background: activeSchool === key ? 'var(--accent)' : 'var(--surface)',
                    color: activeSchool === key ? '#fff' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {schoolNames[key] || `學校 ${Object.keys(schoolNames).indexOf(key) + 1}`}
                </button>
              ))}
            </div>

            {/* Active school form */}
            {activeSchool && (
              <div
                className="rounded-lg overflow-hidden"
                style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}
              >
                <div
                  className="px-4 py-3 flex items-center justify-between"
                  style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}
                >
                  <input
                    type="text"
                    value={schoolNames[activeSchool] ?? ''}
                    onChange={(e) => updateSchoolName(activeSchool, e.target.value)}
                    placeholder="學校名稱（中英文）"
                    className="text-sm font-semibold bg-transparent border-none outline-none flex-1"
                    style={{ color: 'var(--text-primary)' }}
                  />
                  {Object.keys(schoolNames).length > 1 && (
                    <button
                      onClick={() => removeSchool(activeSchool)}
                      className="text-xs px-2 py-1 rounded"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      刪除
                    </button>
                  )}
                </div>
                <div className="p-4 space-y-4">
                  {SCHOOL_FIELDS.map((f) => (
                    <div key={f.id}>
                      <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--text-primary)' }}>
                        {f.label}
                      </label>
                      {f.hint && (
                        <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
                          {f.hint}
                        </p>
                      )}
                      <AutoSaveTextarea
                        rows={f.rows}
                        value={data.schools[activeSchool]?.[f.id] ?? ''}
                        onChange={(v) => updateSchool(activeSchool, f.id, v)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ─── Strategy Tab ────────────────────────────────────────────── */}
        {activeTab === 'strategy' && (
          <>
            <SectionHeader title="選校決策框架" filled={strategyFilled} total={STRATEGY_FIELDS.length} />
            <div
              className="rounded-lg overflow-hidden"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}
            >
              <div className="p-4 space-y-4">
                {STRATEGY_FIELDS.map((f) => (
                  <div key={f.id}>
                    <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--text-primary)' }}>
                      {f.label}
                    </label>
                    {f.hint && (
                      <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
                        {f.hint}
                      </p>
                    )}
                    <AutoSaveTextarea
                      rows={f.rows}
                      value={data.strategy[f.id] ?? ''}
                      onChange={(v) => updateField('strategy')(f.id, v)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ─── SOP Tab ────────────────────────────────────────────────── */}
        {activeTab === 'sop' && (
          <>
            <SectionHeader title="操作 SOP" filled={sopFilled} total={SOP_FIELDS.length} />
            <div
              className="rounded-lg overflow-hidden"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}
            >
              <div className="p-4 space-y-4">
                {SOP_FIELDS.map((f) => (
                  <div key={f.id}>
                    <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--text-primary)' }}>
                      {f.label}
                    </label>
                    {f.hint && (
                      <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
                        {f.hint}
                      </p>
                    )}
                    <AutoSaveTextarea
                      rows={f.rows}
                      value={data.sop[f.id] ?? ''}
                      onChange={(v) => updateField('sop')(f.id, v)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Bottom padding */}
        <div className="h-8" />
      </div>
    </div>
  )
}
