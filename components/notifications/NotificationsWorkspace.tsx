'use client'
import {useCallback,useEffect,useState} from 'react'
import {listNotifications,markRead,resolveTarget,type NotificationDto} from './f4-client'
import {EmptyState,ErrorState,LoadingState,StaleState,UnavailableState} from '@/components/states/WorkspaceState'
import {ApiClientError} from '@/lib/api/client'

type State='loading'|'ready'|'empty'|'denied'|'unavailable'|'error'|'stale'
export function NotificationsWorkspace(){
  const [items,setItems]=useState<readonly NotificationDto[]>([])
  const [state,setState]=useState<State>('loading')
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState<string|null>(null)
  const [retry,setRetry]=useState(false)
  const [pending,setPending]=useState<{item:NotificationDto;key:string}|null>(null)
  const denied=useCallback(()=>{setItems([]);setPending(null);setRetry(false);setMessage(null);setState('denied')},[])
  const load=useCallback(()=>{
    setState('loading');setMessage(null)
    void listNotifications().then(value=>{setItems(value);setState(value.length?'ready':'empty')}).catch((error:unknown)=>{
      setItems([])
      if(isDenied(error))denied()
      else setState(error instanceof ApiClientError&&error.code==='SERVICE_UNAVAILABLE'?'unavailable':'error')
    })
  },[denied])
  useEffect(()=>{const task=Promise.resolve().then(load);return()=>{void task.catch(()=>{})}},[load])
  async function read(item:NotificationDto){
    if(busy)return
    const command=pending??{item,key:crypto.randomUUID()}
    if(!pending)setPending(command)
    setBusy(true);setMessage(null)
    try{
      const receipt=await markRead(command.item.id,command.item.record_version,command.key)
      setItems(current=>current.map(value=>value.id===receipt.id?{...value,status:'read',record_version:receipt.record_version,allowed_actions:value.allowed_actions.filter(action=>action!=='read')}:value))
      setPending(null);setRetry(false)
    }catch(error){
      if(isDenied(error))denied()
      else if(error instanceof ApiClientError&&['STALE_VERSION','CONFLICT','NOT_FOUND'].includes(error.code)){
        setPending(null);setRetry(false);setState('stale')
      }else{setRetry(true);setMessage('暫時無法確認已讀結果，請重試原操作。')}
    }finally{setBusy(false)}
  }
  async function open(item:NotificationDto){
    if(busy)return
    setBusy(true);setMessage(null)
    try{window.location.assign(await resolveTarget(item.id))}
    catch(error){if(isDenied(error))denied();else setMessage('目前無法開啟待辦工作區，請稍後重試。')}
    finally{setBusy(false)}
  }
  if(state==='loading')return <LoadingState title="正在載入通知" />
  if(state==='empty')return <EmptyState title="目前沒有通知" detail="新的提醒會顯示在這裡。" />
  if(state==='denied')return <ErrorState title="無法查看通知" detail="目前帳號沒有查看通知的權限，請重新登入。" />
  if(state==='unavailable')return <UnavailableState title="通知服務暫時不可用" detail="請稍後重試。" onRetry={load} />
  if(state==='stale')return <StaleState title="通知資料已更新" detail="請重新載入後再標記已讀。" onRetry={load} />
  if(state==='error')return <ErrorState title="通知讀取失敗" onRetry={load} />
  return <section className="workspace-section space-y-3" aria-label="站內通知">
    {message&&<p role="alert" className="form-error">{message}</p>}
    {retry&&pending&&<button className="secondary-button" disabled={busy} onClick={()=>void read(pending.item)}>重試已讀操作</button>}
    {items.map(item=><article key={item.id} className={`selection-card flex-wrap justify-between ${item.status==='unread'?'selected':''}`}>
      <span className="min-w-0"><strong>有待處理事項</strong><small>{item.created_at}</small><span className="text-xs">{item.status==='read'?'已讀':'未讀'}</span></span>
      <span className="flex flex-wrap gap-2">
        {item.allowed_actions.includes('resolve_target')&&<button className="secondary-button" disabled={busy||retry} onClick={()=>void open(item)}>開啟</button>}
        {item.status==='unread'&&item.allowed_actions.includes('read')&&<button className="secondary-button" disabled={busy||retry} onClick={()=>void read(item)}>標記為已讀</button>}
      </span>
    </article>)}
  </section>
}
function isDenied(error:unknown):boolean{return error instanceof ApiClientError&&['FORBIDDEN','UNAUTHENTICATED'].includes(error.code)}
