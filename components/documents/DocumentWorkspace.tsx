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
    } catch { setNotice('下载授权暂时不可用。') }
  }

  if (state === 'loading') return <LoadingState title="正在载入文件" />
  if (state === 'unavailable') return <UnavailableState title="Documents 服务暂时不可用" />
  if (state === 'empty') return <EmptyState title="当前授权范围没有文件" />

  return <div className="workspace-section space-y-4">
    {caseId ? <button className="primary-button" onClick={() => void createUploadSession(caseId, { purpose: 'submission_evidence' }).then(() => setNotice('上传会话已登记。')).catch(() => setNotice('上传会话暂不可用。'))}>注册上传会话</button> : null}
    {items.map((item) => {
      const usable = item.state === 'available' && item.scan_result === 'clean' && item.lifecycle === 'active'
      return <div className="selection-card" key={item.id}><span>{item.id} · {item.purpose} · {item.state}</span>{usable && caseId && item.allowed_actions.includes('download') ? <button className="secondary-button" onClick={() => void download(item)}>下载</button> : null}</div>
    })}
    {notice ? <p role="status">{notice}</p> : null}
  </div>
}
