'use client'

import {useRef,useState} from 'react'
import {decidePendingDeletion,classifyPendingDeletionFailure,type PendingDeletionSummary} from '@/modules/crm/client'

export function DeletionDecisionControl({item,busy,onBusy,onCompleted,onDenied,onReload,onReviewing}:{
  item:PendingDeletionSummary;busy:boolean;onBusy:(value:boolean)=>void;
  onReviewing:(value:boolean)=>void;onCompleted:()=>void;onDenied:(unauthenticated:boolean)=>void;onReload:()=>void;
}){
  const [decision,setDecision]=useState<'approve'|'reject'|null>(null)
  const [confirmed,setConfirmed]=useState(false)
  const [message,setMessage]=useState('')
  const [uncertain,setUncertain]=useState(false)
  const [needsReload,setNeedsReload]=useState(false)
  const lock=useRef(false)
  const attempt=useRef<string|null>(null)
  function choose(value:'approve'|'reject'|null){
    onReviewing(value!==null);setDecision(value);setConfirmed(false);setMessage('');setNeedsReload(false);attempt.current=null
  }
  async function submit(){
    if(lock.current||busy||!confirmed||!decision||needsReload)return
    lock.current=true;onBusy(true);setMessage('')
    try{
      attempt.current??=`deletion-decision-${crypto.randomUUID()}`
      await decidePendingDeletion(item,decision,attempt.current)
      onCompleted()
    }catch(error){
      const failure=classifyPendingDeletionFailure(error)
      if(failure==='forbidden'||failure==='unauthenticated'){onDenied(failure==='unauthenticated');return}
      if(failure==='stale'||failure==='conflict'||failure==='not_found'){
        setUncertain(false);setNeedsReload(true);setMessage('資料或申請狀態已變更，請重新載入後再審查。')
      }else if(failure==='validation'){
        setUncertain(false);setMessage('操作未通過檢查，請重新確認。')
      }else{setUncertain(true);setMessage('暫時無法確認處理結果。請重試原決定，系統不會重複處理。')}
    }finally{lock.current=false;onBusy(false)}
  }
  return <div className="space-y-3">
    {!decision?<div className="flex flex-wrap gap-2"><button type="button" className="secondary-button" disabled={busy} onClick={()=>choose('approve')}>批准刪除</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>choose('reject')}>駁回申請</button></div>:
      <div className="space-y-3" role="group" aria-label={`審查 ${item.display_label}`}>
        <p>{decision==='approve'?'批准後，此資料將不再顯示於業務頁面；歷史仍保留，本期不提供恢復。':'駁回後，此資料恢復正常使用，申請與審查歷史仍保留。'}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy||uncertain||needsReload} onChange={event=>setConfirmed(event.target.checked)}/><span>我已核對並確認{decision==='approve'?'批准刪除':'駁回申請'}。</span></label>
        {message?<p role="alert">{message}</p>:null}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="primary-button" disabled={busy||!confirmed||needsReload} onClick={()=>void submit()}>{busy?'處理中…':uncertain?'重試原決定':decision==='approve'?'確認批准':'確認駁回'}</button>
          {needsReload?<button type="button" className="secondary-button" disabled={busy} onClick={onReload}>重新載入審查清單</button>:<button type="button" className="secondary-button" disabled={busy||uncertain} onClick={()=>choose(null)}>取消</button>}
        </div>
      </div>}
  </div>
}
