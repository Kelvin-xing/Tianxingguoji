"use client";
import { useEffect,useRef,useState } from "react";
import { getTaskFileLinks,setTaskFileLink,classifyDocumentFailure,type TaskFileLinks,type TaskFileAction } from "@/modules/documents/client";
import { TaskIdempotencyAttempt } from "@/modules/tasks/client";

export function TaskDocumentLinks({taskId,taskVersion,kind}:{taskId:string;taskVersion:number;kind:string}) {
  const [data,setData]=useState<TaskFileLinks|null>(null),[notice,setNotice]=useState<string|null>(null);
  const [hidden,setHidden]=useState(false);
  const [documentId,setDocumentId]=useState(''),[upload,setUpload]=useState(false),[download,setDownload]=useState(false);
  const [reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[pending,setPending]=useState(false);
  const attempt=useRef(new TaskIdempotencyAttempt()),busy=useRef(false);
  useEffect(()=>{const controller=new AbortController();getTaskFileLinks(taskId,controller.signal).then(value=>{
    setData(value);setNotice(null);
  }).catch(error=>{if(!controller.signal.aborted){setData(null);if(classifyDocumentFailure(error)==='forbidden'){setHidden(true);}else setNotice('暫時無法載入任務文件。');}});return()=>controller.abort();},[taskId,taskVersion]);
  async function submit(event:{preventDefault():void},revoke=false,selected=documentId) {
    event.preventDefault();if(busy.current || !data || !confirmed || !reason.trim() || !selected)return;
    busy.current=true;setPending(true);setNotice(null);
    const allowed:TaskFileAction[]=revoke?[]:['document.read',...(upload?['document.upload' as const]:[]),...(download?['document.download' as const]:[])];
    const input={document_id:selected,expected_record_version:data.links.find(link=>link.document_id===selected)?.record_version??0,
      allowed_actions:allowed,reason:reason.trim()};
    try {await setTaskFileLink(taskId,input,attempt.current.keyFor(JSON.stringify({taskId,...input})));
      setData(await getTaskFileLinks(taskId));attempt.current.complete();setConfirmed(false);setReason('');setNotice('文件授權已更新。');
    }catch {setNotice('未能確認更新結果。請重試，或重新載入後確認目前授權。');}
    finally {busy.current=false;setPending(false);}
  }
  if(hidden)return null;
  return <section className="workspace-section space-y-4" aria-labelledby="task-documents-heading">
    <h3 id="task-documents-heading" className="section-title">任務文件</h3>
    {notice?<p role="status" className="section-detail">{notice}</p>:null}
    {!data&&!notice?<p role="status">正在載入文件</p>:null}
    {data?.links.filter(link=>link.allowed_actions.includes('document.read')).map(link=><div key={link.id} className="space-y-1">
      <p className="font-medium break-words">{link.display_name}</p>
      <p className="section-detail">{link.available_version?'已有可用版本':'尚無掃描通過的版本'}</p>
    </div>)}
    {data && !data.links.some(link=>link.allowed_actions.includes('document.read'))?<p className="section-detail">此任務尚未獲授權使用文件。</p>:null}
    {data?.can_manage?<form className="space-y-4" onSubmit={event=>void submit(event)} aria-busy={pending}>
      <label className="field-label">關聯文件<select id={`task-file-choice-${taskId}`} value={documentId} disabled={pending} required onChange={event=>{
        const id=event.target.value,link=data.links.find(item=>item.document_id===id);setDocumentId(id);setConfirmed(false);
        setUpload(link?.configured_actions?.includes('document.upload')??false);setDownload(link?.configured_actions?.includes('document.download')??false);
      }}><option value="">請選擇文件</option>{(data.can_grant?data.document_options:data.links.filter(link=>link.configured_actions?.length).map(link=>({id:link.document_id,display_name:link.display_name}))).map(option=><option key={option.id} value={option.id}>{option.display_name}</option>)}</select></label>
      {data.can_grant?<div className="space-y-2"><p className="section-detail">關聯後可查看此文件的名稱和狀態。其他操作需明確授權。</p>
        <label className="flex gap-2"><input type="checkbox" checked={upload} disabled={pending} onChange={e=>{setUpload(e.target.checked);setConfirmed(false);}}/>允許上傳新版本</label>
        {kind!=='interview_support'?<label className="flex gap-2"><input type="checkbox" checked={download} disabled={pending} onChange={e=>{setDownload(e.target.checked);setConfirmed(false);}}/>允許下載掃描通過的版本</label>:null}
      </div>:null}
      <label className="field-label">文件授權原因<textarea required maxLength={4000} disabled={pending} value={reason} onChange={e=>{setReason(e.target.value);setConfirmed(false);}}/></label>
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={pending} onChange={e=>setConfirmed(e.target.checked)}/>我確認此任務的文件授權。</label>
      <div className="flex flex-wrap gap-3">{data.can_grant?<button className="primary-button" disabled={pending||!confirmed||!documentId||!reason.trim()}>儲存文件授權</button>:null}
      <button type="button" className="secondary-button" disabled={pending||!confirmed||!reason.trim()||!data.links.some(link=>link.document_id===documentId&&link.configured_actions?.length)}
        onClick={event=>void submit(event,true)}>撤銷文件授權</button></div>
    </form>:null}
  </section>;
}
