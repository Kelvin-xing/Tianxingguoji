"use client";
import { useEffect,useState,useRef,type FormEvent } from "react";
import Link from "next/link";
import { getSchoolTargets,recordInterviewInvitation,type SchoolTargetsView,type InterviewInvitationInput } from "@/modules/cases/client";
import { listCaseDocuments,type DocumentListItem } from "@/modules/documents/client";
import { ApiClientError } from "@/lib/api/client";

export function InterviewInvitationsPanel({caseId}:{readonly caseId:string}) {
  const [view,setView]=useState<SchoolTargetsView|null>(null),[files,setFiles]=useState<readonly DocumentListItem[]>([]);
  const [notice,setNotice]=useState(""),[loading,setLoading]=useState(true),[pending,setPending]=useState(false);
  const [targetId,setTargetId]=useState(""),[time,setTime]=useState(""),[documentId,setDocumentId]=useState(""),[confirmed,setConfirmed]=useState(false);
  const [method,setMethod]=useState(""),[language,setLanguage]=useState(""),[requirements,setRequirements]=useState(""),[background,setBackground]=useState("");
  const [retrying,setRetrying]=useState(false);
  const attempt=useRef<{targetId:string;input:InterviewInvitationInput;key:string}|null>(null);
  const busy=useRef(false);
  useEffect(()=>{
    const controller=new AbortController();
    Promise.all([getSchoolTargets(caseId,controller.signal),listCaseDocuments(caseId,controller.signal)]).then(([targets,documents])=>{
      if(controller.signal.aborted)return;
      setView(targets);setFiles(documents.documents.filter(file=>file.lifecycle_state==='active'&&file.has_active_version));
    }).catch(()=>{if(!controller.signal.aborted)setNotice("暫時無法載入面試資料，請重新載入頁面。");})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[caseId]);
  function changed(){setRetrying(false);attempt.current=null;setConfirmed(false);setNotice("");}
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy.current||!confirmed||!view)return;
    const target=view.items.find(item=>item.target_id===targetId);
    if(!target)return;
    if(!attempt.current){
      const date=new Date(`${time}:00+08:00`);
      if(!Number.isFinite(date.getTime())){setNotice("請填寫有效的香港面試時間。");return;}
      attempt.current={targetId,input:{expected_record_version:target.record_version,interview_at:date.toISOString(),invitation_document_id:documentId,interview_method:method.trim(),interview_language:language.trim(),coaching_requirements:requirements.trim(),background_summary:background.trim()},key:crypto.randomUUID()};
    }
    busy.current=true;setPending(true);setNotice("");
    try{
      const command=attempt.current;
      const result=await recordInterviewInvitation(caseId,command.targetId,command.input,command.key);
      if(result.interview_task==='pending'){
        setRetrying(true);setNotice("邀請已儲存，面試任務尚未建立。請按重試完成任務建立。");return;
      }
      setView(await getSchoolTargets(caseId));setRetrying(false);attempt.current=null;setTargetId("");setTime("");setDocumentId("");setConfirmed(false);
      setNotice("面試邀請及支援任務已建立，可前往任務頁面指派負責人。");
    }catch(error){
      if(error instanceof ApiClientError&&['STALE_VERSION','FORBIDDEN','NOT_FOUND','VALIDATION_FAILED','CONFLICT'].includes(error.code)){
        attempt.current=null;setConfirmed(false);
        setNotice(error.code==='STALE_VERSION'?"資料已有更新，請重新載入頁面。":error.code==='VALIDATION_FAILED'?"請檢查面試時間及有效邀請憑證。":"目前權限或案件狀態不允許此操作，請重新載入頁面。");
      }else setNotice("暫時無法確認結果，請重試；相同內容不會重複建立。");
    }finally{busy.current=false;setPending(false);}
  }
  if(loading)return <p role="status">正在載入面試資料。</p>;
  return <section className="workspace-section space-y-5">
    <p className="section-detail">只在學校明確要求面試時登記。面試任務完成不代表學校錄取結果。</p>
    {notice?<p role="status" className="inline-callout">{notice}</p>:null}
    {view?.items.filter(item=>item.state==='interview').map(item=><div className="selection-card" key={item.target_id}><strong>{item.school_name}</strong><span>已登記面試</span></div>)}
    {view?.can_record_interview&&view.items.some(item=>item.state==='submitted')?<form onSubmit={submit} className="space-y-4" aria-busy={pending}>
      <label className="field-label">學校<select aria-label="學校" required disabled={pending} value={targetId} onChange={e=>{changed();setTargetId(e.target.value);}}>
        <option value="">選擇已提交申請的學校</option>{view.items.filter(item=>item.state==='submitted').map(item=><option key={item.target_id} value={item.target_id}>{item.school_name}</option>)}
      </select></label>
      <label className="field-label">面試時間（香港時間）<input required disabled={pending} type="datetime-local" value={time} onChange={e=>{changed();setTime(e.target.value);}}/></label>
      <p className="section-detail">以下內容會顯示給任務負責人。只填執行所需背景，勿加入聯絡方式或整份評估。</p>
      <label className="field-label">面試方式<input required maxLength={200} disabled={pending} value={method} onChange={e=>{changed();setMethod(e.target.value);}}/></label>
      <label className="field-label">面試語言<input required maxLength={200} disabled={pending} value={language} onChange={e=>{changed();setLanguage(e.target.value);}}/></label>
      <label className="field-label">輔導要求<textarea required maxLength={1500} rows={3} disabled={pending} value={requirements} onChange={e=>{changed();setRequirements(e.target.value);}}/></label>
      <label className="field-label">必要背景摘要<textarea required maxLength={1500} rows={3} disabled={pending} value={background} onChange={e=>{changed();setBackground(e.target.value);}}/></label>
      <label className="field-label">邀請憑證<select aria-label="邀請憑證" required disabled={pending} value={documentId} onChange={e=>{changed();setDocumentId(e.target.value);}}>
        <option value="">選擇已掃描通過的文件</option>{files.map(file=><option value={file.id} key={file.id}>{file.display_name}</option>)}
      </select></label>
      {!files.length?<p>請先在<Link className="quiet-link" href={`/cases/${caseId}/documents`}>案件文件</Link>上傳邀請並等待掃描通過。</p>:null}
      <label className="flex gap-2"><input type="checkbox" required disabled={pending} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我確認學校要求面試，並建立支援任務。</label>
      <button type="submit" className="primary-button" disabled={pending}>{pending?'正在儲存':retrying?'重試建立任務':'儲存面試邀請'}</button>
    </form>:view?<p>目前沒有可登記面試的已提交申請，或案件處於唯讀狀態。</p>:null}
    <Link className="secondary-button" href={`/cases/${caseId}`}>返回案件</Link>
    <Link className="secondary-button" href="/tasks">查看任務</Link>
  </section>;
}
