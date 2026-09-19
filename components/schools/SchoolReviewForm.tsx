'use client'
import {useEffect,useRef,useState,type FormEvent} from 'react'
import {reviewSchoolChangeRequest,schoolChangeFailure,type SchoolChangeHistoryItem,type SchoolReviewInput} from '@/modules/schools/client'

export function SchoolReviewForm({item,decision,onDone,onDenied,onCancel}:{item:SchoolChangeHistoryItem;decision:'approve'|'reject';onDone:()=>void;onDenied:()=>void;onCancel:()=>void}){
  const [reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[notice,setNotice]=useState('')
  const [saving,setSaving]=useState(false),[pending,setPending]=useState(false),[stale,setStale]=useState(false)
  const attempt=useRef<{command:SchoolReviewInput;key:string}|null>(null),busy=useRef(false),mounted=useRef(false)
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  async function submit(event:FormEvent){
    event.preventDefault();if(busy.current||stale)return
    if(!attempt.current){
      if(!reason.trim()||!confirmed){setNotice('請填寫審批理由並確認已核對資料。');return}
      if(!item.allowed_actions.includes(decision)){onDenied();return}
      attempt.current={key:crypto.randomUUID(),command:{decision,expected_record_version:item.record_version,reason:reason.trim()}}
    }
    busy.current=true;setSaving(true);setNotice('')
    try{await reviewSchoolChangeRequest(item.school_id,item.change_request_id,attempt.current.command,attempt.current.key);if(mounted.current)onDone()}
    catch(error){
      if(!mounted.current)return
      const failure=schoolChangeFailure(error)
      if(failure==='denied'){onDenied();return}
      if(failure==='conflict'){setPending(false);setStale(true);setNotice('資料或審批狀態已變更，請重新載入並核對；原確認不再適用。');return}
      if(failure==='validation'){attempt.current=null;setPending(false);setNotice('審批資料格式不正確，請檢查後重新提交。');return}
      setPending(true);setNotice('尚未確認審批結果。請重試原決定，避免重複處理。')
    }finally{busy.current=false;if(mounted.current)setSaving(false)}
  }
  return <form onSubmit={submit} aria-label={`人工變更 #${item.revision_number} 審批`} className="rounded border p-3 space-y-3" style={{borderColor:'var(--border)'}}>
    <h3 className="font-medium">{decision==='approve'?'批准':'拒絕'}此申請</h3>
    <p>{decision==='approve'?'批准後申請值將成為有效資料。':'拒絕後保留申請及決定紀錄，不修改有效資料。'}</p>
    <fieldset disabled={saving||pending||stale} className="space-y-3">
      <label className="block" htmlFor={`school-review-reason-${item.change_request_id}`}>審批理由</label><textarea id={`school-review-reason-${item.change_request_id}`} value={reason} onChange={event=>setReason(event.target.value)} maxLength={1024} className="block w-full mt-1"/>
      <label className="flex gap-2 items-start"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>我已核對目前有效值、申請值及證據，確認此決定。</label>
    </fieldset>
    <div className="flex flex-wrap gap-2"><button type="submit" disabled={saving||stale} className="rounded border px-3 py-2">{saving?'正在提交…':pending?'重試原決定':decision==='approve'?'確認批准':'確認拒絕'}</button>
      {!saving&&!pending&&<button type="button" onClick={onCancel} className="rounded border px-3 py-2">{stale?'關閉並重新載入':'取消審批'}</button>}</div>
    {notice&&<p role="status">{notice}</p>}
  </form>
}
