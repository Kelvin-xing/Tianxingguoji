"use client";
import {useEffect,useRef,useState} from "react";
import {abandonTaskDocumentVersion,createTaskDocumentVersion,digestDocumentUploadFile,fetchDocumentBytes,getTaskFileLinks,
  issueTaskDocumentDownloadIntent,issueTaskDocumentUploadIntent,putDocumentBytes,type TaskFileLink} from "@/modules/documents/client";
import {TaskIdempotencyAttempt} from "@/modules/tasks/client";

export function TaskDocumentTransferControls({taskId,link,onRefresh}:{taskId:string;link:TaskFileLink;onRefresh:()=>Promise<void>}) {
  const [file,setFile]=useState<File|null>(null),[pending,setPending]=useState(false),[notice,setNotice]=useState<string|null>(null);
  const busy=useRef(false),alive=useRef(true),attempt=useRef(new TaskIdempotencyAttempt());
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function current(){const data=await getTaskFileLinks(taskId);const current=data.links.find(row=>row.document_id===link.document_id);if(!current)throw new Error('File access ended');return current;}
  async function act(operation:'upload'|'download'|'abandon') {
    if(busy.current)return;busy.current=true;setPending(true);setNotice(null);
    try {
      const fresh=await current();
      if(operation==='upload'){
        if(!file||!fresh.allowed_actions.includes('document.upload'))throw new Error('Upload unavailable');
        const digest=await digestDocumentUploadFile(file);
        const input={checksum_sha256:digest.checksum_sha256,size_bytes:digest.size_bytes,content_type:digest.content_type,
          expected_document_record_version:fresh.document_record_version};
        const version=fresh.pending_upload??await createTaskDocumentVersion(taskId,link.document_id,input,
          attempt.current.keyFor(JSON.stringify({taskId,documentId:link.document_id,...input})));
        const intent=await issueTaskDocumentUploadIntent(taskId,link.document_id,version.id,version.record_version,digest);
        await putDocumentBytes(intent,file);attempt.current.complete();
        const started=Date.now();
        while(alive.current){
          const updated=await current();await onRefresh();
          if(updated.latest_version_state==='available'){setNotice('文件已上傳並通過檢查。');break;}
          if(['rejected','scan_failed'].includes(updated.latest_version_state??'')){setNotice('文件未通過檢查，請確認文件後重新上傳。');break;}
          if(Date.now()-started>=90_000){setNotice('文件已上傳，檢查仍在進行。請稍後重新整理。');break;}
          await new Promise(resolve=>setTimeout(resolve,1000));
        }
      }else if(operation==='abandon'){
        if(!fresh.pending_upload||!fresh.allowed_actions.includes('document.upload'))throw new Error('No pending upload');
        const input={expected_document_record_version:fresh.document_record_version,expected_version_record_version:fresh.pending_upload.record_version};
        await abandonTaskDocumentVersion(taskId,link.document_id,fresh.pending_upload.id,input,
          attempt.current.keyFor(JSON.stringify({operation,taskId,documentId:link.document_id,...input})));
        attempt.current.complete();setNotice('未完成的上傳已放棄。');
      }else{
        if(!fresh.allowed_actions.includes('document.download'))throw new Error('Download unavailable');
        const intent=await issueTaskDocumentDownloadIntent(taskId,link.document_id),blob=await fetchDocumentBytes(intent);
        const url=URL.createObjectURL(blob);
        try{const anchor=document.createElement('a');anchor.href=url;anchor.download=intent.download_name;anchor.hidden=true;
          document.body.append(anchor);anchor.click();anchor.remove();}finally{URL.revokeObjectURL(url);}
        setNotice('已下載文件。');
      }
      if(alive.current)await onRefresh();
    }catch{
      if(alive.current){setNotice('未能完成操作。請重新整理確認授權及上傳狀態後重試。');await onRefresh().catch(()=>undefined);}
    }finally{busy.current=false;if(alive.current)setPending(false);}
  }
  return <div className="space-y-3" aria-busy={pending}>
    {link.allowed_actions.includes('document.upload')?<div className="space-y-2">
      <label className="field-label">上傳 {link.display_name}<input type="file" accept="application/pdf,image/jpeg,image/png" disabled={pending}
        onChange={event=>{setFile(event.target.files?.[0]??null);setNotice(null);attempt.current.rotate();}}/></label>
      <p className="section-detail">支援 PDF、JPG、PNG，最大 10 MB。新版本通過檢查後才可使用。</p>
      <button type="button" className="primary-button" disabled={pending||!file} onClick={()=>void act('upload')}>{pending?'正在處理':'上傳文件'}</button>
      {link.pending_upload?<button type="button" className="secondary-button" disabled={pending} onClick={()=>void act('abandon')}>放棄未完成上傳</button>:null}
    </div>:null}
    {link.allowed_actions.includes('document.download')?<button type="button" className="secondary-button" disabled={pending} onClick={()=>void act('download')}>下載文件</button>:null}
    {notice?<p role="status" className="section-detail">{notice}</p>:null}
  </div>;
}
