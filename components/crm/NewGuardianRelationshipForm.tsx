'use client'
import {useRef,useState,type FormEvent} from 'react'
import {createAndAttachGuardian,precheckPotentialDuplicates,classifyGuardianRelationshipFailure,RELATIONSHIP_TYPES,
  type CrmGender,type RelationshipType,type PotentialDuplicateResult,type NewGuardianRelationshipDraft} from '@/modules/crm/client'

const empty={name:'',email:'',phone:'',birth:'',gender:'' as CrmGender|'',type:'parent' as RelationshipType,description:'',legal:false,emergency:false,billing:false,consent:false}
export function NewGuardianRelationshipForm({studentId,busy,relationshipLabels,onBusy,onCreated,onDenied}:{studentId:string;busy:boolean;relationshipLabels:Record<RelationshipType,string>;onBusy:(busy:boolean)=>void;onCreated:()=>Promise<void>;onDenied:(error:unknown)=>void}){
  const [draft,setDraft]=useState(empty)
  const [warning,setWarning]=useState<PotentialDuplicateResult|null>(null)
  const [confirmed,setConfirmed]=useState(false)
  const [message,setMessage]=useState('')
  const lock=useRef(false)
  const attempt=useRef<{fingerprint:string;key:string;payload:NewGuardianRelationshipDraft}|null>(null)
  function change<K extends keyof typeof empty>(field:K,value:typeof empty[K]){
    setDraft(current=>({...current,[field]:value}));setWarning(null);setConfirmed(false);setMessage('');attempt.current=null
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(lock.current||busy)return
    if(!draft.name.trim()||(!draft.email.trim()&&!draft.phone.trim())){setMessage('請填寫姓名，以及電郵或電話其中一項。');return}
    lock.current=true;onBusy(true);setMessage('')
    try{
      const fingerprint=JSON.stringify(draft)
      if(attempt.current?.fingerprint!==fingerprint){
        let check=warning
        if(!check||!confirmed)check=await precheckPotentialDuplicates({kind:'guardian',name:draft.name,email:draft.email||null,phone:draft.phone||null})
        if(check.warnings.length>0&&(!confirmed||warning?.warning_token!==check.warning_token)){setWarning(check);setConfirmed(false);return}
        const payload:NewGuardianRelationshipDraft={guardian:{display_name:draft.name.trim(),email:draft.email.trim()||null,phone:draft.phone.trim()||null,date_of_birth:draft.birth||null,gender:draft.gender||null,warning_token:check.warning_token},
          relationship_type:draft.type,relationship_description:draft.type==='other'?draft.description.trim():null,is_legal_guardian:draft.legal,is_emergency_contact:draft.emergency,is_billing_contact:draft.billing,notification_consent:draft.consent}
        attempt.current={fingerprint,key:`new-guardian-${crypto.randomUUID()}`,payload}
      }
      await createAndAttachGuardian(studentId,attempt.current.payload,attempt.current.key)
      attempt.current=null;setDraft(empty);setWarning(null);setConfirmed(false)
      await onCreated()
    }catch(error){
      const kind=classifyGuardianRelationshipFailure(error)
      if(['forbidden','not_found','unauthenticated'].includes(kind)){onDenied(error);return}
      if(kind==='conflict'){attempt.current=null;setWarning(null);setConfirmed(false);setMessage('資料或重複提示已變更，請再次檢查後提交。')}
      else setMessage(kind==='validation'?'資料未通過檢查，請確認內容。':'暫時無法確認保存結果；保留原內容重試不會重複建立。')
    }finally{lock.current=false;onBusy(false)}
  }
  return <section className="workspace-section"><h3 className="section-title">新建監護人並關聯</h3><p className="section-detail">新增家長及關係一起保存，不會變更主要聯絡人。</p>
    <form className="mt-4" onSubmit={submit}><fieldset disabled={busy} className="grid gap-3">
      <label className="field-label">新監護人姓名<input required maxLength={200} value={draft.name} onChange={e=>change('name',e.target.value)}/></label>
      <label className="field-label">新監護人電郵<input type="email" maxLength={254} value={draft.email} onChange={e=>change('email',e.target.value)}/></label>
      <label className="field-label">新監護人電話<input type="tel" maxLength={40} value={draft.phone} onChange={e=>change('phone',e.target.value)}/></label>
      <label className="field-label">新監護人出生日期<input type="date" value={draft.birth} onChange={e=>change('birth',e.target.value)}/></label>
      <label className="field-label">新監護人性別<select aria-label="新監護人性別" value={draft.gender} onChange={e=>change('gender',e.target.value as CrmGender|'')}><option value="">尚未收集</option><option value="male">男</option><option value="female">女</option><option value="other">其他</option><option value="not_disclosed">不提供</option></select></label>
      <label className="field-label">新監護人關係類型<select aria-label="新監護人關係類型" value={draft.type} onChange={e=>change('type',e.target.value as RelationshipType)}>{RELATIONSHIP_TYPES.map(type=><option key={type} value={type}>{relationshipLabels[type]}</option>)}</select></label>
      {draft.type==='other'?<label className="field-label">新監護人關係說明<input required maxLength={200} value={draft.description} onChange={e=>change('description',e.target.value)}/></label>:null}
      <label><input type="checkbox" checked={draft.legal} onChange={e=>change('legal',e.target.checked)}/> 新監護人是法定監護人</label>
      <label><input type="checkbox" checked={draft.emergency} onChange={e=>change('emergency',e.target.checked)}/> 新監護人是緊急聯絡人</label>
      <label><input type="checkbox" checked={draft.billing} onChange={e=>change('billing',e.target.checked)}/> 新監護人是帳單聯絡人</label>
      <label><input type="checkbox" checked={draft.consent} onChange={e=>change('consent',e.target.checked)}/> 新監護人同意接收通知</label>
      {warning?.warnings.length?<div className="inline-callout flex-col" role="alert"><strong>發現疑似重複監護人</strong><ul>{warning.warnings.map(row=><li key={row.id}>{[row.display_name_hint,row.email_hint,row.phone_hint].filter(Boolean).join(' · ')}</li>)}</ul><p>請先核對；若是同一人，請使用下方「關聯已有監護人」。</p><label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 我已核對，仍要建立另一名監護人。</label></div>:null}
      {message?<p role="alert">{message}</p>:null}
      <button type="submit" className="primary-button" disabled={busy||Boolean(warning?.warnings.length&&!confirmed)}>{busy?'處理中…':'建立並關聯監護人'}</button>
    </fieldset></form>
  </section>
}
