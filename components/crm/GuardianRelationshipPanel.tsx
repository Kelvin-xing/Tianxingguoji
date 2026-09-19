'use client'

import Link from 'next/link'
import {NewGuardianRelationshipForm} from './NewGuardianRelationshipForm'
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import {getWorkspaceAccessSnapshot} from '@/modules/access/client'
import {getStudent,getGuardianRelationships,searchGuardians,attachGuardianRelationship,handoffPrimaryGuardian,endGuardianRelationship,
  classifyGuardianRelationshipFailure,RELATIONSHIP_TYPES,type GuardianRelationshipsView,type GuardianContactHint,type RelationshipType} from '@/modules/crm/client'

const labels:Record<RelationshipType,string>={parent:'家長',father:'父親',mother:'母親',step_parent:'繼父母',stepfather:'繼父',stepmother:'繼母',adoptive_parent:'養父母',adoptive_father:'養父',adoptive_mother:'養母',foster_parent:'寄養父母',foster_father:'寄養父',foster_mother:'寄養母',grandparent:'祖父母',paternal_grandfather:'祖父',paternal_grandmother:'祖母',maternal_grandfather:'外祖父',maternal_grandmother:'外祖母',adult_sibling:'成年兄弟姊妹',adult_brother:'成年兄弟',adult_sister:'成年姊妹',uncle:'叔伯或舅父',aunt:'姑姨',court_appointed_guardian:'法院指定監護人',institutional_guardian:'機構監護人',other_relative:'其他親屬',non_relative_guardian:'非親屬監護人',other:'其他'}
type Action={kind:'attach';guardianId:string;relationshipType:RelationshipType;description:string;legal:boolean;emergency:boolean;billing:boolean;consent:boolean}|{kind:'handoff';guardianId:string;version:number}|{kind:'end';relationshipId:string;version:number}

