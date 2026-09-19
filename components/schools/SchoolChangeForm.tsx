'use client'
import {useEffect,useRef,useState,type FormEvent} from 'react'
import {schoolChangeFailure,submitSchoolChangeRequest,type ResolvedSchoolDetail,type SchoolChangeInput} from '@/modules/schools/client'
export function SchoolChangeForm({school,field,label,onDone,onDenied,onCancel}:{school:ResolvedSchoolDetail;field:string;label:string;onDone:()=>void;onDenied:()=>void;onCancel:()=>void}){
  const [proposed,setProposed]=useState(''),[reason,setReason]=useState(''),[source,setSource]=useState(''),[quote,setQuote]=useState('')
  const [saving,setSaving]=useState(false),[pending,setPending]=useState(false),[stale,setStale]=useState(false),[notice,setNotice]=useState('')
  const inFlight=useRef(false),mounted=useRef(false)
  const attempt=useRef<{key:string;command:SchoolChangeInput}|null>(null)
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  async function submit(event:FormEvent){
    event.preventDefault()
    if(inFlight.current||stale||!school.change_context.can_submit)return
    if(!attempt.current){
      if(!proposed.trim()||!reason.trim()||!quote.trim()){setNotice('請填寫申請值、理由及證據摘要。');return}
      try{if(new URL(source.trim()).protocol!=='https:')throw new Error()}catch{setNotice('請填寫完整的 HTTPS 證據來源網址。');return}
      attempt.current={key:crypto.randomUUID(),command:{field_name:field,field_class:['school_name_zh','school_name_en','official_website'].includes(field)?'identity':'general',
        expected_effective_value_sha256:school.change_context.effective_value_hashes[field]??school.change_context.empty_value_sha256,
        base_snapshot_id:school.base_snapshot_id,base_value_sha256:school.change_context.base_value_hashes[field]??school.change_context.empty_value_sha256,
        proposed_value:proposed.trim(),reason:reason.trim(),evidence:{source_url:source.trim(),quote:quote.trim()}}}
    }
    inFlight.current=true;setSaving(true);setNotice('')
    try{await submitSchoolChangeRequest(school.school_id,attempt.current.command,attempt.current.key);if(mounted.current)onDone()}
    catch(error){
      if(!mounted.current)return
      const failure=schoolChangeFailure(error)
      if(failure==='denied'){onDenied();return}
      if(failure==='conflict'){setStale(true);setNotice('學校資料已變更，請重新載入並核對後再提交。');return}
      if(failure==='validation'){attempt.current=null;setPending(false);setNotice('資料格式不正確，請檢查後重新提交。');return}
      setPending(true);setNotice('尚未確認提交結果。請重試原申請，避免重複提交。')
    }finally{inFlight.current=false;if(mounted.current)setSaving(false)}
  }
  return <form onSubmit={submit} aria-label={`${label}變更申請`} className="rounded border p-3 space-y-3" style={{borderColor:'var(--border)'}}>
    <h3 className="font-medium">{label}變更申請</h3><p className="text-sm">提交後須經審批才會生效，不會立即修改學校資料。</p>
    <fieldset disabled={saving||pending||stale} className="space-y-3">
      <label className="block text-sm">申請值<input type="text" value={proposed} onChange={e=>setProposed(e.target.value)} maxLength={512} className="block w-full mt-1"/></label>
      <label className="block text-sm">申請理由<textarea value={reason} onChange={e=>setReason(e.target.value)} maxLength={1024} className="block w-full mt-1"/></label>
      <label className="block text-sm">證據來源網址<input type="url" value={source} onChange={e=>setSource(e.target.value)} maxLength={2048} className="block w-full mt-1"/></label>
      <label className="block text-sm">證據摘要<textarea value={quote} onChange={e=>setQuote(e.target.value)} maxLength={1024} className="block w-full mt-1"/></label>
    </fieldset>
    <div className="flex flex-wrap gap-2"><button type="submit" disabled={saving||stale} className="rounded border px-3 py-2 text-sm">{saving?'正在提交…':pending?'重試原申請':'提交審批'}</button>
    {!pending&&!saving&&<button type="button" onClick={onCancel} className="rounded border px-3 py-2 text-sm">{stale?'關閉並重新載入':'取消'}</button>}</div>
    {notice&&<p role="status" className="text-sm">{notice}</p>}
  </form>
}
