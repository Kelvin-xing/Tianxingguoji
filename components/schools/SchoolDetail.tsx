'use client'

import Link from 'next/link'
import { useCallback,useEffect, useRef,useState, type ReactNode } from 'react'
import { getResolvedSchool,listSchoolChanges, type SchoolChangeHistoryItem,type SchoolDirectoryItem } from '@/modules/schools/client'

function value(input: unknown): string { return typeof input === 'string' && input.trim() ? input.trim() : '未知' }
function Block({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-labelledby={`${title}-heading`} className="space-y-3 rounded-lg border p-4" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}><h2 id={`${title}-heading`} className="font-semibold">{title}</h2>{children}</section>
}
function Field({ label, input }: { label: string; input: unknown }) { return <div className="min-w-0"><dt className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</dt><dd className="break-words">{value(input)}</dd></div> }

export function SchoolDetail({ schoolId }: { schoolId: string }) {
  const [school, setSchool] = useState<Omit<SchoolDirectoryItem, "source_school_key"> | null>(null)
  const [changes,setChanges]=useState<readonly SchoolChangeHistoryItem[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'denied'|'missing'>('loading')
  const mounted=useRef(false)
  const controller=useRef<AbortController|null>(null)
  const load=useCallback(async()=>{
    controller.current?.abort()
    const current=new AbortController();controller.current=current
    setState('loading');setSchool(null);setChanges([])
    try{
      const [result,history]=await Promise.all([getResolvedSchool(schoolId,current.signal),listSchoolChanges(schoolId,current.signal)])
      if(!mounted.current||current.signal.aborted)return
      setSchool(result);setChanges(history);setState('ready')
    }catch(error){
      if(!mounted.current||current.signal.aborted)return
      const status=error&&typeof error==='object'&&'status' in error?error.status:null
      setSchool(null);setChanges([]);setState(status===401||status===403?'denied':status===404?'missing':'error')
    }
  },[schoolId])
  useEffect(()=>{mounted.current=true;queueMicrotask(()=>{if(mounted.current)void load()});return()=>{mounted.current=false;controller.current?.abort()}},[load])
  if (state === 'loading') return <p role="status">正在載入學校資料…</p>
  if (state === 'denied') return <p role="alert">登入狀態或學校存取權限已變更，請重新登入或聯絡管理員。</p>
  if(state==='missing')return <p role="alert">找不到這所學校。<Link href="/schools">返回學校目錄</Link></p>
  if (state === 'error' || !school) return <div role="alert">學校資料暫時無法載入。<button type="button" onClick={()=>void load()}>重新載入學校資料</button></div>
  const fields = school.fields
  return <div className="max-w-5xl space-y-4"><Link href="/schools" className="text-sm underline">返回學校目錄</Link><header><h1 className="text-xl font-semibold">{value(fields.school_name_zh) !== '未知' ? value(fields.school_name_zh) : value(fields.school_name_en)}</h1><p className="text-sm" style={{ color: 'var(--text-muted)' }}>未取得的資料顯示為未知。</p><button type="button" onClick={()=>void load()} className="mt-2 rounded border px-3 py-2 text-sm">重新載入學校資料</button></header>
    <Block title="基礎資料"><dl className="grid gap-3 sm:grid-cols-2"><Field label="中文名稱" input={fields.school_name_zh}/><Field label="英文名稱" input={fields.school_name_en}/><Field label="地區" input={fields.district}/><Field label="地址" input={fields.address}/><Field label="官网" input={fields.official_website || fields.website}/><Field label="電話" input={fields.phone}/></dl></Block>
    <Block title="招生資料"><dl className="grid gap-3 sm:grid-cols-2"><Field label="招生類型" input={fields.admission_type}/><Field label="適用學年" input={fields.admission_school_year || fields.school_year}/><Field label="招生年級" input={fields.admission_grade}/><Field label="申請方式" input={fields.application_method}/><Field label="申請開始日期" input={fields.application_start_date}/><Field label="截止日期" input={fields.application_deadline || fields.submission_deadline}/></dl></Block>
    <Block title="待處理更新"><ChangeList items={changes.filter(item=>item.status==='candidate')} empty="目前沒有待審批的人工資料變更。"/></Block>
    <Block title="更新履歷"><p className="text-sm" style={{color:'var(--text-secondary)'}}>人工資料變更紀錄。原始快照值用於核對來源，不代表最近一次生效值。</p><ChangeList items={changes.filter(item=>item.status!=='candidate')} empty="目前沒有已處理的人工變更紀錄。"/></Block>
  </div>
}

const STATUS={candidate:'待審批',approved:'已批准',rejected:'已拒絕',disabled:'已停用'} as const
const FIELD_NAMES:Readonly<Record<string,string>>={phone:'電話',district:'地區',address:'地址',school_name_zh:'中文名稱',school_name_en:'英文名稱',official_website:'官網'}
function changeValue(input:unknown):string{if(input===null||input==='')return '未知';return typeof input==='string'?input:JSON.stringify(input)}
function ChangeList({items,empty}:{items:readonly SchoolChangeHistoryItem[];empty:string}){
  if(!items.length)return <p className="text-sm">{empty}</p>
  return <ul className="space-y-3">{items.map(item=><li key={item.change_request_id} className="rounded border p-3 space-y-2 text-sm break-words" style={{borderColor:'var(--border)'}}>
    <p className="font-medium">人工變更 #{item.revision_number} · {STATUS[item.status]}</p>
    <p>提交時間：{new Date(item.submitted_at).toLocaleString('zh-TW')}</p>
    <p>理由：{item.reason}</p>
    {item.fields.map(field=><dl key={field.field_name} className="space-y-2"><div><dt className="font-medium">{FIELD_NAMES[field.field_name]??field.field_name}</dt><dd>原始快照值：{changeValue(field.snapshot_value)}</dd><dd>申請值：{changeValue(field.proposed_value)}</dd></div><div><dt>證據摘要</dt><dd>{field.quote}</dd><dd className="break-all">{field.source_url}</dd></div></dl>)}
    {item.approved_at&&<p>批准時間：{new Date(item.approved_at).toLocaleString('zh-TW')}</p>}
    {item.disabled_at&&<p>停用時間：{new Date(item.disabled_at).toLocaleString('zh-TW')} · {item.disable_reason}</p>}
  </li>)}</ul>
}
