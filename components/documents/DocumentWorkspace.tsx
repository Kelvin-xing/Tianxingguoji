'use client'

import { useEffect, useState } from 'react'
import { createUploadSession, listCaseDocuments, listDocuments, requestDocumentDownload, type DocumentDto } from '@/components/documents/f4-client'
import { EmptyState, LoadingState, UnavailableState } from '@/components/states/WorkspaceState'

export function DocumentWorkspace({ caseId }: { readonly caseId?: string }) {
  const [items, setItems] = useState<readonly DocumentDto[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'unavailable'>('loading')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void (caseId ? listCaseDocuments(caseId) : listDocuments())
      .then((value) => { setItems(value); setState(value.length ? 'ready' : 'empty') })
      .catch(() => setState('unavailable'))
  }, [caseId])

  async function download(item: DocumentDto) {
    if (!caseId) return
    try {
      const intent = await requestDocumentDownload(caseId, item.id, item.version_id)
      const url = (intent as { readonly download_url?: unknown }).download_url
      if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new Error('UNSAFE_DOWNLOAD_INTENT')
      window.location.assign(url)
    } catch { setNotice('下載授權暫時不可用。') }
  }

  if (state === 'loading') return <LoadingState title="正在載入文件" />
  if (state === 'unavailable') return <UnavailableState title="文件服務暫時不可用" />
  if (state === 'empty') return <EmptyState title="目前授權範圍沒有文件" />

  return <div className="workspace-section space-y-4">
    {caseId ? <button className="primary-button" onClick={() => void createUploadSession(caseId, { purpose: 'submission_evidence' }).then(() => setNotice('上載工作階段已登記。')).catch(() => setNotice('上載工作階段暫不可用。'))}>登記上載工作階段</button> : null}
    {items.map((item) => {
      const usable = item.state === 'available' && item.scan_result === 'clean' && item.lifecycle === 'active'
    return <div className="selection-card" key={item.id}><span>{item.id} · {documentPurposeLabel(item.purpose)} · {documentStateLabel(item.state)}</span>{usable && caseId && item.allowed_actions.includes('download') ? <button className="secondary-button" onClick={() => void download(item)}>下載</button> : null}</div>
    })}
    {notice ? <p role="status">{notice}</p> : null}
  </div>
}

function documentPurposeLabel(value: string): string {
  if (value === 'submission_evidence') return '申請證明';
  if (value === 'identity_and_case_evidence') return '身份與案件證明';
  return '業務附件';
}

function documentStateLabel(value: string): string {
  if (value === 'available') return '可使用';
  if (value === 'pending_upload') return '等待上載';
  if (value === 'scanning') return '掃描中';
  if (value === 'rejected') return '已拒絕';
  return '處理中';
}