export function GuardianRelationshipPanel({studentId}:{readonly studentId:string}){
  const [view,setView]=useState<GuardianRelationshipsView|null>(null)
  const [canManage,setCanManage]=useState(false)
  const [state,setState]=useState<'loading'|'ready'|'denied'|'error'>('loading')
  const [notice,setNotice]=useState('')
  const [busy,setBusy]=useState(false)
  const locked=useRef(false)
  const attempt=useRef<{fingerprint:string;key:string}|null>(null)
  const [query,setQuery]=useState('')
  const [searched,setSearched]=useState(false)
  const [candidates,setCandidates]=useState<readonly GuardianContactHint[]>([])
  const [selected,setSelected]=useState('')
  const [relationshipType,setRelationshipType]=useState<RelationshipType>('parent')
  const [description,setDescription]=useState('')
  const [legal,setLegal]=useState(false)
  const [emergency,setEmergency]=useState(false)
  const [billing,setBilling]=useState(false)
  const [consent,setConsent]=useState(false)
  const [successor,setSuccessor]=useState('')
  const [confirmed,setConfirmed]=useState(false)
  const [endTarget,setEndTarget]=useState('')
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    const [next,access,student]=await Promise.all([getGuardianRelationships(studentId,signal),getWorkspaceAccessSnapshot(signal),getStudent(studentId,signal)])
    if(signal?.aborted)return
    setView(next);setCanManage(access.capabilities.includes('students.guardians.manage')&&student.status==='active');setState('ready')
    setCandidates([]);setSelected('');setSearched(false);setSuccessor('');setConfirmed(false);setEndTarget('')
  },[studentId,setView,setCanManage,setState,setCandidates,setSelected,setSearched,setSuccessor,setConfirmed,setEndTarget])
  function failure(error:unknown){
    const kind=classifyGuardianRelationshipFailure(error)
    if(['forbidden','not_found','unauthenticated'].includes(kind)){setView(null);setCandidates([]);setCanManage(false);setState('denied');return}
    setNotice(kind==='stale'?'資料版本已更新，請重新載入後操作。':kind==='validation'?'請檢查所填資料。':kind==='conflict'?'目前關係狀態不允許此操作，請重新載入確認。':'服務暫時不可用。可保留原內容重試，系統不會重複處理。')
  }
  useEffect(()=>{const controller=new AbortController();void Promise.resolve().then(()=>refresh(controller.signal)).catch(error=>{if(!controller.signal.aborted){setState('error');failure(error)}});return()=>controller.abort()},[refresh])
  async function search(event:FormEvent){
    event.preventDefault();if(locked.current)return;locked.current=true;setBusy(true);setNotice('');setCandidates([]);setSelected('');setSearched(false)
    try{setCandidates(await searchGuardians(studentId,query));setSearched(true)}catch(error){failure(error)}finally{locked.current=false;setBusy(false)}
  }
  async function mutate(action:Action){
    if(locked.current||!canManage)return
    locked.current=true;setBusy(true);setNotice('')
    const fingerprint=JSON.stringify(action)
    if(attempt.current?.fingerprint!==fingerprint)attempt.current={fingerprint,key:`guardian-${crypto.randomUUID()}`}
    const key=attempt.current.key
    try{
      if(action.kind==='attach')await attachGuardianRelationship(studentId,{guardian_id:action.guardianId,relationship_type:action.relationshipType,relationship_description:action.relationshipType==='other'?action.description.trim():null,is_legal_guardian:action.legal,is_emergency_contact:action.emergency,is_billing_contact:action.billing,notification_consent:action.consent},key)
      else if(action.kind==='handoff')await handoffPrimaryGuardian(studentId,action.guardianId,action.version,key)
      else await endGuardianRelationship(studentId,action.relationshipId,action.version,key)
      attempt.current=null
      await refresh()
      setNotice(action.kind==='attach'?'監護人已關聯。':action.kind==='handoff'?'主要聯絡人已交接，原聯絡人仍保留關聯。':'關係已解除，歷史已保留。')
    }catch(error){failure(error)}finally{locked.current=false;setBusy(false)}
  }
  async function reload(){if(locked.current)return;locked.current=true;setBusy(true);try{await refresh();attempt.current=null;setNotice('已載入最新資料。')}catch(error){failure(error)}finally{locked.current=false;setBusy(false)}}
  if(state==='loading')return <p role="status">正在載入監護人關係…</p>
  if(state==='denied')return <section className="workspace-section"><h2>無法存取此學生的監護人關係</h2><Link href="/students">返回學生列表</Link></section>
  if(state==='error'||!view)return <section className="workspace-section"><p role="alert">監護人資料暫時無法載入。</p><button type="button" disabled={busy} onClick={()=>void reload()}>重新載入</button></section>
  const primary=view.relationships.find(row=>row.is_primary_contact)
  return <div className="max-w-5xl mx-auto space-y-6">
    <header><Link href={`/students/${studentId}`} className="quiet-link">← 返回學生</Link><h2 className="page-title mt-3">監護人關係</h2><p className="page-subtitle">{view.student.display_name} · 既有歷史會保留，也不會刪除任何監護人。</p></header>
    {notice?<p role="status" className="inline-callout">{notice}</p>:null}
    <button type="button" className="secondary-button" disabled={busy} onClick={()=>void reload()}>重新載入最新資料</button>
    <section className="workspace-section" aria-labelledby="current-relationships-heading"><h3 id="current-relationships-heading" className="section-title">目前關係</h3><div className="space-y-3 mt-4">{view.relationships.map(row=><article className="selection-card flex-col items-stretch" key={row.relationship_id}>
      <strong>{row.guardian.display_name}</strong><span>{labels[row.relationship_type]} · {row.is_primary_contact?'主要聯絡人':'關聯監護人'}</span><small>{[row.guardian.email_hint,row.guardian.phone_hint].filter(Boolean).join(' · ')||'未提供聯絡方式'}</small>
      {canManage&&!row.is_primary_contact?<><button type="button" className="secondary-button" disabled={busy} onClick={()=>setEndTarget(row.relationship_id)}>解除與 {row.guardian.display_name} 的關係</button>{endTarget===row.relationship_id?<div><p>確認解除此關係？歷史仍會保留。</p><button type="button" className="primary-button" disabled={busy} onClick={()=>void mutate({kind:'end',relationshipId:row.relationship_id,version:row.record_version})}>確認解除</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>setEndTarget('')}>取消解除</button></div>:null}</>:null}
    </article>)}</div></section>
    {canManage?<><NewGuardianRelationshipForm studentId={studentId} busy={busy} relationshipLabels={labels}
      onBusy={value=>{locked.current=value;setBusy(value)}} onDenied={failure}
      onCreated={async()=>{await refresh();setNotice('新監護人已建立並關聯，主要聯絡人未變更。')}}/>
    <section className="workspace-section" aria-labelledby="attach-guardian-heading"><h3 id="attach-guardian-heading" className="section-title">關聯已有監護人</h3><p className="section-detail">搜尋後由你選擇；系統不會自動匹配。</p>
      <form className="grid gap-3 mt-4" onSubmit={search}><label className="field-label">搜尋姓名、電郵或電話<input value={query} onChange={event=>{setQuery(event.target.value);setCandidates([]);setSelected('');setSearched(false)}} minLength={2} maxLength={100} required disabled={busy}/></label><button className="secondary-button" disabled={busy} type="submit">搜尋監護人</button></form>
      {searched&&candidates.length===0?<p role="status">未找到可關聯的監護人。</p>:null}
      <form className="grid gap-3 mt-4" onSubmit={event=>{event.preventDefault();void mutate({kind:'attach',guardianId:selected,relationshipType,description,legal,emergency,billing,consent})}}><fieldset disabled={busy} className="grid gap-3">
        {candidates.map(candidate=><label key={candidate.id} className="flex items-start gap-3 border rounded-lg p-4 cursor-pointer"><input type="radio" name="guardian-candidate" value={candidate.id} checked={selected===candidate.id} onChange={()=>setSelected(candidate.id)}/><span>{candidate.display_name}<small>{[candidate.email_hint,candidate.phone_hint].filter(Boolean).join(' · ')}</small></span></label>)}
        <label className="field-label">關係類型<select aria-label="關係類型" value={relationshipType} onChange={event=>setRelationshipType(event.target.value as RelationshipType)}>{RELATIONSHIP_TYPES.map(type=><option key={type} value={type}>{labels[type]}</option>)}</select></label>
        {relationshipType==='other'?<label className="field-label">關係說明<input value={description} onChange={event=>setDescription(event.target.value)} required maxLength={200}/></label>:null}
        <label><input type="checkbox" checked={legal} onChange={event=>setLegal(event.target.checked)}/> 法定監護人</label><label><input type="checkbox" checked={emergency} onChange={event=>setEmergency(event.target.checked)}/> 緊急聯絡人</label><label><input type="checkbox" checked={billing} onChange={event=>setBilling(event.target.checked)}/> 帳單聯絡人</label><label><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/> 同意接收通知</label>
        <button type="submit" className="primary-button" disabled={!selected||busy}>確認關聯</button>
      </fieldset></form></section>
      <section className="workspace-section" aria-labelledby="handoff-primary-heading"><h3 id="handoff-primary-heading" className="section-title">交接主要聯絡人</h3><p className="section-detail">從目前關聯的監護人中選擇；原主要聯絡人會繼續保留關聯。</p><form className="grid gap-3 mt-4" onSubmit={event=>{event.preventDefault();if(primary&&confirmed)void mutate({kind:'handoff',guardianId:successor,version:primary.record_version})}}><fieldset disabled={busy} className="grid gap-3"><label className="field-label">新主要聯絡人<select aria-label="新主要聯絡人" required value={successor} onChange={event=>{setSuccessor(event.target.value);setConfirmed(false)}}><option value="">請選擇</option>{view.relationships.filter(row=>!row.is_primary_contact).map(row=><option key={row.guardian.id} value={row.guardian.id}>{row.guardian.display_name}</option>)}</select></label><label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/> 我確認交接主要聯絡人。</label><button className="primary-button" type="submit" disabled={busy||!primary||!successor||!confirmed}>確認交接</button></fieldset></form></section></>:<p>目前只可查看關係資料。</p>}
  </div>
}
