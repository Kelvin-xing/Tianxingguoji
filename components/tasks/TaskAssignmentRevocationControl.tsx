"use client";

import { useRef,useState,type FormEvent } from "react";
import { TaskIdempotencyAttempt,classifyTaskFailure,getTask,revokeCompletedAssignment,
  type TaskDetailResult,type CaseWorkspaceTask } from "@/modules/tasks/client";

export function TaskAssignmentRevocationControl({task,onUpdate}:{
  readonly task:CaseWorkspaceTask;readonly onUpdate:(result:TaskDetailResult)=>void;
}) {
  const attempt=useRef<TaskIdempotencyAttempt|null>(null);
  if (attempt.current===null) attempt.current=new TaskIdempotencyAttempt();
  const submitting=useRef(false);
  const [reason,setReason]=useState("");
  const [confirmed,setConfirmed]=useState(false);
  const [pending,setPending]=useState(false);
  const [notice,setNotice]=useState<string|null>(null);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !confirmed || !reason.trim() || !task.current_assignment) return;
    submitting.current=true;setPending(true);setNotice(null);
    const input={assignment_id:task.current_assignment.id,expected_record_version:task.record_version,reason:reason.trim()};
    const key=attempt.current!.keyFor(JSON.stringify({task_id:task.id,...input}));
    try {
      await revokeCompletedAssignment(task.id,input,key);
      const current=await getTask(task.id);
      attempt.current!.complete();onUpdate(current);
    } catch(error) {
      const failure=classifyTaskFailure(error);
      if (failure==="stale" || failure==="conflict") {
        try {const current=await getTask(task.id);attempt.current!.complete();onUpdate(current);} catch { /* Keep the current result and allow a safe retry. */ }
      }
      setNotice(failure==="forbidden" || failure==="not_found" ? "目前帳戶無法撤銷此指派。"
        : failure==="stale" || failure==="conflict" ? "任務已更新，請重新確認目前指派。" : "結果暫時無法確認，請重試；不會重複撤銷。");
    } finally {submitting.current=false;setPending(false);}
  }
  return <section className="workspace-section space-y-4" aria-labelledby="revoke-assignment-heading">
    <div><h3 id="revoke-assignment-heading" className="section-title">撤銷完成任務的存取權</h3>
      <p className="section-detail">撤銷後，原負責人不能再查看此任務。完成記錄與歷史會保留。</p></div>
    <form onSubmit={submit} className="space-y-4" aria-busy={pending}>
      <label className="field-label">撤銷原因 <span aria-hidden="true">*</span>
        <textarea value={reason} required maxLength={4000} disabled={pending} onChange={(event)=>{
          setReason(event.target.value);setConfirmed(false);setNotice(null);attempt.current!.rotate();
        }}/></label>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={confirmed} disabled={pending}
        onChange={(event)=>{setConfirmed(event.target.checked);attempt.current!.rotate();}}/>
        <span>我確認收回原負責人的任務存取權。</span></label>
      {notice ? <p className="form-error" role="alert">{notice}</p> : null}
      <button className="primary-button" type="submit" disabled={pending || !confirmed || !reason.trim()}>
        {pending ? "正在撤銷" : "撤銷存取權"}</button>
    </form>
  </section>;
}
