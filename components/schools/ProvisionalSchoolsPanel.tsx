'use client'

import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import {getWorkspaceAccessSnapshot} from '@/modules/access/client'
import {createProvisionalSchoolRecord,listProvisionalSchools,provisionalAccessDenied,provisionalValidationFailure,type ProvisionalSchool} from '@/modules/schools/client'

type Attempt={key:string;body:{school_name_zh:string|null;school_name_en:string|null}}
export function ProvisionalSchoolsPanel({onAccessDenied}:{onAccessDenied:()=>void}){
  const [items,setItems]=useState<readonly ProvisionalSchool[]>([])
  const [loading,setLoading]=useState(true)
  const [canCreate,setCanCreate]=useState(false)
  const [loadError,setLoadError]=useState(false)
  const [nameZh,setNameZh]=useState('')
  const [nameEn,setNameEn]=useState('')
  const [saving,setSaving]=useState(false)
  const [pending,setPending]=useState(false)
  const [notice,setNotice]=useState('')
  const attempt=useRef<Attempt|null>(null)
  const inFlight=useRef(false)
  const mounted=useRef(false)
  const controller=useRef<AbortController|null>(null)
  const deny=useCallback(()=>{setItems([]);setCanCreate(false);onAccessDenied()},[onAccessDenied])
  const load=useCallback(async()=>{
    controller.current?.abort()
    const current=new AbortController();controller.current=current
    setLoading(true);setLoadError(false)
    try{
      const [rows,access]=await Promise.all([listProvisionalSchools(current.signal),getWorkspaceAccessSnapshot(current.signal)])
      if(!mounted.current||current.signal.aborted)return
      if(!access.capabilities.includes('schools.read')){deny();return}
      setItems(rows);setCanCreate(access.capabilities.includes('schools.provisional.create'))
    }catch(error){
      if(!mounted.current||current.signal.aborted)return
      setItems([]);setCanCreate(false)
      if(provisionalAccessDenied(error))deny();else setLoadError(true)
    }finally{if(mounted.current&&!current.signal.aborted)setLoading(false)}
  },[deny])
  useEffect(()=>{mounted.current=true;queueMicrotask(()=>{if(mounted.current)void load()});return()=>{mounted.current=false;controller.current?.abort()}},[load])
  async function submit(event:FormEvent){
    event.preventDefault()
    if(inFlight.current||!canCreate)return
    if(!attempt.current){
      if(!nameZh.trim()&&!nameEn.trim()){setNotice('請至少填寫中文或英文名稱。');return}
      attempt.current={key:crypto.randomUUID(),body:{school_name_zh:nameZh.trim()||null,school_name_en:nameEn.trim()||null}}
    }
    inFlight.current=true;setSaving(true);setNotice('')
    try{
      await createProvisionalSchoolRecord(attempt.current.body,attempt.current.key)
      if(!mounted.current)return
      attempt.current=null;setPending(false);setNameZh('');setNameEn('');setNotice('學校已建立，標記為未驗證。')
      await load()
    }catch(error){
      if(!mounted.current)return
      if(provisionalAccessDenied(error)){deny();return}
      if(provisionalValidationFailure(error)){attempt.current=null;setPending(false);setNotice('名稱格式不正確，請檢查後重新提交。')}
      else{setPending(true);setNotice('尚未確認保存結果。請重試原提交，避免重複建檔。')}
    }finally{inFlight.current=false;if(mounted.current)setSaving(false)}
  }
  return <section aria-labelledby="provisional-heading" className="space-y-3 rounded-lg border p-4" style={{borderColor:'var(--border)',background:'var(--surface)'}}>
    <h2 id="provisional-heading" className="font-semibold">未驗證學校</h2>
    <p className="text-sm" style={{color:'var(--text-secondary)'}}>學校不在目錄時，可先填寫名稱建檔。未填寫的資料保持未知。</p>
    {loading?<p role="status">正在載入未驗證學校…</p>:loadError?<div role="alert">未驗證學校暫時無法載入。<button type="button" onClick={()=>void load()}>重試載入</button></div>:<>
      {canCreate&&<form onSubmit={submit} className="space-y-3" aria-label="建立未驗證學校">
        <fieldset disabled={saving||pending} className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">中文名稱<input type="text" className="mt-1 block w-full min-w-0 rounded border px-3 py-2" style={{borderColor:'var(--border)',background:'var(--bg)'}} value={nameZh} onChange={e=>setNameZh(e.target.value)} maxLength={512}/></label>
          <label className="block text-sm">英文名稱<input type="text" className="mt-1 block w-full min-w-0 rounded border px-3 py-2" style={{borderColor:'var(--border)',background:'var(--bg)'}} value={nameEn} onChange={e=>setNameEn(e.target.value)} maxLength={512}/></label>
        </fieldset>
        <button type="submit" disabled={saving} className="rounded border px-3 py-2 text-sm">{saving?'正在保存…':pending?'重試原提交':'建立未驗證學校'}</button>
      </form>}
      {items.length===0?<p className="text-sm">尚無未驗證學校。</p>:<ul className="space-y-2" aria-label="未驗證學校清單">{items.map(item=><li key={item.school_id} className="rounded border p-3 text-sm break-words" style={{borderColor:'var(--border)'}}>
        <span className="font-medium">{item.school_name_zh||item.school_name_en}</span><span className="ml-2">未驗證</span>
        {item.school_name_zh&&item.school_name_en&&<p>{item.school_name_en}</p>}
        <p style={{color:'var(--text-muted)'}}>地區：{item.district||'未知'} · 學段：{item.stage||'未知'}</p>
      </li>)}</ul>}
    </>}
    {notice&&<p role="status" className="text-sm">{notice}</p>}
  </section>
}
